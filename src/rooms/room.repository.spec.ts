import { describe, expect, it } from "vitest";

import { IntegrationRoomConflictError, RedisRoomRepository } from "./room.repository.js";

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly expirations = new Map<string, number>();

  async del(key: string): Promise<number> {
    const existed = this.values.delete(key);
    return existed ? 1 : 0;
  }
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async set(key: string, value: string): Promise<string | null> { this.values.set(key, value); return "OK"; }
  async setEx(key: string, _seconds: number, value: string): Promise<string | null> { return this.set(key, value); }
  async hGet(key: string, field: string): Promise<string | null> { return this.hashes.get(key)?.get(field) ?? null; }
  async hLen(key: string): Promise<number> { return this.hashes.get(key)?.size ?? 0; }
  async hSet(key: string, field: string, value: string): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    this.hashes.set(key, hash);
    hash.set(field, value);
    return 1;
  }
  async hVals(key: string): Promise<string[]> { return [...(this.hashes.get(key)?.values() ?? [])]; }
  async pExpire(key: string, milliseconds: number): Promise<number> {
    this.expirations.set(key, milliseconds);
    return 1;
  }
  async pTTL(key: string): Promise<number> {
    if (!this.values.has(key) && !this.hashes.has(key)) return -2;
    return this.expirations.get(key) ?? -1;
  }
  async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    if (options.arguments.length === 3) return this.evalCreateAdmission(options);
    if (options.arguments.length === 4) return this.evalConsumeAdmission(options);
    return this.evalCreateRoom(options);
  }

  private evalCreateRoom(options: { keys: string[]; arguments: string[] }): string {
    const [roomKey, slugKey, externalKey, ownerKey] = options.keys;
    const [roomJson, roomId, ttlMsText, hasIntegrationText, requestHash, mappingJson] = options.arguments;
    if (!roomKey || !slugKey || !roomJson || !roomId || !ttlMsText || !hasIntegrationText || requestHash === undefined) {
      return JSON.stringify({ status: "room_conflict" });
    }
    const ttlMs = Number(ttlMsText);
    const hasIntegration = hasIntegrationText === "1";
    const result = (status: string, room?: string) => JSON.stringify(room ? { status, room } : { status });
    const existingRoom = (mappingRaw: string): { room?: string; conflict?: boolean } => {
      const mapping = JSON.parse(mappingRaw) as { requestHash: string; roomId: string };
      if (mapping.requestHash !== requestHash) {
        return { conflict: true };
      }
      const room = this.values.get(`room:${mapping.roomId}`);
      return room ? { room } : {};
    };

    if (!roomKey || !slugKey || !roomJson || !roomId) {
      return result("room_conflict");
    }

    if (hasIntegration && externalKey && ownerKey && mappingJson) {
      const externalRaw = this.values.get(externalKey);
      if (externalRaw) {
        const existing = existingRoom(externalRaw);
        if (existing.conflict) return result("external_conflict");
        if (existing.room) return result("existing", existing.room);
      }
    }

    if (this.values.has(roomKey) || this.values.has(slugKey)) {
      return result("room_conflict");
    }

    this.values.set(roomKey, roomJson);
    this.values.set(slugKey, roomId);
    if (ttlMs > 0) {
      this.expirations.set(roomKey, ttlMs);
      this.expirations.set(slugKey, ttlMs);
    }

    if (hasIntegration && externalKey && ownerKey && mappingJson) {
      this.values.set(externalKey, mappingJson);
      this.values.set(ownerKey, mappingJson);
      if (ttlMs > 0) {
        this.expirations.set(externalKey, ttlMs);
        this.expirations.set(ownerKey, ttlMs);
      }
    }

    return result("created", roomJson);
  }

  private evalCreateAdmission(options: { keys: string[]; arguments: string[] }): string {
    const [admissionKey, roomKey, ownerKey] = options.keys;
    const [admissionJson, ttlMsText, integrationId] = options.arguments;
    if (!admissionKey || !roomKey || !ownerKey || !admissionJson || !ttlMsText || integrationId === undefined) {
      return "room_not_found";
    }
    const roomRaw = this.values.get(roomKey);
    if (!roomRaw) return "room_not_found";
    const room = JSON.parse(roomRaw) as { status?: string };
    if (room.status === "closed") return "room_closed";
    if (integrationId) {
      const ownerRaw = this.values.get(ownerKey);
      if (!ownerRaw) return "forbidden";
      const owner = JSON.parse(ownerRaw) as { integrationId?: string };
      if (owner.integrationId !== integrationId) return "forbidden";
    }
    const ttlMs = Number(ttlMsText);
    this.values.set(admissionKey, admissionJson);
    if (ttlMs > 0) this.expirations.set(admissionKey, ttlMs);
    return "created";
  }

  private evalConsumeAdmission(options: { keys: string[]; arguments: string[] }): string {
    const [admissionKey, tokenIndexKey] = options.keys;
    const [expectedRoomId, sessionJson, tokenIndexJson, sessionTtlMsText] = options.arguments;
    if (!admissionKey || !tokenIndexKey || expectedRoomId === undefined || !sessionJson || !tokenIndexJson || !sessionTtlMsText) {
      return JSON.stringify({ status: "invalid" });
    }
    const admissionRaw = this.values.get(admissionKey);
    const admissionTtl = this.expirations.get(admissionKey) ?? -1;
    if (!admissionRaw || admissionTtl <= 0) return JSON.stringify({ status: "invalid" });
    const admission = JSON.parse(admissionRaw) as {
      roomId: string;
      integrationId?: string;
      consumedAt?: string;
      identity: {
        kind: "guest" | "authenticated";
        source: "integration_admission" | "room_admission";
        externalSubject?: string;
        displayName?: string | null;
        avatarUrl?: string;
      };
      roomControls: "creator" | "none";
    };
    if (admission.consumedAt || (expectedRoomId && admission.roomId !== expectedRoomId)) {
      return JSON.stringify({ status: "invalid" });
    }
    const roomKey = `room:${admission.roomId}`;
    const roomRaw = this.values.get(roomKey);
    if (!roomRaw) return JSON.stringify({ status: "invalid" });
    const room = JSON.parse(roomRaw) as { status?: string };
    if (room.status === "closed") return JSON.stringify({ status: "room_closed" });

    const session = JSON.parse(sessionJson) as Record<string, unknown>;
    session.displayName = admission.identity.displayName ?? null;
    session.isCreator = admission.roomControls === "creator";
    session.identity = admission.identity.source === "integration_admission" ? {
      kind: admission.identity.kind,
      source: "integration_admission",
      integrationId: admission.integrationId,
      externalSubject: admission.identity.externalSubject,
      avatarUrl: admission.identity.avatarUrl,
    } : {
      kind: "guest",
      source: "room_admission",
    };
    const nextSessionJson = JSON.stringify(session);
    const sessionsKey = `room:${admission.roomId}:sessions`;
    const hash = this.hashes.get(sessionsKey) ?? new Map<string, string>();
    this.hashes.set(sessionsKey, hash);
    hash.set(String(session.participantId), nextSessionJson);
    this.values.set(tokenIndexKey, JSON.stringify({ ...JSON.parse(tokenIndexJson), roomId: admission.roomId }));
    const sessionTtlMs = Math.min(Number(sessionTtlMsText), admissionTtl);
    this.expirations.set(sessionsKey, sessionTtlMs);
    this.expirations.set(tokenIndexKey, sessionTtlMs);
    this.values.set(admissionKey, JSON.stringify({ ...admission, consumedAt: "1" }));
    this.expirations.set(admissionKey, admissionTtl);
    return JSON.stringify({ status: "consumed", room: roomRaw, session: nextSessionJson });
  }
}

