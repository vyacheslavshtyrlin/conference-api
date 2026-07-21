import { HttpException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  CreateIntegrationAdmissionResponse,
  CreateIntegrationRoomResponse,
  ExchangeAdmissionResponse,
} from "#contracts";
import { EMPTY_ROOM_TTL_SECONDS } from "#contracts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ApiConfig } from "../config/api-config.js";
import { getApiMetrics } from "../observability/api-metrics.service.js";
import { IntegrationRoomConflictError, RoomRepository } from "../rooms/room.repository.js";
import { RoomTokenService } from "../rooms/room-token.service.js";
import { invalidToken, roomClosed } from "../rooms/room-errors.js";
import { integrationConflict, integrationForbidden, invalidPayload } from "./integration-auth.errors.js";
import type { CreateIntegrationAdmissionDto } from "./dto/create-admission.dto.js";
import type { CreateIntegrationRoomDto, InitialIntegrationUserDto } from "./dto/create-integration-room.dto.js";
import type { ExchangeAdmissionDto } from "./dto/exchange-admission.dto.js";

export type CreateIntegrationRoomCommand = {
  integrationId: string;
  body: CreateIntegrationRoomDto;
};

export type CreateAdmissionCommand = {
  integrationId: string;
  roomId: string;
  body: CreateIntegrationAdmissionDto;
};

