import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  CreateRoomResponse,
  GetRoomResponse,
  JoinRoomResponse,
  RoomSessionRefreshResponse,
} from "#contracts";
import { MAX_ROOM_PARTICIPANTS } from "#contracts";
import { randomBytes, randomUUID } from "node:crypto";
import { RoomRepository } from "./room.repository.js";
import { RoomTokenService } from "./room-token.service.js";
import { roomClosed, roomFull } from "./room-errors.js";
import { invalidToken } from "./room-errors.js";

@Injectable()
export class RoomsService {
  constructor(
    @Inject(RoomRepository) private readonly repository: RoomRepository,
    @Inject(RoomTokenService) private readonly tokens: RoomTokenService,
    @Inject(ConfigService) private readonly config: ConfigService
  ) {}

  async createRoom(): Promise<CreateRoomResponse> {
    const roomId = `room_${randomUUID()}`;
    const slug = this.createSlug();
    const participantId = `peer_${randomUUID()}`;
    const roomSessionToken = this.tokens.createRoomSessionToken();
    const createdAt = new Date();
    const mediaNode = this.selectMediaNode();

    const room = await this.repository.createRoom({
      roomId,
      slug,
      mediaNodeId: mediaNode.mediaNodeId,
      signalingUrl: mediaNode.signalingUrl,
      createdAt: createdAt.toISOString(),
      expiresAt: null,
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
  }

  async getRoom(slug: string): Promise<GetRoomResponse> {
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
  }

  async joinRoom(slug: string, displayName: string, roomSessionToken?: string): Promise<JoinRoomResponse> {
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

    const isExistingLiveParticipant = existingSession
      ? await this.repository.hasLiveParticipant(room.roomId, existingSession.participantId)
      : false;

    if (!isExistingLiveParticipant) {
      const count = await this.repository.getParticipantCount(room.roomId);
      if (count >= MAX_ROOM_PARTICIPANTS) {
        throw roomFull();
      }
    }

    const participantId = existingSession?.participantId ?? `peer_${randomUUID()}`;
    const isCreator = existingSession?.isCreator ?? false;
    const nextRoomSessionToken = roomSessionToken ?? this.tokens.createRoomSessionToken();

    await this.repository.saveRoomSession(
      room.roomId,
      {
        participantId,
        displayName: displayNameValue,
        isCreator,
        tokenHash: this.tokens.hashRoomSessionToken(nextRoomSessionToken),
        createdAt: existingSession?.createdAt ?? new Date().toISOString(),
      },
      room.expiresAt
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
  }

  async refreshRoomSession(
    slug: string,
    participantId: string,
    roomSessionToken: string
  ): Promise<RoomSessionRefreshResponse> {
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
  }

  private createSlug(): string {
    return randomBytes(5).toString("base64url").toLowerCase().replace(/_/g, "-").slice(0, 7);
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
}
