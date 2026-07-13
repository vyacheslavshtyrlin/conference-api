import { describe, expect, it } from "vitest";

import { RedisRoomRepository } from "./room.repository.js";

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly hashes = new Map<string, Map<string, string>>();

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
  async pExpire(): Promise<number> { return 1; }
  async eval(): Promise<unknown> { return undefined; }
}

describe("RedisRoomRepository media lease liveness", () => {
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
