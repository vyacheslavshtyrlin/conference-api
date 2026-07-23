import { Inject, Injectable } from "@nestjs/common";
import { REDIS_CLIENT } from "../redis/redis.constants.js";
import type { RedisClient } from "../redis/redis.types.js";

export type RecordingBotAdmissionMarker = {
  roomId: string;
  recordingId: string;
  mediaNodeId: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
};

@Injectable()
export class RecordingBotAdmissionStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  async issue(jtiHash: string, marker: RecordingBotAdmissionMarker, ttlMilliseconds: number): Promise<boolean> {
    const result = await this.redis.eval(ISSUE_BOT_ADMISSION_SCRIPT, {
      keys: [this.key(jtiHash)],
      arguments: [JSON.stringify(marker), String(ttlMilliseconds)],
    });
    return result === "issued";
  }

  async consume(
    jtiHash: string,
    expected: Pick<RecordingBotAdmissionMarker, "roomId" | "recordingId" | "mediaNodeId">
  ): Promise<boolean> {
    const result = await this.redis.eval(CONSUME_BOT_ADMISSION_SCRIPT, {
      keys: [this.key(jtiHash)],
      arguments: [expected.roomId, expected.recordingId, expected.mediaNodeId, new Date().toISOString()],
    });
    return result === "consumed";
  }

  private key(jtiHash: string): string {
    return `recording_bot_admission:${jtiHash}`;
  }
}

const ISSUE_BOT_ADMISSION_SCRIPT = `
local ttl_ms = tonumber(ARGV[2])
if ttl_ms == nil or ttl_ms <= 0 then return "expired" end
local created = redis.call("SET", KEYS[1], ARGV[1], "PX", ttl_ms, "NX")
if not created then return "exists" end
return "issued"
`;

const CONSUME_BOT_ADMISSION_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return "rejected" end
local ttl_ms = redis.call("PTTL", KEYS[1])
if ttl_ms <= 0 then return "rejected" end
local marker = cjson.decode(raw)
if marker["consumedAt"] then return "rejected" end
if marker["roomId"] ~= ARGV[1] or marker["recordingId"] ~= ARGV[2] or marker["mediaNodeId"] ~= ARGV[3] then return "rejected" end
marker["consumedAt"] = ARGV[4]
redis.call("SET", KEYS[1], cjson.encode(marker), "PX", ttl_ms)
return "consumed"
`;
