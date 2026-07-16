import { HttpException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  CreateRoomResponse,
  GetRoomResponse,
  JoinRoomResponse,
  RoomSessionRefreshResponse,
} from "#contracts";
import { EMPTY_ROOM_TTL_SECONDS } from "#contracts";
import { randomBytes, randomUUID } from "node:crypto";
import { RoomRepository } from "./room.repository.js";
import { RoomTokenService } from "./room-token.service.js";
import { roomClosed } from "./room-errors.js";
import { invalidToken } from "./room-errors.js";
import { getApiMetrics } from "../observability/api-metrics.service.js";

@Injectable()
export class RoomsService {
  constructor(
    @Inject(RoomRepository) private readonly repository: RoomRepository,
    @Inject(RoomTokenService) private readonly tokens: RoomTokenService,
    @Inject(ConfigService) private readonly config: ConfigService
  ) {}

  async createRoom(): Promise<CreateRoomResponse> {
    return this.recordRoomControl("create_room", async () => {
      const roomId = `room_${randomUUID()}`;
      const slug = this.createSlug();
      const participantId = `peer_${randomUUID()}`;
      const roomSessionToken = this.tokens.createRoomSessionToken();
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + EMPTY_ROOM_TTL_SECONDS * 1_000).toISOString();
      const mediaNode = this.selectMediaNode();

      const room = await this.repository.createRoom({
        roomId,
        slug,
        mediaNodeId: mediaNode.mediaNodeId,
        signalingUrl: mediaNode.signalingUrl,
        createdAt: createdAt.toISOString(),
        expiresAt,
      });

      await this.repository.saveRoomSession(
        room.roomId,
        {
          participantId,
          displayName: null,
          isCreator: true,
          tokenHash: this.tokens.hashRoomSessionToken(roomSessionToken),
          createdAt: createdAt.toISOString(),
        },
        room.expiresAt
      );

      return {
        roomId: room.roomId,
        slug: room.slug,
        joinUrl: `${this.webPublicUrl()}/r/${room.slug}`,
        participantId,
        roomSessionToken,
        mediaNodeId: room.mediaNodeId,
        signalingUrl: room.signalingUrl,
        expiresAt: room.expiresAt,
      };
    });
  }

  async getRoom(slug: string): Promise<GetRoomResponse> {
    return this.recordRoomControl("get_room", async () => {
      const room = await this.repository.getRoomBySlug(slug);
      const participantCount = await this.repository.getParticipantCount(room.roomId);

      return {
        roomId: room.roomId,
        slug: room.slug,
        expiresAt: room.expiresAt,
        status: room.status,
        closedReason: room.closedReason ?? null,
        mediaNodeId: room.mediaNodeId,
        signalingUrl: room.signalingUrl,
        participantCount,
      };
    });
  }

  async joinRoom(slug: string, displayName: string, roomSessionToken?: string): Promise<JoinRoomResponse> {
    return this.recordRoomControl("join_room", async () => {
      const room = await this.repository.getRoomBySlug(slug);
      if (room.status === "closed") {
        throw roomClosed();
      }

      const displayNameValue = displayName.trim();
      const existingSession = roomSessionToken
        ? await this.repository.findRoomSessionByTokenHash(
            room.roomId,
            this.tokens.hashRoomSessionToken(roomSessionToken)
          )
        : undefined;

      if (roomSessionToken && !existingSession) {
        throw invalidToken("Invalid room session token");
      }

      const participantId = existingSession?.participantId ?? `peer_${randomUUID()}`;
      const isCreator = existingSession?.isCreator ?? false;
      const nextRoomSessionToken = roomSessionToken ?? this.tokens.createRoomSessionToken();
      const sessionExpiresAt = existingSession ? room.expiresAt : room.expiresAt ?? this.createSessionExpiresAt();

      await this.repository.saveRoomSession(
        room.roomId,
        {
          participantId,
          displayName: displayNameValue,
          isCreator,
          tokenHash: this.tokens.hashRoomSessionToken(nextRoomSessionToken),
          createdAt: existingSession?.createdAt ?? new Date().toISOString(),
        },
        sessionExpiresAt
      );

      return {
        participantId,
        isCreator,
        token: this.tokens.createJoinToken({
          roomId: room.roomId,
          participantId,
          displayName: displayNameValue,
          isCreator,
        }),
        roomSessionToken: nextRoomSessionToken,
        signalingUrl: room.signalingUrl,
      };
    });
  }

  async refreshRoomSession(
    slug: string,
    participantId: string,
    roomSessionToken: string
  ): Promise<RoomSessionRefreshResponse> {
    return this.recordRoomControl("refresh_room_session", async () => {
      const room = await this.repository.getRoomBySlug(slug);
      if (room.status === "closed") {
        throw roomClosed();
      }

      const session = await this.repository.getRoomSession(room.roomId, participantId);
      if (
        !session ||
        !session.displayName ||
        !this.tokens.isRoomSessionTokenValid(roomSessionToken, session.tokenHash)
      ) {
        throw invalidToken("Invalid room session token");
      }

      return {
        token: this.tokens.createJoinToken({
          roomId: room.roomId,
          participantId: session.participantId,
          displayName: session.displayName,
          isCreator: session.isCreator,
        }),
        signalingUrl: room.signalingUrl,
      };
    });
  }

  private createSlug(): string {
    return randomBytes(5).toString("base64url").toLowerCase().replace(/_/g, "-").slice(0, 7);
  }

  private createSessionExpiresAt(): string {
    return new Date(Date.now() + EMPTY_ROOM_TTL_SECONDS * 1_000).toISOString();
  }

  private webPublicUrl(): string {
    return (this.config.get<string>("WEB_PUBLIC_URL") ?? "http://localhost:5173").replace(/\/$/, "");
  }

  private signalingPublicUrl(): string {
    return this.config.get<string>("SIGNALING_PUBLIC_URL") ?? "ws://localhost:4000/ws";
  }

  private selectMediaNode(): { mediaNodeId: string; signalingUrl: string } {
    return {
      mediaNodeId: this.config.get<string>("MEDIA_NODE_ID") ?? "local",
      signalingUrl: this.signalingPublicUrl(),
    };
  }

  private async recordRoomControl<T>(
    operation: "create_room" | "get_room" | "join_room" | "refresh_room_session",
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
        errorCode: stableRoomControlErrorCode(error),
        durationMs: performance.now() - startedAt,
      });
      throw error;
    }
  }
}

function stableRoomControlErrorCode(error: unknown): string {
  if (!(error instanceof HttpException)) {
    return "INTERNAL_ERROR";
  }

  const response = error.getResponse();
  if (
    typeof response === "object" &&
    response !== null &&
    "code" in response &&
    typeof response.code === "string" &&
    ["ROOM_NOT_FOUND", "ROOM_EXPIRED", "ROOM_CLOSED", "INVALID_TOKEN"].includes(response.code)
  ) {
    return response.code;
  }

  return error.getStatus() >= 500 ? "DEPENDENCY_UNAVAILABLE" : "CLIENT_REQUEST_ERROR";
}
