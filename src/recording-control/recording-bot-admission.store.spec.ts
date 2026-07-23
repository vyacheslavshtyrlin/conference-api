import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { REDIS_CLIENT } from "../redis/redis.constants.js";
import type { RedisClient } from "../redis/redis.types.js";
import { RecordingBotAdmissionStore, type RecordingBotAdmissionMarker } from "./recording-bot-admission.store.js";

class AdmissionRedis {
  private readonly values = new Map<string, { value: string; expiresAt: number }>();

  async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    const key = options.keys[0]!;
    if (options.arguments.length === 2) {
      const ttl = Number(options.arguments[1]);
      if (ttl <= 0) return "expired";
      const existing = this.values.get(key);
      if (existing && existing.expiresAt > Date.now()) return "exists";
      this.values.set(key, { value: options.arguments[0]!, expiresAt: Date.now() + ttl });
      return "issued";
    }

    const entry = this.values.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return "rejected";
    const marker = JSON.parse(entry.value) as RecordingBotAdmissionMarker;
    if (marker.consumedAt || marker.roomId !== options.arguments[0] || marker.recordingId !== options.arguments[1] || marker.mediaNodeId !== options.arguments[2]) return "rejected";
    marker.consumedAt = options.arguments[3];
    entry.value = JSON.stringify(marker);
    return "consumed";
  }
}

const marker: RecordingBotAdmissionMarker = {
  roomId: "room_test",
  recordingId: "rec_test",
  mediaNodeId: "local",
  issuedAt: "2026-07-22T10:00:00.000Z",
  expiresAt: "2026-07-22T10:01:00.000Z",
};

describe("RecordingBotAdmissionStore", () => {
  it("atomically rejects replay after the first matching consume", async () => {
    const module = await Test.createTestingModule({
      providers: [RecordingBotAdmissionStore, { provide: REDIS_CLIENT, useValue: new AdmissionRedis() as unknown as RedisClient }],
    }).compile();
    const store = module.get(RecordingBotAdmissionStore);
    await expect(store.issue("hash", marker, 60_000)).resolves.toBe(true);
    await expect(store.consume("hash", marker)).resolves.toBe(true);
    await expect(store.consume("hash", marker)).resolves.toBe(false);
  });

  it("rejects expired and cross-room, recording or node markers", async () => {
    const module = await Test.createTestingModule({
      providers: [RecordingBotAdmissionStore, { provide: REDIS_CLIENT, useValue: new AdmissionRedis() as unknown as RedisClient }],
    }).compile();
    const store = module.get(RecordingBotAdmissionStore);
    await expect(store.issue("expired", marker, 0)).resolves.toBe(false);
    await expect(store.consume("expired", marker)).resolves.toBe(false);
    for (const [hash, expected] of [
      ["room", { ...marker, roomId: "room_other" }],
      ["recording", { ...marker, recordingId: "rec_other" }],
      ["node", { ...marker, mediaNodeId: "node_other" }],
    ] as const) {
      await store.issue(hash, marker, 60_000);
      await expect(store.consume(hash, expected)).resolves.toBe(false);
    }
  });
});
