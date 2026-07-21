import { ConfigService } from "@nestjs/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRealRedisHarness, realRedisTestsEnabled, type RealRedisHarness } from "../test/realRedisHarness.js";
import { RedisRoomRepository } from "./room.repository.js";
import { RoomTokenService } from "./room-token.service.js";

const describeRealRedis = realRedisTestsEnabled() ? describe : describe.skip;
const waitForKeyToDisappear = async (harness: RealRedisHarness, key: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await harness.raw.exists(key)) === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for Redis key to expire: ${key}`);
};

describeRealRedis("RedisRoomRepository with real Redis", () => {
  let harness: RealRedisHarness | undefined;
  let repository: RedisRoomRepository;

  beforeEach(async () => {
    harness = await createRealRedisHarness();
    repository = new RedisRoomRepository(harness.redis);
  });

  afterEach(async () => {
    await harness?.close();
  });

  const requireHarness = (): RealRedisHarness => {
    if (!harness) {
      throw new Error("Real Redis harness was not initialized");
    }
    return harness;
  };

  it("writes, reads, expires and cleans up isolated room/session state without raw tokens", async () => {
    const real = requireHarness();
    const roomId = "room_real_redis";
    const slug = "realredis";
    const tokenService = new RoomTokenService(new ConfigService({ ROOM_SESSION_TOKEN_SECRET: "test-room-session-secret" }));
    const rawRoomSessionToken = tokenService.createRoomSessionToken();
    const tokenHash = tokenService.hashRoomSessionToken(rawRoomSessionToken);
    const expiresAt = new Date(Date.now() + 1_000).toISOString();

    await repository.createRoom({
      roomId,
      slug,
      mediaNodeId: "local",
      signalingUrl: "ws://localhost:4000/ws",
      createdAt: new Date().toISOString(),
      expiresAt,
    });
    await repository.saveRoomSession(roomId, {
      participantId: "peer_real_redis",
      displayName: "Alex",
      isCreator: true,
      tokenHash,
      createdAt: new Date().toISOString(),
    }, expiresAt);

    await expect(repository.getRoomBySlug(slug)).resolves.toMatchObject({ roomId, slug, expiresAt });
    await expect(repository.findRoomSessionByTokenHash(roomId, tokenHash)).resolves.toMatchObject({
      participantId: "peer_real_redis",
      isCreator: true,
    });

    const sessionKey = real.key(`room:${roomId}:sessions`);
    const tokenIndexKey = real.key(`room_session_token:${tokenHash}`);
    expect(await real.raw.pTTL(sessionKey)).toBeGreaterThan(0);
    expect(await real.raw.pTTL(tokenIndexKey)).toBeGreaterThan(0);

    const values = await real.raw.hVals(sessionKey);
    expect(JSON.stringify(values)).not.toContain(rawRoomSessionToken);
    await expect(real.raw.get(tokenIndexKey)).resolves.toBe(JSON.stringify({ roomId, participantId: "peer_real_redis" }));
    await expect(repository.findRoomSessionByTokenHash(roomId, tokenHash)).resolves.toMatchObject({
      participantId: "peer_real_redis",
      isCreator: true,
    });

    await waitForKeyToDisappear(real, sessionKey);

    await real.cleanup();
    const remaining: string[] = [];
    for await (const found of real.raw.scanIterator({ MATCH: "conference:e6:*" })) {
      remaining.push(...found);
    }
    expect(remaining).toEqual([]);
  });

  it("proves the isolated harness can write, read, expire and clean Redis keys", async () => {
    const real = requireHarness();
    await real.redis.setEx("baseline:ttl", 1, "value");
    await expect(real.redis.get("baseline:ttl")).resolves.toBe("value");

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(real.redis.get("baseline:ttl")).resolves.toBeNull();

    await real.cleanup();
  });
});
