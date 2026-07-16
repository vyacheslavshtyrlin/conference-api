import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { RedisConnection } from "../redis/redis.connection.js";

export type ApiReadinessStatus = {
  status: "ok" | "unavailable";
  service: "api";
  checks: { redis: "ok" | "unavailable" };
};

@Controller()
export class ReadyController {
  constructor(@Inject(RedisConnection) private readonly redis: RedisConnection) {}

  @Get("ready")
  async ready(): Promise<ApiReadinessStatus> {
    const redisReady = await this.redis.isReady();
    const body: ApiReadinessStatus = {
      status: redisReady ? "ok" : "unavailable",
      service: "api",
      checks: { redis: redisReady ? "ok" : "unavailable" },
    };

    if (!redisReady) {
      throw new ServiceUnavailableException(body);
    }

    return body;
  }
}
