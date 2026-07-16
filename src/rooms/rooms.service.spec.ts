import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import type { RoomMetadata } from "#contracts";
import { roomNotFound } from "./room-errors.js";
import type { CreateRoomRecord, RoomSessionRecord } from "./room.repository.js";
import { RoomRepository } from "./room.repository.js";
import { RoomTokenService } from "./room-token.service.js";
import { RoomsService } from "./rooms.service.js";

class InMemoryRoomRepository extends RoomRepository {
  readonly rooms = new Map<string, RoomMetadata>();
  readonly slugs = new Map<string, string>();
  readonly participantCounts = new Map<string, number>();
  readonly liveParticipants = new Set<string>();
  readonly sessions = new Map<string, RoomSessionRecord>();
  readonly sessionExpiries = new Map<string, string | null>();

  async createRoom(record: CreateRoomRecord): Promise<RoomMetadata> {
    const room: RoomMetadata = { ...record, status: "active", closedReason: null };
    this.rooms.set(room.roomId, room);
    this.slugs.set(room.slug, room.roomId);
    return room;
  }

  async getRoomBySlug(slug: string): Promise<RoomMetadata> {
    const roomId = this.slugs.get(slug);
    const room = roomId ? this.rooms.get(roomId) : undefined;

    if (!room) {
      throw roomNotFound();
    }

    return room;
  }

  async getParticipantCount(roomId: string): Promise<number> {
    return this.participantCounts.get(roomId) ?? 0;
  }

  async hasLiveParticipant(roomId: string, participantId: string): Promise<boolean> {
    return this.liveParticipants.has(`${roomId}:${participantId}`);
  }

  async saveRoomSession(roomId: string, session: RoomSessionRecord, roomExpiresAt: string | null): Promise<void> {
    this.sessions.set(`${roomId}:${session.participantId}`, session);
    this.sessionExpiries.set(`${roomId}:${session.participantId}`, roomExpiresAt);
  }

  async getRoomSession(roomId: string, participantId: string): Promise<RoomSessionRecord | undefined> {
    return this.sessions.get(`${roomId}:${participantId}`);
  }

  async findRoomSessionByTokenHash(roomId: string, tokenHash: string): Promise<RoomSessionRecord | undefined> {
    return Array.from(this.sessions.entries())
      .filter(([key]) => key.startsWith(`${roomId}:`))
      .map(([, session]) => session)
      .find((session) => session.tokenHash === tokenHash);
  }
}

function createService() {
  const repository = new InMemoryRoomRepository();
  const config = new ConfigService({
    JOIN_TOKEN_SECRET: "test-secret",
    WEB_PUBLIC_URL: "http://web.test",
    SIGNALING_PUBLIC_URL: "ws://signaling.test/ws",
  });
  const tokenService = new RoomTokenService(config);

  return {
    repository,
    service: new RoomsService(repository, tokenService, config),
    tokenService,
  };
}

