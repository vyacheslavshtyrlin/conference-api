import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HealthController } from "../health/health.controller.js";

const createClient = vi.hoisted(() => vi.fn());

vi.mock("redis", () => ({ createClient }));

import { RedisConnection } from "./redis.connection.js";

type FakeRedisClient = {
  isOpen: boolean;
  isReady: boolean;
  connect: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeRedisClient {
  return {
    isOpen: false,
    isReady: false,
    connect: vi.fn(),
    ping: vi.fn(),
    quit: vi.fn(),
    on: vi.fn(),
  };
}

describe("RedisConnection", () => {
  let client: FakeRedisClient;

  beforeEach(() => {
    client = makeClient();
    createClient.mockReturnValue(client);
  });

  it("resolves ConfigService through Nest dependency injection", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RedisConnection,
        {
          provide: ConfigService,
          useValue: new ConfigService({ REDIS_URL: "redis://redis.test:6379" }),
        },
      ],
    }).compile();

    expect(moduleRef.get(RedisConnection)).toBeInstanceOf(RedisConnection);
    expect(createClient).toHaveBeenCalledWith({ url: "redis://redis.test:6379" });
  });

  it("does not block API boot or dependency-free liveness when Redis is initially unavailable", async () => {
    client.connect.mockReturnValue(new Promise<void>(() => undefined));
    const connection = new RedisConnection(new ConfigService({ REDIS_URL: "redis://redis.test:6379" }));

    expect(connection.onModuleInit()).toBeUndefined();
    await expect(connection.isReady(5)).resolves.toBe(false);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(new HealthController().health()).toEqual({ status: "ok", service: "api" });
  });

  it("uses bounded Redis probes and reflects loss then recovery without recreating the connection", async () => {
    client.isOpen = true;
    client.isReady = true;
    client.ping.mockRejectedValueOnce(new Error("Redis unavailable")).mockResolvedValueOnce("PONG");
    const connection = new RedisConnection(new ConfigService({ REDIS_URL: "redis://redis.test:6379" }));

    await expect(connection.isReady(5)).resolves.toBe(false);
    await expect(connection.isReady(5)).resolves.toBe(true);
    expect(client.ping).toHaveBeenCalledTimes(2);
  });
});
