import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

import type { RedisClient } from "../redis/redis.types.js";

type RawRedisClient = RedisClientType;

export type RealRedisHarness = {
  redis: RedisClient;
  raw: RawRedisClient;
  key(key: string): string;
  cleanup(): Promise<void>;
  close(): Promise<void>;
};

export function realRedisTestsEnabled(): boolean {
  return Boolean(process.env.TEST_REDIS_URL);
}

export async function createRealRedisHarness(): Promise<RealRedisHarness> {
  const url = process.env.TEST_REDIS_URL;
  if (!url) {
    throw new Error("TEST_REDIS_URL is required for real Redis tests");
  }

  const raw = createClient({ url });
  await raw.connect();

  const prefix = `conference:e6:${randomUUID()}`;
  const key = (value: string) => `${prefix}:${value}`;
  const redis: RedisClient = {
    del: (value) => raw.del(key(value)),
    get: (value) => raw.get(key(value)),
    set: (value, data) => raw.set(key(value), data),
    setEx: (value, seconds, data) => raw.setEx(key(value), seconds, data),
    hGet: (value, field) => raw.hGet(key(value), field),
    hLen: (value) => raw.hLen(key(value)),
    hSet: (value, field, data) => raw.hSet(key(value), field, data),
    hVals: (value) => raw.hVals(key(value)),
    pExpire: (value, milliseconds) => raw.pExpire(key(value), milliseconds),
    pTTL: (value) => raw.pTTL(key(value)),
    eval: (script, options) => raw.eval(script, {
      ...options,
      keys: options.keys.map(key),
    }),
  };

  const cleanup = async (): Promise<void> => {
    const keys: string[] = [];
    for await (const found of raw.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
      keys.push(...found);
    }
    if (keys.length > 0) {
      await Promise.all(keys.map((value) => raw.del(value)));
    }
  };

  return {
    redis,
    raw,
    key,
    cleanup,
    close: async () => {
      try {
        await cleanup();
      } finally {
        if (raw.isOpen) {
          await raw.close();
        }
      }
    },
  };
}