describe("RoomsService", () => {
  it("creates a room with a public join URL and private creator room session", async () => {
    const { repository, service } = createService();

    const room = await service.createRoom();
    const stored = await repository.getRoomBySlug(room.slug);
    const storedSession = await repository.getRoomSession(room.roomId, room.participantId);

    expect(room.joinUrl).toBe(`http://web.test/r/${room.slug}`);
    expect(room.joinUrl).not.toContain(room.roomSessionToken);
    expect(room.participantId).toMatch(/^peer_/);
    expect(room.roomSessionToken).toEqual(expect.any(String));
    expect(room.mediaNodeId).toBe("local");
    expect(room.signalingUrl).toBe("ws://signaling.test/ws");
    expect(stored.mediaNodeId).toBe("local");
    expect(stored.signalingUrl).toBe("ws://signaling.test/ws");
    expect(room.expiresAt).toEqual(expect.any(String));
    expect(Date.parse(room.expiresAt ?? "")).toBeGreaterThan(Date.now());
    expect(stored.expiresAt).toBe(room.expiresAt);
    expect(storedSession).toMatchObject({
      participantId: room.participantId,
      displayName: null,
      isCreator: true,
    });
    expect(storedSession?.tokenHash).not.toBe(room.roomSessionToken);
  });

  it("returns creator metadata only for a valid room session token", async () => {
    const { service } = createService();
    const room = await service.createRoom();

    const creatorJoin = await service.joinRoom(room.slug, "Alex", room.roomSessionToken);
    const guestJoin = await service.joinRoom(room.slug, "Sam");

    expect(creatorJoin.isCreator).toBe(true);
    expect(creatorJoin.participantId).toBe(room.participantId);
    expect(creatorJoin.roomSessionToken).toBe(room.roomSessionToken);
    expect(guestJoin.isCreator).toBe(false);
    expect(guestJoin.participantId).not.toBe(room.participantId);
    expect(creatorJoin.signalingUrl).toBe("ws://signaling.test/ws");
    expect(creatorJoin.roomSessionToken).toEqual(expect.any(String));
  });

  it("issues a join token for a pending creator session regardless of the current room size", async () => {
    const { repository, service } = createService();
    const room = await service.createRoom();
    repository.participantCounts.set(room.roomId, 10);

    await expect(service.joinRoom(room.slug, "Alex", room.roomSessionToken)).resolves.toMatchObject({
      participantId: room.participantId,
      isCreator: true,
    });
  });

  it("gives a new guest pending session its own deadline when the room is already live", async () => {
    const { repository, service } = createService();
    const room = await service.createRoom();
    const stored = await repository.getRoomBySlug(room.slug);
    repository.rooms.set(stored.roomId, {
      ...stored,
      expiresAt: null,
    });

    const join = await service.joinRoom(room.slug, "Sam");

    const sessionExpiry = repository.sessionExpiries.get(`${room.roomId}:${join.participantId}`);
    expect(sessionExpiry).toEqual(expect.any(String));
    expect(Date.parse(sessionExpiry ?? "")).toBeGreaterThan(Date.now());
  });

  it("preserves an existing live participant identity when issuing another join token", async () => {
    const { repository, service } = createService();
    const room = await service.createRoom();
    const firstJoin = await service.joinRoom(room.slug, "Alex", room.roomSessionToken);
    repository.participantCounts.set(room.roomId, 10);
    repository.liveParticipants.add(`${room.roomId}:${firstJoin.participantId}`);

    const reconnectJoin = await service.joinRoom(room.slug, "Alex", firstJoin.roomSessionToken);

    expect(reconnectJoin.participantId).toBe(firstJoin.participantId);
    expect(reconnectJoin.isCreator).toBe(true);
    expect(reconnectJoin.token).toEqual(expect.any(String));
  });

  it("returns the signaling URL assigned when the room was created", async () => {
    const { repository, service } = createService();
    const room = await service.createRoom();
    const stored = await repository.getRoomBySlug(room.slug);
    repository.rooms.set(stored.roomId, {
      ...stored,
      mediaNodeId: "media-2",
      signalingUrl: "wss://media-2.test/ws",
    });

    const join = await service.joinRoom(room.slug, "Alex", room.roomSessionToken);

    expect(join.signalingUrl).toBe("wss://media-2.test/ws");
  });

  it("returns live participant count in room lookup", async () => {
    const { repository, service } = createService();
    const room = await service.createRoom();
    repository.participantCounts.set(room.roomId, 3);

    await expect(service.getRoom(room.slug)).resolves.toMatchObject({
      roomId: room.roomId,
      participantCount: 3,
      closedReason: null,
    });
  });

  it("returns the closed room reason in room lookup", async () => {
    const { repository, service } = createService();
    const room = await service.createRoom();
    const stored = await repository.getRoomBySlug(room.slug);
    repository.rooms.set(stored.roomId, {
      ...stored,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      status: "closed",
      closedReason: "media_server_error",
    });

    await expect(service.getRoom(room.slug)).resolves.toMatchObject({
      status: "closed",
      closedReason: "media_server_error",
    });
  });

  it("rejects joins for closed rooms", async () => {
    const { repository, service } = createService();
    const room = await service.createRoom();
    const stored = await repository.getRoomBySlug(room.slug);
    repository.rooms.set(stored.roomId, {
      ...stored,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      status: "closed",
      closedReason: "closed_by_creator",
    });

    await expect(service.joinRoom(room.slug, "Alex", room.roomSessionToken)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "ROOM_CLOSED" }),
    });
  });

  it("issues signaling tokens accepted by the signaling token verifier", async () => {
    const { service } = createService();
    const room = await service.createRoom();

    const join = await service.joinRoom(room.slug, "Alex", room.roomSessionToken);
    const [, encodedPayload] = join.token.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString("utf8")) as {
      roomId: string;
      participantId: string;
      displayName: string;
      isCreator: boolean;
      exp: number;
    };

    expect(payload.roomId).toBe(room.roomId);
    expect(payload.participantId).toBe(join.participantId);
    expect(payload.displayName).toBe("Alex");
    expect(payload.isCreator).toBe(true);
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("refreshes a room session without creating a new participant identity", async () => {
    const { service } = createService();
    const room = await service.createRoom();
    const join = await service.joinRoom(room.slug, " Alex ", room.roomSessionToken);

    const refresh = await service.refreshRoomSession(room.slug, join.participantId, join.roomSessionToken);
    const [, encodedPayload] = refresh.token.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString("utf8")) as {
      roomId: string;
      participantId: string;
      displayName: string;
      isCreator: boolean;
      exp: number;
    };

    expect(refresh.signalingUrl).toBe("ws://signaling.test/ws");
    expect(payload.roomId).toBe(room.roomId);
    expect(payload.participantId).toBe(join.participantId);
    expect(payload.displayName).toBe("Alex");
    expect(payload.isCreator).toBe(true);
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects refresh when the room session token is invalid", async () => {
    const { service } = createService();
    const room = await service.createRoom();
    const join = await service.joinRoom(room.slug, "Alex", room.roomSessionToken);

    await expect(service.refreshRoomSession(room.slug, join.participantId, "wrong-token")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "INVALID_TOKEN" }),
    });
  });

  it("rejects refresh for closed rooms", async () => {
    const { repository, service } = createService();
    const room = await service.createRoom();
    const join = await service.joinRoom(room.slug, "Alex", room.roomSessionToken);
    const stored = await repository.getRoomBySlug(room.slug);
    repository.rooms.set(stored.roomId, {
      ...stored,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      status: "closed",
      closedReason: "closed_by_creator",
    });

    await expect(service.refreshRoomSession(room.slug, join.participantId, join.roomSessionToken)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "ROOM_CLOSED" }),
    });
  });
});
