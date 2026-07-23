import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppConfigResponse } from "#contracts";
import { TrustedCookieAuthService } from "../auth/trusted-cookie-auth.service.js";
import {
  isAuthCookieEnabled,
  isIntegrationApiEnabled,
  type ApiConfig,
} from "../config/api-config.js";

@Injectable()
export class AppConfigService {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>,
    @Inject(TrustedCookieAuthService) private readonly trustedCookieAuth: TrustedCookieAuthService
  ) {}

  getPublicConfig(cookieHeader?: string | string[]): AppConfigResponse {
    const config = this.configSnapshot();
    const authCookieEnabled = isAuthCookieEnabled(config);
    const identity = authCookieEnabled ? this.trustedCookieAuth.resolve(cookieHeader) : undefined;

    return {
      authCookieEnabled,
      integrationApiEnabled: isIntegrationApiEnabled(config),
      loginUrl: config.AUTH_LOGIN_URL,
      identity: identity
        ? {
            displayName: identity.displayName,
            avatarUrl: identity.avatarUrl,
          }
        : null,
    };
  }

  private configSnapshot(): ApiConfig {
    return {
      NODE_ENV: this.config.get("NODE_ENV", { infer: true }),
      AUTH_COOKIE_ENABLED: this.config.get("AUTH_COOKIE_ENABLED", { infer: true }),
      INTEGRATION_API_ENABLED: this.config.get("INTEGRATION_API_ENABLED", { infer: true }),
      AUTH_LOGIN_URL: this.config.get("AUTH_LOGIN_URL", { infer: true }),
      AUTH_COOKIE_NAME: this.config.get("AUTH_COOKIE_NAME", { infer: true }),
      AUTH_COOKIE_JWT_ISSUER: this.config.get("AUTH_COOKIE_JWT_ISSUER", { infer: true }),
      AUTH_COOKIE_JWT_AUDIENCE: this.config.get("AUTH_COOKIE_JWT_AUDIENCE", { infer: true }),
      AUTH_COOKIE_JWT_HS256_SECRET: this.config.get("AUTH_COOKIE_JWT_HS256_SECRET", { infer: true }),
      PORT: this.config.get("PORT", { infer: true }),
      REDIS_URL: this.config.get("REDIS_URL", { infer: true }),
      WEB_PUBLIC_URL: this.config.get("WEB_PUBLIC_URL", { infer: true }),
      MEDIA_NODE_ID: this.config.get("MEDIA_NODE_ID", { infer: true }),
      SIGNALING_PUBLIC_URL: this.config.get("SIGNALING_PUBLIC_URL", { infer: true }),
      JOIN_TOKEN_SECRET: this.config.get("JOIN_TOKEN_SECRET", { infer: true }),
      ROOM_SESSION_TOKEN_SECRET: this.config.get("ROOM_SESSION_TOKEN_SECRET", { infer: true }),
      JOIN_TOKEN_TTL_SECONDS: this.config.get("JOIN_TOKEN_TTL_SECONDS", { infer: true }),
      INTEGRATION_JWT_CREDENTIALS_JSON: this.config.get("INTEGRATION_JWT_CREDENTIALS_JSON", { infer: true }),
      INTEGRATION_JWT_MAX_TTL_SECONDS: this.config.get("INTEGRATION_JWT_MAX_TTL_SECONDS", { infer: true }),
      INTEGRATION_RATE_LIMIT_WINDOW_SECONDS: this.config.get("INTEGRATION_RATE_LIMIT_WINDOW_SECONDS", { infer: true }),
      INTEGRATION_RATE_LIMIT_MAX_REQUESTS: this.config.get("INTEGRATION_RATE_LIMIT_MAX_REQUESTS", { infer: true }),
      RECORDING_DELIVERY_ENABLED: this.config.get("RECORDING_DELIVERY_ENABLED", { infer: true }),
      DATABASE_URL: this.config.get("DATABASE_URL", { infer: true }),
      RECORDING_S3_ENDPOINT: this.config.get("RECORDING_S3_ENDPOINT", { infer: true }),
      RECORDING_S3_REGION: this.config.get("RECORDING_S3_REGION", { infer: true }),
      RECORDING_S3_BUCKET: this.config.get("RECORDING_S3_BUCKET", { infer: true }),
      RECORDING_S3_ACCESS_KEY_ID: this.config.get("RECORDING_S3_ACCESS_KEY_ID", { infer: true }),
      RECORDING_S3_SECRET_ACCESS_KEY: this.config.get("RECORDING_S3_SECRET_ACCESS_KEY", { infer: true }),
      RECORDING_S3_FORCE_PATH_STYLE: this.config.get("RECORDING_S3_FORCE_PATH_STYLE", { infer: true }),
      RECORDING_S3_PRESIGN_TTL_SECONDS: this.config.get("RECORDING_S3_PRESIGN_TTL_SECONDS", { infer: true }),
      RECORDING_ARTIFACT_RETENTION_DAYS: this.config.get("RECORDING_ARTIFACT_RETENTION_DAYS", { infer: true }),
      RECORDING_COMPOSITION_LEASE_SECONDS: this.config.get("RECORDING_COMPOSITION_LEASE_SECONDS", { infer: true }),
      RECORDING_CAPTURE_SERVICE_SECRET: this.config.get("RECORDING_CAPTURE_SERVICE_SECRET", { infer: true }),
      RECORDING_COMPOSITION_SERVICE_SECRET: this.config.get("RECORDING_COMPOSITION_SERVICE_SECRET", { infer: true }),
      RECORDING_BOT_ADMISSION_JWT_HS256_SECRET: this.config.get("RECORDING_BOT_ADMISSION_JWT_HS256_SECRET", { infer: true }),
    };
  }
}