@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(RoomRepository) private readonly rooms: RoomRepository,
    @Inject(RoomTokenService) private readonly tokens: RoomTokenService,
    @Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>
  ) {}

  async createRoom(command: CreateIntegrationRoomCommand): Promise<CreateIntegrationRoomResponse> {
    return this.recordIntegrationControl("integration_create_room", async () => {
      const initialUser = command.body.initialUser ? normalizeInitialUser(command.body.initialUser) : undefined;
      if (command.body.initialUser && !initialUser) {
        throw invalidPayload();
      }

      const createdAt = new Date();
      const accessPolicy = command.body.accessPolicy ?? "approval";
      const expiresAt = new Date(createdAt.getTime() + EMPTY_ROOM_TTL_SECONDS * 1_000).toISOString();
      const mediaNode = this.selectMediaNode();
      const requestHash = stableHash({
        integrationId: command.integrationId,
        externalRoomId: command.body.externalRoomId,
        title: command.body.title ?? null,
        accessPolicy,
        initialUser: initialUser ?? null,
      });

      try {
        const room = await this.rooms.createRoom(
          {
            roomId: `room_${randomUUID()}`,
            slug: this.createSlug(),
            accessPolicy,
            mediaNodeId: mediaNode.mediaNodeId,
            signalingUrl: mediaNode.signalingUrl,
            createdAt: createdAt.toISOString(),
            expiresAt,
          },
          {
            integration: {
              integrationId: command.integrationId,
              externalRoomId: stableHash(command.body.externalRoomId),
              requestHash,
            },
          }
        );

        const response: CreateIntegrationRoomResponse = {
          roomId: room.roomId,
          slug: room.slug,
          mediaNodeId: room.mediaNodeId,
          signalingUrl: room.signalingUrl,
          expiresAt: room.expiresAt,
          status: room.status,
          accessPolicy: room.accessPolicy === "approval" ? room.accessPolicy : "approval",
        };

        if (!initialUser) {
          return response;
        }

        const admission = await this.createAdmissionForOwnedRoom({
          integrationId: command.integrationId,
          room,
          externalSubject: initialUser.id,
          displayName: initialUser.name,
          roomControls: "creator",
          expiresAt: new Date(Date.now() + EMPTY_ROOM_TTL_SECONDS * 1_000).toISOString(),
        });

        return {
          ...response,
          entryUrl: admission.entryUrl,
          entryExpiresAt: admission.expiresAt,
        };
      } catch (error) {
        if (error instanceof IntegrationRoomConflictError) {
          throw integrationConflict("externalRoomId is already mapped to a different integration room request");
        }
        throw error;
      }
    });
  }

  async createAdmission(command: CreateAdmissionCommand): Promise<CreateIntegrationAdmissionResponse> {
    return this.recordIntegrationControl("integration_create_admission", async () => {
      const room = await this.rooms.getRoomById(command.roomId);
      return this.createAdmissionForOwnedRoom({
        integrationId: command.integrationId,
        room,
        externalSubject: command.body.identity.externalSubject,
        displayName: command.body.identity.displayName.trim(),
        avatarUrl: command.body.identity.avatarUrl,
        kind: command.body.identity.kind,
        roomControls: command.body.roomControls,
        expiresAt: command.body.expiresAt,
      });
    });
  }

  async exchangeAdmission(body: ExchangeAdmissionDto): Promise<ExchangeAdmissionResponse> {
    return this.recordIntegrationControl("admission_exchange", async () => {
      const code = body.code.trim();
      if (!code) {
        throw invalidToken("Invalid admission code");
      }

      const participantId = `peer_${randomUUID()}`;
      const roomSessionToken = this.tokens.createRoomSessionToken();
      const createdAt = new Date().toISOString();
      const result = await this.rooms.consumeAdmission({
        codeHash: this.tokens.hashAdmissionCode(code),
        expectedRoomId: body.roomId,
        session: {
          participantId,
          displayName: null,
          isCreator: false,
          tokenHash: this.tokens.hashRoomSessionToken(roomSessionToken),
          createdAt,
        },
        sessionExpiresAt: new Date(Date.now() + EMPTY_ROOM_TTL_SECONDS * 1_000).toISOString(),
      });

      const session = result.session;
      const displayName = session.displayName?.trim() || null;

      return {
        roomId: result.room.roomId,
        slug: result.room.slug,
        participantId: session.participantId,
        roomSessionToken,
        displayName,
        isCreator: session.isCreator,
        mediaNodeId: result.room.mediaNodeId,
        signalingUrl: result.room.signalingUrl,
        expiresAt: result.room.expiresAt,
      };
    });
  }

  private createSlug(): string {
    return randomBytes(5).toString("base64url").toLowerCase().replace(/_/g, "-").slice(0, 7);
  }

  private signalingPublicUrl(): string {
    return this.config.get("SIGNALING_PUBLIC_URL", { infer: true });
  }

  private selectMediaNode(): { mediaNodeId: string; signalingUrl: string } {
    return {
      mediaNodeId: this.config.get("MEDIA_NODE_ID", { infer: true }),
      signalingUrl: this.signalingPublicUrl(),
    };
  }

  private webPublicUrl(): string {
    return this.config.get("WEB_PUBLIC_URL", { infer: true }).replace(/\/$/, "");
  }

  private async createAdmissionForOwnedRoom(input: {
    integrationId: string;
    room: Awaited<ReturnType<RoomRepository["getRoomById"]>>;
    externalSubject: string;
    displayName: string;
    avatarUrl?: string;
    kind?: "guest" | "authenticated";
    roomControls: "creator" | "none";
    expiresAt: string;
  }): Promise<CreateIntegrationAdmissionResponse> {
    if (input.room.status === "closed") {
      throw roomClosed();
    }

    const owner = await this.rooms.getIntegrationRoomOwner(input.room.roomId);
    if (!owner || owner.integrationId !== input.integrationId) {
      throw integrationForbidden();
    }

    const expiresAt = parseFutureIso(input.expiresAt);
    if (!expiresAt) {
      throw invalidPayload();
    }

    const roomDeadline = input.room.expiresAt ? Date.parse(input.room.expiresAt) : undefined;
    const admissionDeadline = roomDeadline ? Math.min(expiresAt.getTime(), roomDeadline) : expiresAt.getTime();
    if (admissionDeadline <= Date.now()) {
      throw invalidPayload();
    }

    const rawCode = this.tokens.createAdmissionCode();
    const codeHash = this.tokens.hashAdmissionCode(rawCode);
    const effectiveExpiresAt = new Date(admissionDeadline).toISOString();

    await this.rooms.createAdmission({
      roomId: input.room.roomId,
      integrationId: input.integrationId,
      codeHash,
      identity: {
        kind: input.kind ?? "authenticated",
        source: "integration_admission",
        externalSubject: input.externalSubject,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
      },
      roomControls: input.roomControls,
      createdAt: new Date().toISOString(),
      expiresAt: effectiveExpiresAt,
    });

    return {
      entryUrl: `${this.webPublicUrl()}/r/${encodeURIComponent(input.room.slug)}#code=${encodeURIComponent(rawCode)}`,
      expiresAt: effectiveExpiresAt,
    };
  }

  private async recordIntegrationControl<T>(
    operation: "integration_create_room" | "integration_create_admission" | "admission_exchange",
    work: () => Promise<T>
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await work();
      getApiMetrics().recordRoomControl({
        operation,
        outcome: "success",
        errorCode: null,
        durationMs: performance.now() - startedAt,
      });
      return result;
    } catch (error) {
      getApiMetrics().recordRoomControl({
        operation,
        outcome: "error",
        errorCode: stableIntegrationErrorCode(error),
        durationMs: performance.now() - startedAt,
      });
      throw error;
    }
  }
}

function parseFutureIso(value: string): Date | undefined {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp) || timestamp <= Date.now()) {
    return undefined;
  }
  return new Date(timestamp);
}

function normalizeInitialUser(value: InitialIntegrationUserDto): { id: string; name: string } | undefined {
  const id = value.id.trim();
  const name = value.name.trim();
  return id && name ? { id, name } : undefined;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("base64url");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableIntegrationErrorCode(error: unknown): string {
  if (!(error instanceof HttpException)) {
    return "INTERNAL_ERROR";
  }
  const response = error.getResponse();
  if (
    typeof response === "object" &&
    response !== null &&
    "code" in response &&
    typeof response.code === "string"
  ) {
    return response.code;
  }
  return error.getStatus() >= 500 ? "DEPENDENCY_UNAVAILABLE" : "CLIENT_REQUEST_ERROR";
}
