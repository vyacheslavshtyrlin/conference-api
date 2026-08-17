import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import type { RoomMetadata } from "#contracts";
import { validateApiConfig, type ApiConfig } from "../config/api-config.js";
import { roomNotFound } from "./room-errors.js";
import type {
  AdmissionRecord,
  ConsumeAdmissionCommand,
  CreateRoomRecord,
  IntegrationRoomOwnerRecord,
  JoinRequestRecord,
  RoomSessionRecord,
} from "./room.repository.js";
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
  readonly joinRequests = new Map<string, JoinRequestRecord>();
  readonly admissions = new Map<string, AdmissionRecord>();

  async createRoom(record: CreateRoomRecord): Promise<RoomMetadata> {
    const room: RoomMetadata = { ...record, accessPolicy: record.accessPolicy ?? "link", status: "active", closedReason: null, recordingRequested: record.recordingRequested ?? false };
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

  async getRoomById(roomId: string): Promise<RoomMetadata> {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw roomNotFound();
    }
    return room;
  }

  async getIntegrationRoomOwner(): Promise<IntegrationRoomOwnerRecord | undefined> {
    return undefined;
  }
  async getIntegrationRoomOwnerByRecordingId(): Promise<IntegrationRoomOwnerRecord | undefined> {
    return undefined;
  }
  async getRecordingControlState() {
    return "requested" as const;
  }
  async activateRecording() {
    return "capturing" as const;
  }
  async closeRecordingInputs() {
    return "inactive" as const;
  }

  async createAdmission(record: AdmissionRecord): Promise<void> {
    this.admissions.set(record.codeHash, record);
  }

  async consumeAdmission(_command: ConsumeAdmissionCommand): Promise<{ room: RoomMetadata; session: RoomSessionRecord }> {
    throw new Error("Not used by room service tests");
  }

  async createJoinRequest(record: JoinRequestRecord): Promise<void> {
    this.joinRequests.set(`${record.roomId}:${record.requestId}`, record);
  }

  async getJoinRequest(roomId: string, requestId: string): Promise<JoinRequestRecord | undefined> {
    return this.joinRequests.get(`${roomId}:${requestId}`);
  }

  async listPendingJoinRequests(roomId: string): Promise<JoinRequestRecord[]> {
    return Array.from(this.joinRequests.values()).filter(
      (request) => request.roomId === roomId && request.status === "pending" && Date.parse(request.expiresAt) > Date.now()
    );
  }

  async decideJoinRequest(
    roomId: string,
    requestId: string,
    status: "approved" | "denied",
    decidedByParticipantId: string
  ): Promise<JoinRequestRecord> {
    const request = this.joinRequests.get(`${roomId}:${requestId}`);
    if (!request) throw roomNotFound();
    const next = { ...request, status, decidedByParticipantId, decidedAt: new Date().toISOString() };
    this.joinRequests.set(`${roomId}:${requestId}`, next);
    return next;
  }

  async fulfillApprovedJoinRequest(
    roomId: string,
    requestId: string,
    participantId: string,
    tokenHash: string,
    session: RoomSessionRecord,
    sessionExpiresAt: string | null
  ): Promise<JoinRequestRecord> {
    const request = this.joinRequests.get(`${roomId}:${requestId}`);
    if (!request) throw roomNotFound();
    const next = { ...request, approvedParticipantId: participantId, approvedTokenHash: tokenHash };
    this.joinRequests.set(`${roomId}:${requestId}`, next);
    await this.saveRoomSession(roomId, session, sessionExpiresAt);
    return next;
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

function createService(overrides: NodeJS.ProcessEnv = {}) {
  const repository = new InMemoryRoomRepository();
  const config = new ConfigService<ApiConfig, true>(validateApiConfig({
    NODE_ENV: "test",
    JOIN_TOKEN_SECRET: "test-secret",
    WEB_PUBLIC_URL: "http://web.test",
    SIGNALING_PUBLIC_URL: "ws://signaling.test/ws",
    ...overrides,
  }));
  const tokenService = new RoomTokenService(config);

  return {
    repository,
    service: new RoomsService(repository, tokenService, config),
    tokenService,
  };
}

const trustedCookieIdentity = {
  kind: "authenticated" as const,
  source: "trusted_cookie" as const,
  externalSubject: "users:42",
  displayName: "Trusted User",
};

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

  it("requires creator approval before a guest can join a private room", async () => {
    const { service } = createService();
    const room = await service.createRoom({ accessPolicy: "approval" });

    await expect(service.joinRoom(room.slug, "Sam")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "APPROVAL_REQUIRED" }),
    });

    const request = await service.createJoinRequest(room.slug, "Sam");
    await expect(service.listJoinRequests(room.slug, room.participantId, room.roomSessionToken)).resolves.toMatchObject({
      requests: [{ requestId: request.requestId, displayName: "Sam" }],
    });
    await expect(
      service.decideJoinRequest(room.slug, request.requestId, room.participantId, room.roomSessionToken, "approve")
    ).resolves.toMatchObject({ requestId: request.requestId, status: "approved" });

    const status = await service.getJoinRequestStatus(room.slug, request.requestId, request.requestToken);
    expect(status).toMatchObject({
      requestId: request.requestId,
      status: "approved",
      displayName: "Sam",
      isCreator: false,
      participantId: expect.stringMatching(/^peer_/),
      roomSessionToken: expect.any(String),
    });

    await expect(service.joinRoom(room.slug, "Sam", status.roomSessionToken)).resolves.toMatchObject({
      participantId: status.participantId,
      isCreator: false,
      roomSessionToken: status.roomSessionToken,
      token: expect.any(String),
    });
  });

  it("lets a private room creator issue a one-time room admission entry link", async () => {
    const { repository, service, tokenService } = createService();
    const room = await service.createRoom({ accessPolicy: "approval" });

    const admission = await service.createRoomAdmission(room.slug, room.participantId, room.roomSessionToken);
    const code = new URL(admission.entryUrl).hash.replace("#code=", "");
    const stored = repository.admissions.get(tokenService.hashAdmissionCode(code));

    expect(admission.entryUrl).toMatch(new RegExp(`^http://web\\.test/r/${room.slug}#code=`));
    expect(admission.entryUrl).not.toContain(room.roomSessionToken);
    expect(stored).toMatchObject({
      roomId: room.roomId,
      identity: {
        kind: "guest",
        source: "room_admission",
      },
      roomControls: "none",
      expiresAt: admission.expiresAt,
    });
    expect(stored?.integrationId).toBeUndefined();
  });

  it("does not issue room admission links for public rooms", async () => {
    const { service } = createService();
    const room = await service.createRoom({ accessPolicy: "link" });

    await expect(service.createRoomAdmission(room.slug, room.participantId, room.roomSessionToken)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "APPROVAL_REQUIRED" }),
    });
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

  it("preserves an admission-backed trusted display name when Join sends a different browser name", async () => {
    const { repository, service, tokenService } = createService();
    const room = await service.createRoom();
    const rawAdmissionSessionToken = tokenService.createRoomSessionToken();
    const participantId = "peer_admission";
    await repository.saveRoomSession(
      room.roomId,
      {
        participantId,
        displayName: "Trusted Participant",
        isCreator: true,
        tokenHash: tokenService.hashRoomSessionToken(rawAdmissionSessionToken),
        createdAt: new Date().toISOString(),
        identity: {
          kind: "authenticated",
          source: "integration_admission",
          integrationId: "crm-alpha",
          externalSubject: "crm-user-42",
        },
      },
      room.expiresAt
    );

    const join = await service.joinRoom(room.slug, "Spoofed Browser Name", rawAdmissionSessionToken);
    const [, encodedPayload] = join.token.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString("utf8")) as {
      displayName: string;
      participantId: string;
      isCreator: boolean;
    };
    const storedSession = await repository.getRoomSession(room.roomId, participantId);

    expect(join).toMatchObject({ participantId, isCreator: true });
    expect(payload).toMatchObject({
      participantId,
      displayName: "Trusted Participant",
      isCreator: true,
    });
    expect(storedSession).toMatchObject({
      displayName: "Trusted Participant",
      identity: {
        source: "integration_admission",
        externalSubject: "crm-user-42",
      },
    });
  });

  it("stores trusted identity on the creator session when cookie auth resolves one", async () => {
    const { repository, service } = createService();
    const room = await service.createRoom({ accessPolicy: "approval" }, trustedCookieIdentity);
    const storedSession = await repository.getRoomSession(room.roomId, room.participantId);

    expect(room.displayName).toBe("Trusted User");
    expect(storedSession).toMatchObject({
      displayName: "Trusted User",
      identity: {
        kind: "authenticated",
        source: "trusted_cookie",
        externalSubject: "users:42",
      },
    });

    const join = await service.joinRoom(room.slug, "Spoofed Name", room.roomSessionToken);
    const [, encodedPayload] = join.token.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString("utf8")) as {
      displayName: string;
    };
    expect(payload.displayName).toBe("Trusted User");
  });

  it("allows anonymous browser room creation and guest joins without auth cookie configuration", async () => {
    const { service } = createService();
    const room = await service.createRoom();

    await expect(service.joinRoom(room.slug, "Guest")).resolves.toMatchObject({
      isCreator: false,
      participantId: expect.stringMatching(/^peer_/),
    });
  });

  it("preserves trusted-cookie identity through private approval requests", async () => {
    const { repository, service } = createService();
    const room = await service.createRoom({ accessPolicy: "approval" });
    const request = await service.createJoinRequest(room.slug, "Browser Name", trustedCookieIdentity);
    const storedRequest = await repository.getJoinRequest(room.roomId, request.requestId);

    expect(request.displayName).toBe("Trusted User");
    expect(storedRequest).toMatchObject({
      displayName: "Trusted User",
      identity: {
        kind: "authenticated",
        source: "trusted_cookie",
        externalSubject: "users:42",
      },
    });

    await service.decideJoinRequest(room.slug, request.requestId, room.participantId, room.roomSessionToken, "approve");
    const status = await service.getJoinRequestStatus(room.slug, request.requestId, request.requestToken);
    const join = await service.joinRoom(room.slug, "Spoofed After Approval", status.roomSessionToken);
    const storedSession = await repository.getRoomSession(room.roomId, join.participantId);

    expect(join.participantId).toBe(status.participantId);
    expect(storedSession).toMatchObject({
      displayName: "Trusted User",
      identity: {
        source: "trusted_cookie",
        externalSubject: "users:42",
      },
    });
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
