import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ApiConfig } from "../config/api-config.js";
import { integrationRateLimited } from "./integration-auth.errors.js";

type RateLimitBucket = {
  windowStartedAt: number;
  count: number;
};

@Injectable()
export class IntegrationRateLimiterService {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(@Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>) {}

  assertAllowed(key: string, now = Date.now()): void {
    const windowMs = this.config.get("INTEGRATION_RATE_LIMIT_WINDOW_SECONDS", { infer: true }) * 1000;
    const maxRequests = this.config.get("INTEGRATION_RATE_LIMIT_MAX_REQUESTS", { infer: true });
    const existing = this.buckets.get(key);

    if (!existing || now - existing.windowStartedAt >= windowMs) {
      this.buckets.set(key, { windowStartedAt: now, count: 1 });
      return;
    }

    existing.count += 1;
    if (existing.count > maxRequests) {
      throw integrationRateLimited();
    }
  }
}
