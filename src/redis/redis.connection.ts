import { Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, type RedisClientType } from "redis";
import { getApiMetrics } from "../observability/api-metrics.service.js";

const readinessTimeoutMs = 1_000;

@Injectable()
export class RedisConnection implements OnModuleInit, OnApplicationShutdown {
  private readonly client: RedisClientType;
  private connectPromise: Promise<void> | undefined;

  constructor(config: ConfigService) {
    this.client = createClient({ url: config.getOrThrow<string>("REDIS_URL") });
    this.client.on("error", () => undefined);
  }

  getClient(): RedisClientType {
    return this.client;
  }

  onModuleInit(): void {
    this.startConnection();
  }

  async isReady(timeoutMs = readinessTimeoutMs): Promise<boolean> {
    if (!this.client.isOpen) {
      this.startConnection();
      return false;
    }

    if (!this.client.isReady) {
      return false;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const startedAt = performance.now();
    try {
      await Promise.race([
        this.client.ping(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Redis readiness check timed out")), timeoutMs);
        }),
      ]);
      getApiMetrics().recordRedisOperation({
        operation: "readiness_ping",
        outcome: "success",
        durationMs: performance.now() - startedAt,
      });
      return true;
    } catch {
      getApiMetrics().recordRedisOperation({
        operation: "readiness_ping",
        outcome: "error",
        durationMs: performance.now() - startedAt,
      });
      return false;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  private startConnection(): void {
    if (this.client.isOpen || this.connectPromise) {
      return;
    }

    this.connectPromise = this.client
      .connect()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.connectPromise = undefined;
      });
  }
}
