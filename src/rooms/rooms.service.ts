import { HttpException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  CreateJoinRequestResponse,
  CreateRoomAdmissionResponse,
  CreateRoomResponse,
  DecideJoinRequestResponse,
  GetRoomResponse,
  JoinRoomResponse,
  JoinRequestStatusResponse,
  ListJoinRequestsResponse,
  RoomSessionRefreshResponse,
} from "#contracts";
import { EMPTY_ROOM_TTL_SECONDS } from "#contracts";
import { randomBytes, randomUUID } from "node:crypto";
import type { TrustedCookieIdentity } from "../auth/trusted-cookie-auth.service.js";
import type { ApiConfig } from "../config/api-config.js";
import { getApiMetrics } from "../observability/api-metrics.service.js";
import { RoomRepository } from "./room.repository.js";
import { RoomTokenService } from "./room-token.service.js";
import type { RoomSessionIdentityRecord } from "./room.repository.js";
import { approvalRequired, roomClosed } from "./room-errors.js";
import { invalidToken } from "./room-errors.js";

@Injectable()
export class RoomsService {
  constructor(
    @Inject(RoomRepository) private readonly repository: RoomRepository,
    @Inject(RoomTokenService) private readonly tokens: RoomTokenService,
    @Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>
  ) {}

  async createRoom(
    options: { accessPolicy?: "link" | "approval" } = {},
    trustedIdentity?: TrustedCookieIdentity
  ): Promise<CreateRoomResponse> {
    return this.recordRoomControl("create_room", async () => {
      const accessPolicy = options.accessPolicy ?? "link";
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
        accessPolicy,
        mediaNodeId: mediaNode.mediaNodeId,
        signalingUrl: mediaNode.signalingUrl,
        createdAt: createdAt.toISOString(),
        expiresAt,
      });

      await this.repository.saveRoomSession(
        room.roomId,
        {
          participantId,
          displayName: trustedIdentity?.displayName ?? null,
          isCreator: true,
          tokenHash: this.tokens.hashRoomSessionToken(roomSessionToken),
          createdAt: createdAt.toISOString(),
          identity: trustedIdentity ? toRoomSessionIdentity(trustedIdentity) : undefined,
        },
        room.expiresAt
      );

      return {
        roomId: room.roomId,
        slug: room.slug,
        joinUrl: `${this.webPublicUrl()}/r/${room.slug}`,
        accessPolicy: room.accessPolicy,
        participantId,
        roomSessionToken,
        displayName: trustedIdentity?.displayName ?? null,
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
        accessPolicy: room.accessPolicy,
        mediaNodeId: room.mediaNodeId,
        signalingUrl: room.signalingUrl,
        participantCount,
      };
    });
  }

  async joinRoom(
    slug: string,
    displayName: string,
    roomSessionToken?: string,
    trustedIdentity?: TrustedCookieIdentity
  ): Promise<JoinRoomResponse> {
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
      if (!existingSession && (room.accessPolicy === "approval" || room.accessPolicy === "admission")) {
        throw approvalRequired();
      }
      const participantId = existingSession?.participantId ?? `peer_${randomUUID()}`;
      const isCreator = existingSession?.isCreator ?? false;
      const nextRoomSessionToken = roomSessionToken ?? this.tokens.createRoomSessionToken();
      const sessionExpiresAt = existingSession ? room.expiresAt : room.expiresAt ?? this.createSessionExpiresAt();
      const existingIdentity = existingSession?.identity;
      const nextIdentity = existingIdentity ?? (trustedIdentity ? toRoomSessionIdentity(trustedIdentity) : undefined);
      const locksDisplayName =
        nextIdentity && nextIdentity.source !== "anonymous" && nextIdentity.source !== "room_admission";
      const trustedDisplayName = existingSession?.displayName ?? trustedIdentity?.displayName;
      if (locksDisplayName && !trustedDisplayName) {
        throw invalidToken("Invalid room session token");
      }
      const effectiveDisplayName = trustedDisplayName ?? displayNameValue;

      await this.repository.saveRoomSession(
        room.roomId,
        {
          participantId,
          displayName: effectiveDisplayName,
          isCreator,
          tokenHash: this.tokens.hashRoomSessionToken(nextRoomSessionToken),
          createdAt: existingSession?.createdAt ?? new Date().toISOString(),
          identity: nextIdentity,
        },
        sessionExpiresAt
      );

      return {
        participantId,
        isCreator,
        token: this.tokens.createJoinToken({
          roomId: room.roomId,
          participantId,
          displayName: effectiveDisplayName,
          isCreator,
        }),
        roomSessionToken: nextRoomSessionToken,
        signalingUrl: room.signalingUrl,
      };
    });
  }

  async createJoinRequest(
    slug: string,
    displayName: string,
    trustedIdentity?: TrustedCookieIdentity
  ): Promise<CreateJoinRequestResponse> {
    return this.recordRoomControl("create_join_request", async () => {
      const room = await this.repository.getRoomBySlug(slug);
      if (room.status === "closed") {
        throw roomClosed();
      }
      if (room.accessPolicy !== "approval") {
        throw approvalRequired();
      }
      const requestToken = this.tokens.createRoomSessionToken();
      const createdAt = new Date();
      const expiresAt = minIsoDeadline(
        new Date(createdAt.getTime() + EMPTY_ROOM_TTL_SECONDS * 1_000).toISOString(),
        room.expiresAt
      );
      if (!expiresAt) {
        throw invalidToken("Invalid join request");
      }
      const requestId = `join_${randomUUID()}`;
      const trimmedDisplayName = trustedIdentity?.displayName ?? displayName.trim();

      await this.repository.createJoinRequest(
        {
          requestId,
          roomId: room.roomId,
          displayName: trimmedDisplayName,
          tokenHash: this.tokens.hashRoomSessionToken(requestToken),
          status: "pending",
          createdAt: createdAt.toISOString(),
          expiresAt,
          identity: trustedIdentity ? toRoomSessionIdentity(trustedIdentity) : undefined,
        },
        room.expiresAt
      );

      return {
        requestId,
        requestToken,
        status: "pending",
        displayName: trimmedDisplayName,
        expiresAt,
      };
    });
  }

  async getJoinRequestStatus(slug: string, requestId: string, requestToken: string): Promise<JoinRequestStatusResponse> {
    return this.recordRoomControl("join_request_status", async () => {
      const room = await this.repository.getRoomBySlug(slug);
      const request = await this.repository.getJoinRequest(room.roomId, requestId);
      if (!request || !this.tokens.isRoomSessionTokenValid(requestToken, request.tokenHash)) {
        throw invalidToken("Invalid join request");
      }

      const expired = Date.parse(request.expiresAt) <= Date.now();
      if (expired) {
        return {
          requestId: request.requestId,
          status: "expired",
          displayName: request.displayName,
          expiresAt: request.expiresAt,
        };
      }

      if (request.status !== "approved") {
        return {
          requestId: request.requestId,
          status: request.status,
          displayName: request.displayName,
          expiresAt: request.expiresAt,
        };
      }

      if (request.approvedParticipantId || request.approvedTokenHash) {
        return {
          requestId: request.requestId,
          status: "approved",
          displayName: request.displayName,
          expiresAt: request.expiresAt,
        };
      }

      const participantId = `peer_${randomUUID()}`;
      const roomSessionToken = this.tokens.createRoomSessionToken();
      const tokenHash = this.tokens.hashRoomSessionToken(roomSessionToken);
      await this.repository.fulfillApprovedJoinRequest(
        room.roomId,
        request.requestId,
        participantId,
        tokenHash,
        {
          participantId,
          displayName: request.displayName,
          isCreator: false,
          tokenHash,
          createdAt: new Date().toISOString(),
          identity: request.identity,
        },
        minIsoDeadline(new Date(Date.now() + EMPTY_ROOM_TTL_SECONDS * 1_000).toISOString(), room.expiresAt)
      );

      return {
        requestId: request.requestId,
        status: "approved",
        displayName: request.displayName,
        participantId,
        roomSessionToken,
        isCreator: false,
        expiresAt: request.expiresAt,
      };
    });
  }

  async listJoinRequests(slug: string, participantId: string, roomSessionToken: string): Promise<ListJoinRequestsResponse> {
    return this.recordRoomControl("list_join_requests", async () => {
      const room = await this.repository.getRoomBySlug(slug);
      await this.authorizeCreator(room.roomId, participantId, roomSessionToken);
      const requests = await this.repository.listPendingJoinRequests(room.roomId);
      return {
        requests: requests.map((request) => ({
          requestId: request.requestId,
          displayName: request.displayName,
          createdAt: request.createdAt,
          expiresAt: request.expiresAt,
        })),
      };
    });
  }

  async createRoomAdmission(
    slug: string,
    participantId: string,
    roomSessionToken: string
  ): Promise<CreateRoomAdmissionResponse> {
    return this.recordRoomControl("create_room_admission", async () => {
      const room = await this.repository.getRoomBySlug(slug);
      if (room.status === "closed") {
        throw roomClosed();
      }
      if (room.accessPolicy !== "approval") {
        throw approvalRequired();
      }

      await this.authorizeCreator(room.roomId, participantId, roomSessionToken);

      const createdAt = new Date();
      const expiresAt = minIsoDeadline(
        new Date(createdAt.getTime() + EMPTY_ROOM_TTL_SECONDS * 1_000).toISOString(),
        room.expiresAt
      );
      if (!expiresAt) {
        throw invalidToken("Invalid admission code");
      }

      const rawCode = this.tokens.createAdmissionCode();
      await this.repository.createAdmission({
        roomId: room.roomId,
        codeHash: this.tokens.hashAdmissionCode(rawCode),
        identity: {
          kind: "guest",
          source: "room_admission",
        },
        roomControls: "none",
        createdAt: createdAt.toISOString(),
        expiresAt,
      });

      return {
        entryUrl: `${this.webPublicUrl()}/r/${encodeURIComponent(room.slug)}#code=${encodeURIComponent(rawCode)}`,
        expiresAt,
      };
    });
  }

  async decideJoinRequest(
    slug: string,
    requestId: string,
    participantId: string,
    roomSessionToken: string,
    decision: "approve" | "deny"
  ): Promise<DecideJoinRequestResponse> {
    return this.recordRoomControl("decide_join_request", async () => {
      const room = await this.repository.getRoomBySlug(slug);
      await this.authorizeCreator(room.roomId, participantId, roomSessionToken);
      const request = await this.repository.decideJoinRequest(
        room.roomId,
        requestId,
        decision === "approve" ? "approved" : "denied",
        participantId
      );
      return { requestId: request.requestId, status: request.status as "approved" | "denied" };
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

  private async authorizeCreator(roomId: string, participantId: string, roomSessionToken: string): Promise<void> {
    const session = await this.repository.getRoomSession(roomId, participantId);
    if (!session || !session.isCreator || !this.tokens.isRoomSessionTokenValid(roomSessionToken, session.tokenHash)) {
      throw invalidToken("Invalid room session token");
    }
  }

  private webPublicUrl(): string {
    return this.config.get("WEB_PUBLIC_URL", { infer: true }).replace(/\/$/, "");
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

  private async recordRoomControl<T>(
    operation:
      | "create_room"
      | "get_room"
      | "join_room"
      | "refresh_room_session"
      | "create_join_request"
      | "join_request_status"
      | "list_join_requests"
      | "create_room_admission"
      | "decide_join_request",
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

function minIsoDeadline(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
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
    [
      "ROOM_NOT_FOUND",
      "ROOM_EXPIRED",
      "ROOM_CLOSED",
      "INVALID_TOKEN",
      "APPROVAL_REQUIRED",
      "AUTH_NOT_CONFIGURED",
    ].includes(response.code)
  ) {
    return response.code;
  }

  return error.getStatus() >= 500 ? "DEPENDENCY_UNAVAILABLE" : "CLIENT_REQUEST_ERROR";
}

function toRoomSessionIdentity(identity: TrustedCookieIdentity): RoomSessionIdentityRecord {
  return {
    kind: identity.kind,
    source: identity.source,
    externalSubject: identity.externalSubject,
    avatarUrl: identity.avatarUrl,
  };
}
