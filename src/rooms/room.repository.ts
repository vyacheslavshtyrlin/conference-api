import { Inject, Injectable } from "@nestjs/common";
import type { RoomMetadata } from "#contracts";
import { REDIS_CLIENT } from "../redis/redis.constants.js";
import type { RedisClient } from "../redis/redis.types.js";
import { roomExpired, roomNotFound } from "./room-errors.js";

export type CreateRoomRecord = {
  roomId: string;
  slug: string;
  mediaNodeId: string;
  signalingUrl: string;
  creatorTokenHash: string;
  createdAt: string;
  expiresAt: string | null;
};

export type RoomSessionRecord = {
  participantId: string;
  displayName: string;
  isCreator: boolean;
  tokenHash: string;
  createdAt: string;
};

export abstract class RoomRepository {
  abstract createRoom(record: CreateRoomRecord): Promise<RoomMetadata>;
  abstract getRoomBySlug(slug: string): Promise<RoomMetadata>;
  abstract getParticipantCount(roomId: string): Promise<number>;
  abstract saveRoomSession(roomId: string, session: RoomSessionRecord, roomExpiresAt: string | null): Promise<void>;
  abstract getRoomSession(roomId: string, participantId: string): Promise<RoomSessionRecord | undefined>;
}

@Injectable()
export class RedisRoomRepository extends RoomRepository {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {
    super();
  }

  async createRoom(record: CreateRoomRecord): Promise<RoomMetadata> {
    const room = parseRoomMetadata({
      ...record,
      status: "active",
    });
    if (!room) {
      throw roomNotFound();
    }

    await this.redis.set(this.roomKey(room.roomId), JSON.stringify(room));
    await this.redis.set(this.slugKey(room.slug), room.roomId);

    return room;
  }

  async getRoomBySlug(slug: string): Promise<RoomMetadata> {
    const roomId = await this.redis.get(this.slugKey(slug));
    if (!roomId) {
      throw roomNotFound();
    }

    const raw = await this.redis.get(this.roomKey(roomId));
    if (!raw) {
      throw roomNotFound();
    }

    let roomJson: unknown;
    try {
      roomJson = JSON.parse(raw) as unknown;
    } catch {
      throw roomNotFound();
    }

    const room = parseRoomMetadata(roomJson);
    if (!room) {
      throw roomNotFound();
    }

    if (room.expiresAt && new Date(room.expiresAt).getTime() <= Date.now()) {
      throw roomExpired();
    }

    return room;
  }

  async getParticipantCount(roomId: string): Promise<number> {
    return this.redis.hLen(`room:${roomId}:participants`);
  }

  async saveRoomSession(roomId: string, session: RoomSessionRecord, roomExpiresAt: string | null): Promise<void> {
    const parsed = parseRoomSession(session);
    if (!parsed) {
      throw roomNotFound();
    }

    const key = this.roomSessionsKey(roomId);
    await this.redis.hSet(key, parsed.participantId, JSON.stringify(parsed));

    const ttlMs = getTtlMilliseconds(roomExpiresAt);
    if (ttlMs) {
      await this.redis.pExpire(key, ttlMs);
    }
  }

  async getRoomSession(roomId: string, participantId: string): Promise<RoomSessionRecord | undefined> {
    const raw = await this.redis.hGet(this.roomSessionsKey(roomId), participantId);
    if (!raw) {
      return undefined;
    }

    try {
      return parseRoomSession(JSON.parse(raw) as unknown);
    } catch {
      return undefined;
    }
  }

  private roomKey(roomId: string): string {
    return `room:${roomId}`;
  }

  private slugKey(slug: string): string {
    return `room_slug:${slug}`;
  }

  private roomSessionsKey(roomId: string): string {
    return `room:${roomId}:sessions`;
  }

}

function parseRoomSession(value: unknown): RoomSessionRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const session = {
    participantId: value.participantId,
    displayName: value.displayName,
    isCreator: value.isCreator,
    tokenHash: value.tokenHash,
    createdAt: value.createdAt,
  };

  if (
    typeof session.participantId !== "string" ||
    session.participantId.length === 0 ||
    typeof session.displayName !== "string" ||
    session.displayName.trim().length === 0 ||
    session.displayName.length > 80 ||
    typeof session.isCreator !== "boolean" ||
    typeof session.tokenHash !== "string" ||
    session.tokenHash.length === 0 ||
    typeof session.createdAt !== "string" ||
    Number.isNaN(Date.parse(session.createdAt))
  ) {
    return undefined;
  }

  return session as RoomSessionRecord;
}

function getTtlMilliseconds(expiresAt: string | null): number | undefined {
  if (!expiresAt) {
    return undefined;
  }

  const ttlMs = new Date(expiresAt).getTime() - Date.now();
  return ttlMs > 0 ? ttlMs : undefined;
}

function parseRoomMetadata(value: unknown): RoomMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const room = {
    roomId: value.roomId,
    slug: value.slug,
    mediaNodeId: value.mediaNodeId,
    signalingUrl: value.signalingUrl,
    creatorTokenHash: value.creatorTokenHash,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    status: value.status,
  };

  if (
    typeof room.roomId !== "string" ||
    room.roomId.length === 0 ||
    typeof room.slug !== "string" ||
    room.slug.length === 0 ||
    typeof room.mediaNodeId !== "string" ||
    room.mediaNodeId.length === 0 ||
    typeof room.signalingUrl !== "string" ||
    !isUrl(room.signalingUrl) ||
    typeof room.creatorTokenHash !== "string" ||
    room.creatorTokenHash.length === 0 ||
    typeof room.createdAt !== "string" ||
    Number.isNaN(Date.parse(room.createdAt)) ||
    !isExpiresAt(room.expiresAt) ||
    (room.status !== "active" && room.status !== "closed")
  ) {
    return undefined;
  }

  return room as RoomMetadata;
}

function isExpiresAt(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
