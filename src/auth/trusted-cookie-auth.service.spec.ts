import { ConfigService } from "@nestjs/config";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateApiConfig, type ApiConfig } from "../config/api-config.js";
import { TrustedCookieAuthService } from "./trusted-cookie-auth.service.js";

const secret = "a-cookie-secret-with-at-least-thirty-two-chars";

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signCookieJwt(payload: Record<string, unknown>): string {
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const body = encodeJson({
    iss: "users",
    aud: "conference",
    sub: "user-42",
    exp: Math.floor(Date.now() / 1000) + 60,
    ...payload,
  });
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function createService(environment: NodeJS.ProcessEnv): TrustedCookieAuthService {
  return new TrustedCookieAuthService(new ConfigService<ApiConfig, true>(validateApiConfig(environment)));
}

describe("TrustedCookieAuthService", () => {
  it("derives trusted identity from a configured signed cookie", () => {
    const service = createService({
      NODE_ENV: "test",
      AUTH_COOKIE_ENABLED: "true",
      AUTH_COOKIE_NAME: "comet_identity",
      AUTH_COOKIE_JWT_ISSUER: "users",
      AUTH_COOKIE_JWT_AUDIENCE: "conference",
      AUTH_COOKIE_JWT_HS256_SECRET: secret,
    });

    expect(service.resolve(`other=1; comet_identity=${encodeURIComponent(signCookieJwt({ displayName: "Anna" }))}`)).toEqual({
      kind: "authenticated",
      source: "trusted_cookie",
      externalSubject: "user-42",
      displayName: "Anna",
    });
  });

  it("ignores cookies while trusted-cookie auth capability is disabled", () => {
    const service = createService({ NODE_ENV: "test" });

    expect(service.resolve(`conference_identity=${encodeURIComponent("not-a-jwt")}`)).toBeUndefined();
  });

  it("returns undefined for invalid configured cookies without leaking credential details", () => {
    const service = createService({
      NODE_ENV: "test",
      AUTH_COOKIE_ENABLED: "true",
      AUTH_COOKIE_JWT_ISSUER: "users",
      AUTH_COOKIE_JWT_AUDIENCE: "conference",
      AUTH_COOKIE_JWT_HS256_SECRET: secret,
    });

    expect(service.resolve(`conference_identity=${encodeURIComponent(signCookieJwt({ aud: "other-service" }))}`)).toBeUndefined();
  });
});
