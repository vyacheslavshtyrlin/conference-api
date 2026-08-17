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
import { RecordingRepository, RecordingRequestConflictError } from "../recordings/recording.repository.js";
import { RecordingStorageService } from "../recordings/recording-storage.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
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
    @Inject(RecordingRepository)
    private readonly recordings: RecordingRepository,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RecordingStorageService)
    private readonly storage: RecordingStorageService,
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
      const recordingRequested = command.body.recordingRequested ?? false;
      const proposedRecordingId = recordingRequested ? `rec_${randomUUID()}` : undefined;
      const expiresAt = new Date(createdAt.getTime() + EMPTY_ROOM_TTL_SECONDS * 1_000).toISOString();
      const mediaNode = this.selectMediaNode();
      const requestHash = stableHash({
        integrationId: command.integrationId,
        externalRoomId: command.body.externalRoomId,
        title: command.body.title ?? null,
        accessPolicy,
        recordingRequested,
        initialUser: initialUser ?? null,
      });

      const deliveryEnabled = this.config.get("RECORDING_DELIVERY_ENABLED", { infer: true });
      const durableRecording = recordingRequested && deliveryEnabled
        ? await this.recordings.ensureRequested({
            recordingId: proposedRecordingId!,
            integrationId: command.integrationId,
            externalRoomId: command.body.externalRoomId,
            requestFingerprint: requestHash,
            expiresAt: new Date(
              createdAt.getTime() +
                this.config.get("RECORDING_ARTIFACT_RETENTION_DAYS", { infer: true })! * 86_400_000,
            ),
          })
        : undefined;

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
            recordingRequested,
          },
          {
            integration: {
              integrationId: command.integrationId,
              externalRoomId: stableHash(command.body.externalRoomId),
              requestHash,
              recordingId: durableRecording?.recordingId ?? proposedRecordingId,
            },
          }
        );

        if (deliveryEnabled) {
          await this.prisma.integrationRoomHistory.upsert({
            where: { roomId: room.roomId },
            create: {
              roomId: room.roomId,
              integrationId: command.integrationId,
              externalRoomHash: stableHash(command.body.externalRoomId),
              createdAt,
              expiresAt: new Date(createdAt.getTime() + 30 * 86_400_000),
            },
            update: {},
          });
        }
        if (durableRecording) {
          await this.recordings.attachRoom(durableRecording.recordingId, room.roomId);
        }

        const owner = await this.rooms.getIntegrationRoomOwner(room.roomId);

        const response: CreateIntegrationRoomResponse = {
          roomId: room.roomId,
          slug: room.slug,
          mediaNodeId: room.mediaNodeId,
          signalingUrl: room.signalingUrl,
          expiresAt: room.expiresAt,
          status: room.status,
          accessPolicy: room.accessPolicy === "approval" ? room.accessPolicy : "approval",
          recordingId: owner?.recordingId ?? null,
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
        if (error instanceof IntegrationRoomConflictError || error instanceof RecordingRequestConflictError) {
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

  async getRecording(integrationId: string, recordingId: string) {
    const recording = await this.prisma.recording.findFirst({
      where: { id: recordingId, integrationId },
      include: { artifacts: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!recording) throw integrationForbidden();
    const artifact = recording.artifacts[0];
    if (!artifact || recording.state !== "READY") {
      const response = { recordingId: recording.id, status: recording.state === "FAILED" ? "error" : recording.state.toLowerCase(), expiresAt: recording.expiresAt.toISOString(), artifact: null as null };
      return recording.state === "FAILED" ? { ...response, error: { code: recording.failureCode ?? "RECORDING_FAILED", message: recording.failureMessage ?? "Recording failed" } } : response;
    }
    const download = await this.storage.allocateIntegrationGet(artifact.objectKey);
    return { recordingId: recording.id, status: "ready", expiresAt: recording.expiresAt.toISOString(), artifact: { bytes: Number(artifact.bytes), contentType: artifact.contentType, durationSeconds: Number(artifact.durationSeconds), downloadUrl: download.url, downloadUrlExpiresAt: download.expiresAt } };
  }

  async getRoomRecordings(integrationId: string, roomId: string) {
    const recordings = await this.prisma.recording.findMany({
      where: { integrationId, roomId },
      orderBy: { requestedAt: "asc" },
      include: { artifacts: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    return {
      roomId,
      recordings: await Promise.all(
        recordings.map(async (recording) => {
          const artifact = recording.artifacts[0];
          if (!artifact || recording.state !== "READY") {
            const response = {
              recordingId: recording.id,
              status: recording.state === "FAILED" ? "error" : recording.state.toLowerCase(),
              expiresAt: recording.expiresAt.toISOString(),
              artifact: null as null,
            };
            return recording.state === "FAILED"
              ? {
                  ...response,
                  error: {
                    code: recording.failureCode ?? "RECORDING_FAILED",
                    message: recording.failureMessage ?? "Recording failed",
                  },
                }
              : response;
          }
          const download = await this.storage.allocateIntegrationGet(artifact.objectKey);
          return {
            recordingId: recording.id,
            status: "ready",
            expiresAt: recording.expiresAt.toISOString(),
            artifact: {
              bytes: Number(artifact.bytes),
              contentType: artifact.contentType,
              durationSeconds: Number(artifact.durationSeconds),
              downloadUrl: download.url,
              downloadUrlExpiresAt: download.expiresAt,
            },
          };
        }),
      ),
    };
  }
  async getRoomHistory(integrationId: string, roomId: string) {
    const room = await this.prisma.integrationRoomHistory.findFirst({
      where: { roomId, integrationId },
      include: {
        participantSessions: { orderBy: { joinedAt: "asc" } },
        chatMessages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 500 },
      },
    });
    if (!room) throw integrationForbidden();
    const recording = await this.prisma.recording.findFirst({
      where: { roomId, integrationId },
      include: { artifacts: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const artifact = recording?.artifacts[0];
    const recordingResponse = !recording
      ? null
      : !artifact || recording.state !== "READY"
        ? {
            recordingId: recording.id,
            status: recording.state === "FAILED" ? "error" : recording.state.toLowerCase(),
            expiresAt: recording.expiresAt.toISOString(),
            artifact: null as null,
            ...(recording.state === "FAILED"
              ? { error: { code: recording.failureCode ?? "RECORDING_FAILED", message: recording.failureMessage ?? "Recording failed" } }
              : {}),
          }
        : await this.storage.allocateIntegrationGet(artifact.objectKey).then((download) => ({
            recordingId: recording.id,
            status: "ready",
            expiresAt: recording.expiresAt.toISOString(),
            artifact: {
              bytes: Number(artifact.bytes),
              contentType: artifact.contentType,
              durationSeconds: Number(artifact.durationSeconds),
              downloadUrl: download.url,
              downloadUrlExpiresAt: download.expiresAt,
            },
          }));
    return {
      room: {
        roomId: room.roomId,
        createdAt: room.createdAt.toISOString(),
        closedAt: room.closedAt?.toISOString() ?? null,
        closedReason: room.closedReason,
        expiresAt: room.expiresAt.toISOString(),
      },
      recording: recordingResponse,
      participants: room.participantSessions.map((session) => ({
        participantId: session.participantId,
        displayName: session.displayName,
        joinedAt: session.joinedAt.toISOString(),
        leftAt: session.leftAt?.toISOString() ?? null,
      })),
      chat: room.chatMessages.map((message) => ({
        messageId: message.id,
        kind: message.kind,
        participantId: message.participantId,
        authorName: message.authorName,
        text: message.text,
        createdAt: message.createdAt.toISOString(),
      })),
    };
  }
  async retryRecordingCallback(integrationId: string, recordingId: string) {
    const recording = await this.prisma.recording.findFirst({ where: { id: recordingId, integrationId }, select: { id: true } });
    if (!recording) throw integrationForbidden();
    const result = await this.prisma.callbackDelivery.updateMany({ where: { recordingId, state: "FAILED" }, data: { state: "PENDING", attempts: 0, lastError: null, nextAttemptAt: new Date() } });
    return { retried: result.count };
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
