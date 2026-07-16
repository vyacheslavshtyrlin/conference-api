import { Inject, Injectable } from "@nestjs/common";
import type { RoomMetadata } from "#contracts";
import { REDIS_CLIENT } from "../redis/redis.constants.js";
import type { RedisClient } from "../redis/redis.types.js";
import { getApiMetrics } from "../observability/api-metrics.service.js";
import { roomExpired, roomNotFound } from "./room-errors.js";

export type CreateRoomRecord = {
  roomId: string;
  slug: string;
  mediaNodeId: string;
  signalingUrl: string;
  createdAt: string;
  expiresAt: string | null;
};

export type RoomSessionRecord = {
  participantId: string;
  displayName: string | null;
  isCreator: boolean;
  tokenHash: string;
  createdAt: string;
};

export abstract class RoomRepository {
  abstract createRoom(record: CreateRoomRecord): Promise<RoomMetadata>;
  abstract getRoomBySlug(slug: string): Promise<RoomMetadata>;
  abstract getParticipantCount(roomId: string): Promise<number>;
  abstract hasLiveParticipant(roomId: string, participantId: string): Promise<boolean>;
  abstract saveRoomSession(roomId: string, session: RoomSessionRecord, roomExpiresAt: string | null): Promise<void>;
  abstract getRoomSession(roomId: string, participantId: string): Promise<RoomSessionRecord | undefined>;
  abstract findRoomSessionByTokenHash(roomId: string, tokenHash: string): Promise<RoomSessionRecord | undefined>;
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
      closedReason: null,
    });
    if (!room) {
      throw roomNotFound();
    }

    await this.recordRedis("create_room_metadata", () =>
      this.redis.set(this.roomKey(room.roomId), JSON.stringify(room))
    );
    await this.recordRedis("create_room_slug", () => this.redis.set(this.slugKey(room.slug), room.roomId));
    const ttlMs = getTtlMilliseconds(room.expiresAt);
    if (ttlMs) {
      await this.recordRedis("expire_room_metadata", () => this.redis.pExpire(this.roomKey(room.roomId), ttlMs));
      await this.recordRedis("expire_room_slug", () => this.redis.pExpire(this.slugKey(room.slug), ttlMs));
    }

    return room;
  }

  async getRoomBySlug(slug: string): Promise<RoomMetadata> {
    const roomId = await this.recordRedis("get_room_slug", () => this.redis.get(this.slugKey(slug)));
    if (!roomId) {
      throw roomNotFound();
    }

    const raw = await this.recordRedis("get_room_metadata", () => this.redis.get(this.roomKey(roomId)));
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
    const currentEpoch = await this.getCurrentMediaEpoch();
    if (!currentEpoch) {
      return 0;
    }

    const values = await this.recordRedis("get_participant_count", () =>
      this.redis.hVals(`room:${roomId}:participants`)
    );
    return values.filter((value) => hasCurrentMediaEpoch(value, currentEpoch)).length;
  }

  async hasLiveParticipant(roomId: string, participantId: string): Promise<boolean> {
    const raw = await this.recordRedis("get_live_participant", () =>
      this.redis.hGet(`room:${roomId}:participants`, participantId)
    );
    const currentEpoch = await this.getCurrentMediaEpoch();
    return Boolean(raw && currentEpoch && hasCurrentMediaEpoch(raw, currentEpoch));
  }

  async saveRoomSession(roomId: string, session: RoomSessionRecord, roomExpiresAt: string | null): Promise<void> {
    const parsed = parseRoomSession(session);
    if (!parsed) {
      throw roomNotFound();
    }

    const key = this.roomSessionsKey(roomId);
    const existingRaw = await this.recordRedis("get_room_session", () => this.redis.hGet(key, parsed.participantId));
    const existing = parseSerializedRoomSession(existingRaw);
    if (existing && existing.tokenHash !== parsed.tokenHash) {
      await this.recordRedis("delete_room_session_token_index", () =>
        this.redis.del(this.roomSessionTokenIndexKey(existing.tokenHash))
      );
    }

    await this.recordRedis("save_room_session", () =>
      this.redis.hSet(key, parsed.participantId, JSON.stringify(parsed))
    );
    await this.recordRedis("save_room_session_token_index", () =>
      this.redis.set(
        this.roomSessionTokenIndexKey(parsed.tokenHash),
        JSON.stringify({ roomId, participantId: parsed.participantId })
      )
    );

    const ttlMs = getTtlMilliseconds(roomExpiresAt);
    if (ttlMs) {
      await this.recordRedis("expire_room_sessions", () => this.redis.pExpire(key, ttlMs));
      await this.recordRedis("expire_room_session_token_index", () =>
        this.redis.pExpire(this.roomSessionTokenIndexKey(parsed.tokenHash), ttlMs)
      );
    }
  }

  async getRoomSession(roomId: string, participantId: string): Promise<RoomSessionRecord | undefined> {
    const raw = await this.recordRedis("get_room_session", () =>
      this.redis.hGet(this.roomSessionsKey(roomId), participantId)
    );
    if (!raw) {
      return undefined;
    }

    return parseSerializedRoomSession(raw);
  }

  async findRoomSessionByTokenHash(roomId: string, tokenHash: string): Promise<RoomSessionRecord | undefined> {
    const rawIndex = await this.recordRedis("find_room_session_by_token_hash", () =>
      this.redis.get(this.roomSessionTokenIndexKey(tokenHash))
    );
    const index = parseRoomSessionTokenIndex(rawIndex);
    if (!index || index.roomId !== roomId) {
      return undefined;
    }

    const rawSession = await this.recordRedis("get_room_session_by_token_index", () =>
      this.redis.hGet(this.roomSessionsKey(roomId), index.participantId)
    );
    if (!rawSession) {
      return undefined;
    }

    const session = parseSerializedRoomSession(rawSession);
    return session?.tokenHash === tokenHash ? session : undefined;
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

  private roomSessionTokenIndexKey(tokenHash: string): string {
    return `room_session_token:${tokenHash}`;
  }

  private async getCurrentMediaEpoch(): Promise<string | undefined> {
    const raw = await this.recordRedis("read_media_lease", () => this.redis.get("media:lease"));
    if (!raw) {
      return undefined;
    }

    try {
      const value = JSON.parse(raw) as unknown;
      if (
        !isRecord(value) ||
        typeof value.mediaEpoch !== "string" ||
        value.mediaEpoch.length === 0 ||
        typeof value.expiresAt !== "string" ||
        Number.isNaN(Date.parse(value.expiresAt)) ||
        Date.parse(value.expiresAt) <= Date.now()
      ) {
        return undefined;
      }
      return value.mediaEpoch;
    } catch {
      return undefined;
    }
  }

  private async recordRedis<T>(
    operation:
      | "create_room_metadata"
      | "create_room_slug"
      | "expire_room_metadata"
      | "expire_room_slug"
      | "get_room_slug"
      | "get_room_metadata"
      | "get_participant_count"
      | "get_live_participant"
      | "save_room_session"
      | "save_room_session_token_index"
      | "delete_room_session_token_index"
      | "expire_room_sessions"
      | "expire_room_session_token_index"
      | "get_room_session"
      | "find_room_session_by_token_hash"
      | "get_room_session_by_token_index"
      | "read_media_lease",
    work: () => Promise<T>
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await work();
      getApiMetrics().recordRedisOperation({
        operation,
        outcome: "success",
        durationMs: performance.now() - startedAt,
      });
      return result;
    } catch (error) {
      getApiMetrics().recordRedisOperation({
        operation,
        outcome: "error",
        durationMs: performance.now() - startedAt,
      });
      throw error;
    }
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
    !(
      session.displayName === null ||
      (typeof session.displayName === "string" &&
        session.displayName.trim().length > 0 &&
        session.displayName.length <= 80)
    ) ||
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

function parseSerializedRoomSession(value: string | null | undefined): RoomSessionRecord | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return parseRoomSession(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function parseRoomSessionTokenIndex(value: string | null | undefined): { roomId: string; participantId: string } | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.roomId !== "string" ||
      parsed.roomId.length === 0 ||
      typeof parsed.participantId !== "string" ||
      parsed.participantId.length === 0
    ) {
      return undefined;
    }

    return { roomId: parsed.roomId, participantId: parsed.participantId };
  } catch {
    return undefined;
  }
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
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    status: value.status,
    closedReason: value.closedReason ?? null,
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
    typeof room.createdAt !== "string" ||
    Number.isNaN(Date.parse(room.createdAt)) ||
    !isExpiresAt(room.expiresAt) ||
    (room.status !== "active" && room.status !== "closed") ||
    !isClosedReason(room.closedReason)
  ) {
    return undefined;
  }

  return room as RoomMetadata;
}

function isExpiresAt(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function isClosedReason(value: unknown): value is RoomMetadata["closedReason"] {
  return (
    value === null ||
    value === "closed_by_creator" ||
    value === "empty_timeout" ||
    value === "server_shutdown" ||
    value === "media_server_error"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasCurrentMediaEpoch(value: string, mediaEpoch: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) && parsed.mediaEpoch === mediaEpoch && isRecord(parsed.participant);
  } catch {
    return false;
  }
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