describe("RedisRoomRepository media lease liveness", () => {
  it("applies the empty-room deadline to room metadata, slug lookup, session and token index", async () => {
    const redis = new FakeRedis();
    const repository = new RedisRoomRepository(redis);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const tokenHash = "hash_1";

    await repository.createRoom({
      roomId: "room_1",
      slug: "slug1",
      mediaNodeId: "local",
      signalingUrl: "ws://localhost:4000/ws",
      createdAt: new Date().toISOString(),
      expiresAt,
    });
    await repository.saveRoomSession(
      "room_1",
      {
        participantId: "peer_1",
        displayName: null,
        isCreator: true,
        tokenHash,
        createdAt: new Date().toISOString(),
      },
      expiresAt
    );

    expect(redis.expirations.get("room:room_1")).toBeGreaterThan(0);
    expect(redis.expirations.get("room_slug:slug1")).toBeGreaterThan(0);
    expect(redis.expirations.get("room:room_1:sessions")).toBeGreaterThan(0);
    expect(redis.expirations.get("room_session_token:hash_1")).toBeGreaterThan(0);
    expect(redis.values.get("room_session_token:hash_1")).toBe(
      JSON.stringify({ roomId: "room_1", participantId: "peer_1" })
    );
  });

  it("creates integration room mappings with the same room TTL and returns matching idempotent requests", async () => {
    const redis = new FakeRedis();
    const repository = new RedisRoomRepository(redis);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const first = await repository.createRoom(
      {
        roomId: "room_integration_1",
        slug: "slugint",
        mediaNodeId: "local",
        signalingUrl: "ws://localhost:4000/ws",
        createdAt: new Date().toISOString(),
        expiresAt,
      },
      {
        integration: {
          integrationId: "crm-alpha",
          externalRoomId: "external_hash",
          requestHash: "request_hash",
        },
      }
    );
    const second = await repository.createRoom(
      {
        roomId: "room_integration_2",
        slug: "otherint",
        mediaNodeId: "local",
        signalingUrl: "ws://localhost:4000/ws",
        createdAt: new Date().toISOString(),
        expiresAt,
      },
      {
        integration: {
          integrationId: "crm-alpha",
          externalRoomId: "external_hash",
          requestHash: "request_hash",
        },
      }
    );

    expect(second).toMatchObject({ roomId: first.roomId, slug: first.slug });
    expect(redis.expirations.get("integration_room:crm-alpha:external_hash")).toBeGreaterThan(0);
    expect(redis.expirations.get(`integration_room_owner:${first.roomId}`)).toBeGreaterThan(0);
  });

  it("atomically consumes an admission once and creates a trusted pending room session", async () => {
    const redis = new FakeRedis();
    const repository = new RedisRoomRepository(redis);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await repository.createRoom(
      {
        roomId: "room_admission_1",
        slug: "admit1",
        mediaNodeId: "local",
        signalingUrl: "ws://localhost:4000/ws",
        createdAt: new Date().toISOString(),
        expiresAt,
      },
      {
        integration: {
          integrationId: "crm-alpha",
          externalRoomId: "external_hash",
          requestHash: "request_hash",
        },
      }
    );
    await repository.createAdmission({
      roomId: "room_admission_1",
      integrationId: "crm-alpha",
      codeHash: "admission_hash",
      identity: {
        kind: "authenticated",
        source: "integration_admission",
        externalSubject: "crm-user-42",
        displayName: "Trusted Participant",
      },
      roomControls: "creator",
      createdAt: new Date().toISOString(),
      expiresAt,
    });

    const consumed = await repository.consumeAdmission({
      codeHash: "admission_hash",
      expectedRoomId: "room_admission_1",
      session: {
        participantId: "peer_admission_1",
        displayName: "__pending__",
        isCreator: false,
        tokenHash: "token_hash",
        createdAt: new Date().toISOString(),
      },
      sessionExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    expect(consumed.room).toMatchObject({ roomId: "room_admission_1", slug: "admit1" });
    expect(consumed.session).toMatchObject({
      participantId: "peer_admission_1",
      displayName: "Trusted Participant",
      isCreator: true,
      identity: {
        kind: "authenticated",
        source: "integration_admission",
        integrationId: "crm-alpha",
        externalSubject: "crm-user-42",
      },
    });
    expect(redis.expirations.get("admission:admission_hash")).toBeGreaterThan(0);
    expect(redis.expirations.get("room:room_admission_1:sessions")).toBeLessThanOrEqual(
      redis.expirations.get("admission:admission_hash") ?? 0
    );
    await expect(
      repository.consumeAdmission({
        codeHash: "admission_hash",
        session: {
          participantId: "peer_admission_2",
          displayName: "__pending__",
          isCreator: false,
          tokenHash: "token_hash_2",
          createdAt: new Date().toISOString(),
        },
        sessionExpiresAt: expiresAt,
      })
    ).rejects.toMatchObject({ response: { code: "INVALID_TOKEN" } });
  });

  it("atomically consumes a room admission into an unnamed non-creator pending session", async () => {
    const redis = new FakeRedis();
    const repository = new RedisRoomRepository(redis);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await repository.createRoom({
      roomId: "room_admission_private",
      slug: "priv1",
      accessPolicy: "approval",
      mediaNodeId: "local",
      signalingUrl: "ws://localhost:4000/ws",
      createdAt: new Date().toISOString(),
      expiresAt,
    });
    await repository.createAdmission({
      roomId: "room_admission_private",
      codeHash: "room_admission_hash",
      identity: {
        kind: "guest",
        source: "room_admission",
      },
      roomControls: "none",
      createdAt: new Date().toISOString(),
      expiresAt,
    });

    const consumed = await repository.consumeAdmission({
      codeHash: "room_admission_hash",
      expectedRoomId: "room_admission_private",
      session: {
        participantId: "peer_room_admission",
        displayName: null,
        isCreator: false,
        tokenHash: "room_token_hash",
        createdAt: new Date().toISOString(),
      },
      sessionExpiresAt: expiresAt,
    });

    expect(consumed.room).toMatchObject({ roomId: "room_admission_private", slug: "priv1" });
    expect(consumed.session).toMatchObject({
      participantId: "peer_room_admission",
      displayName: null,
      isCreator: false,
      identity: {
        kind: "guest",
        source: "room_admission",
      },
    });
  });

  it("rejects wrong-room admission exchange before creating a session", async () => {
    const redis = new FakeRedis();
    const repository = new RedisRoomRepository(redis);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await repository.createRoom(
      {
        roomId: "room_admission_2",
        slug: "admit2",
        mediaNodeId: "local",
        signalingUrl: "ws://localhost:4000/ws",
        createdAt: new Date().toISOString(),
        expiresAt,
      },
      {
        integration: {
          integrationId: "crm-alpha",
          externalRoomId: "external_hash_2",
          requestHash: "request_hash",
        },
      }
    );
    await repository.createAdmission({
      roomId: "room_admission_2",
      integrationId: "crm-alpha",
      codeHash: "wrong_room_hash",
      identity: {
        kind: "guest",
        source: "integration_admission",
        externalSubject: "crm-guest-42",
        displayName: "Guest Participant",
      },
      roomControls: "none",
      createdAt: new Date().toISOString(),
      expiresAt,
    });

    await expect(
      repository.consumeAdmission({
        codeHash: "wrong_room_hash",
        expectedRoomId: "room_other",
        session: {
          participantId: "peer_wrong_room",
          displayName: "__pending__",
          isCreator: false,
          tokenHash: "token_hash",
          createdAt: new Date().toISOString(),
        },
        sessionExpiresAt: expiresAt,
      })
    ).rejects.toMatchObject({ response: { code: "INVALID_TOKEN" } });
    expect(redis.hashes.get("room:room_admission_2:sessions")).toBeUndefined();
  });

  it("rejects expired admission records before creating a session", async () => {
    const redis = new FakeRedis();
    const repository = new RedisRoomRepository(redis);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await repository.createRoom(
      {
        roomId: "room_admission_expired",
        slug: "admitexp",
        mediaNodeId: "local",
        signalingUrl: "ws://localhost:4000/ws",
        createdAt: new Date().toISOString(),
        expiresAt,
      },
      {
        integration: {
          integrationId: "crm-alpha",
          externalRoomId: "external_hash_expired",
          requestHash: "request_hash",
        },
      }
    );
    await repository.createAdmission({
      roomId: "room_admission_expired",
      integrationId: "crm-alpha",
      codeHash: "expired_hash",
      identity: {
        kind: "guest",
        source: "integration_admission",
        externalSubject: "crm-guest-expired",
        displayName: "Expired Guest",
      },
      roomControls: "none",
      createdAt: new Date().toISOString(),
      expiresAt,
    });
    redis.expirations.set("admission:expired_hash", 0);

    await expect(
      repository.consumeAdmission({
        codeHash: "expired_hash",
        session: {
          participantId: "peer_expired",
          displayName: "__pending__",
          isCreator: false,
          tokenHash: "token_hash",
          createdAt: new Date().toISOString(),
        },
        sessionExpiresAt: expiresAt,
      })
    ).rejects.toMatchObject({ response: { code: "INVALID_TOKEN" } });
    expect(redis.hashes.get("room:room_admission_expired:sessions")).toBeUndefined();
  });

  it("rejects closed-room admission exchange before creating a session", async () => {
    const redis = new FakeRedis();
    const repository = new RedisRoomRepository(redis);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await repository.createRoom(
      {
        roomId: "room_admission_closed",
        slug: "admitclosed",
        mediaNodeId: "local",
        signalingUrl: "ws://localhost:4000/ws",
        createdAt: new Date().toISOString(),
        expiresAt,
      },
      {
        integration: {
          integrationId: "crm-alpha",
          externalRoomId: "external_hash_closed",
          requestHash: "request_hash",
        },
      }
    );
    await repository.createAdmission({
      roomId: "room_admission_closed",
      integrationId: "crm-alpha",
      codeHash: "closed_hash",
      identity: {
        kind: "authenticated",
        source: "integration_admission",
        externalSubject: "crm-user-closed",
        displayName: "Closed User",
      },
      roomControls: "creator",
      createdAt: new Date().toISOString(),
      expiresAt,
    });
    redis.values.set(
      "room:room_admission_closed",
      JSON.stringify({
        roomId: "room_admission_closed",
        slug: "admitclosed",
        mediaNodeId: "local",
        signalingUrl: "ws://localhost:4000/ws",
        createdAt: new Date().toISOString(),
        expiresAt,
        status: "closed",
        closedReason: "closed_by_creator",
      })
    );

    await expect(
      repository.consumeAdmission({
        codeHash: "closed_hash",
        session: {
          participantId: "peer_closed",
          displayName: "__pending__",
          isCreator: false,
          tokenHash: "token_hash",
          createdAt: new Date().toISOString(),
        },
        sessionExpiresAt: expiresAt,
      })
    ).rejects.toMatchObject({ response: { code: "ROOM_CLOSED" } });
    expect(redis.hashes.get("room:room_admission_closed:sessions")).toBeUndefined();
  });

  it("does not extend an integration external-room mapping on an equivalent retry", async () => {
    const redis = new FakeRedis();
    const repository = new RedisRoomRepository(redis);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    await repository.createRoom(
      {
        roomId: "room_integration_1",
        slug: "slugint",
        mediaNodeId: "local",
        signalingUrl: "ws://localhost:4000/ws",
        createdAt: new Date().toISOString(),
        expiresAt,
      },
      {
        integration: {
          integrationId: "crm-alpha",
          externalRoomId: "external_hash",
          requestHash: "request_hash",
        },
      }
    );
    redis.expirations.set("integration_room:crm-alpha:external_hash", 12_345);

    await repository.createRoom(
      {
        roomId: "room_integration_2",
        slug: "otherint",
        mediaNodeId: "local",
        signalingUrl: "ws://localhost:4000/ws",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
      {
        integration: {
          integrationId: "crm-alpha",
          externalRoomId: "external_hash",
          requestHash: "request_hash",
        },
      }
    );

    expect(redis.expirations.get("integration_room:crm-alpha:external_hash")).toBe(12_345);
  });

  it("rejects a conflicting integration external-room mapping", async () => {
    const redis = new FakeRedis();
    const repository = new RedisRoomRepository(redis);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const base = {
      mediaNodeId: "local",
      signalingUrl: "ws://localhost:4000/ws",
      createdAt: new Date().toISOString(),
      expiresAt,
    };

    await repository.createRoom(
      { ...base, roomId: "room_integration_1", slug: "slugone" },
      {
        integration: {
          integrationId: "crm-alpha",
          externalRoomId: "external_hash",
          requestHash: "request_hash",
        },
      }
    );

    await expect(
      repository.createRoom(
        { ...base, roomId: "room_integration_2", slug: "slugtwo" },
        {
          integration: {
            integrationId: "crm-alpha",
            externalRoomId: "external_hash",
            requestHash: "different_hash",
          },
        }
      )
    ).rejects.toMatchObject({ kind: "external_conflict" satisfies IntegrationRoomConflictError["kind"] });

    await expect(
      repository.createRoom(
        { ...base, roomId: "room_integration_3", slug: "slugthree" },
        {
          integration: {
            integrationId: "crm-alpha",
            externalRoomId: "other_external_hash",
            requestHash: "different_hash",
          },
        }
      )
    ).resolves.toMatchObject({ roomId: "room_integration_3" });
  });

  it("resolves room sessions through the direct token index without accepting stale token hashes", async () => {
    const redis = new FakeRedis();
    const repository = new RedisRoomRepository(redis);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    await repository.saveRoomSession(
      "room_1",
      {
        participantId: "peer_1",
        displayName: "Alex",
        isCreator: true,
        tokenHash: "current_hash",
        createdAt: new Date().toISOString(),
      },
      expiresAt
    );
    await repository.saveRoomSession(
      "room_1",
      {
        participantId: "peer_1",
        displayName: "Alex",
        isCreator: true,
        tokenHash: "rotated_hash",
        createdAt: new Date().toISOString(),
      },
      expiresAt
    );
    await redis.set("room_session_token:stale_hash", JSON.stringify({ roomId: "room_1", participantId: "peer_1" }));

    expect(redis.values.has("room_session_token:current_hash")).toBe(false);
    await expect(repository.findRoomSessionByTokenHash("room_1", "rotated_hash")).resolves.toMatchObject({
      participantId: "peer_1",
      isCreator: true,
    });
    await expect(repository.findRoomSessionByTokenHash("room_1", "current_hash")).resolves.toBeUndefined();
    await expect(repository.findRoomSessionByTokenHash("room_1", "stale_hash")).resolves.toBeUndefined();
  });

  it("preserves an existing pending token-index TTL when saving the session while the room is live", async () => {
    const redis = new FakeRedis();
    const repository = new RedisRoomRepository(redis);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    await repository.saveRoomSession(
      "room_1",
      {
        participantId: "peer_1",
        displayName: null,
        isCreator: false,
        tokenHash: "pending_hash",
        createdAt: new Date().toISOString(),
      },
      expiresAt
    );
    const initialTtl = redis.expirations.get("room_session_token:pending_hash");

    await repository.saveRoomSession(
      "room_1",
      {
        participantId: "peer_1",
        displayName: "Sam",
        isCreator: false,
        tokenHash: "pending_hash",
        createdAt: new Date().toISOString(),
        identity: {
          kind: "guest",
          source: "room_admission",
        },
      },
      null
    );

    expect(redis.expirations.get("room_session_token:pending_hash")).toBe(initialTtl);
  });

  it("counts only participants stamped with the current unexpired media epoch", async () => {
    const redis = new FakeRedis();
    const repository = new RedisRoomRepository(redis);
    const participantsKey = "room:room_1:participants";
    await redis.set("media:lease", JSON.stringify({
      mediaEpoch: "epoch_current",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    await redis.hSet(participantsKey, "peer_current", JSON.stringify({ participant: { participantId: "peer_current" }, mediaEpoch: "epoch_current" }));
    await redis.hSet(participantsKey, "peer_stale", JSON.stringify({ participant: { participantId: "peer_stale" }, mediaEpoch: "epoch_stale" }));

    await expect(repository.getParticipantCount("room_1")).resolves.toBe(1);
    await expect(repository.hasLiveParticipant("room_1", "peer_current")).resolves.toBe(true);
    await expect(repository.hasLiveParticipant("room_1", "peer_stale")).resolves.toBe(false);
  });

  it("treats every participant as stale when the media lease expired", async () => {
    const redis = new FakeRedis();
    const repository = new RedisRoomRepository(redis);
    await redis.set("media:lease", JSON.stringify({
      mediaEpoch: "epoch_expired",
      issuedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    await redis.hSet("room:room_1:participants", "peer_1", JSON.stringify({ participant: { participantId: "peer_1" }, mediaEpoch: "epoch_expired" }));

    await expect(repository.getParticipantCount("room_1")).resolves.toBe(0);
  });
});
