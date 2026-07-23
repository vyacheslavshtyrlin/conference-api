import { describe, expect, it } from "vitest";
import { validateApiConfig } from "./api-config.js";

describe("validateApiConfig", () => {
  it("rejects invalid startup configuration with a clear field message", () => {
    expect(() => validateApiConfig({ PORT: "not-a-port" })).toThrow(
      "Invalid API configuration: PORT",
    );
  });

  it("defaults to anonymous browser rooms with optional extensions disabled", () => {
    const config = validateApiConfig({ NODE_ENV: "test" });
    expect(config).toMatchObject({
      AUTH_COOKIE_ENABLED: false,
      INTEGRATION_API_ENABLED: false,
      AUTH_LOGIN_URL: null,
      AUTH_COOKIE_NAME: "conference_identity",
    });
  });

  it("accepts auth cookie support and login URL configuration", () => {
    expect(
      validateApiConfig({
        NODE_ENV: "test",
        AUTH_COOKIE_ENABLED: "true",
        AUTH_COOKIE_JWT_ISSUER: "users",
        AUTH_COOKIE_JWT_AUDIENCE: "conference",
        AUTH_COOKIE_JWT_HS256_SECRET:
          "a-cookie-secret-with-at-least-thirty-two-chars",
        AUTH_LOGIN_URL: "https://users.example.com/login",
      }),
    ).toMatchObject({
      AUTH_COOKIE_ENABLED: true,
      AUTH_LOGIN_URL: "https://users.example.com/login",
    });
  });

  it("accepts explicit auth cookie and integration extensions together", () => {
    expect(
      validateApiConfig({
        NODE_ENV: "test",
        AUTH_COOKIE_ENABLED: "true",
        INTEGRATION_API_ENABLED: "true",
        AUTH_COOKIE_JWT_ISSUER: "users",
        AUTH_COOKIE_JWT_AUDIENCE: "conference",
        AUTH_COOKIE_JWT_HS256_SECRET:
          "a-cookie-secret-with-at-least-thirty-two-chars",
        INTEGRATION_JWT_CREDENTIALS_JSON: JSON.stringify([
          {
            integrationId: "crm-alpha",
            issuer: "crm-alpha",
            audience: "conference-integrations",
            hs256Secret: "a-secret-with-at-least-thirty-two-chars",
          },
        ]),
      }),
    ).toMatchObject({
      AUTH_COOKIE_ENABLED: true,
      INTEGRATION_API_ENABLED: true,
    });
  });

  it("rejects auth cookie support without complete cookie JWT settings", () => {
    expect(() =>
      validateApiConfig({
        NODE_ENV: "test",
        AUTH_COOKIE_ENABLED: "true",
        AUTH_COOKIE_JWT_ISSUER: "users",
      }),
    ).toThrow("AUTH_COOKIE_JWT_AUDIENCE");
  });

  it("rejects the local join-token default in production", () => {
    expect(() => validateApiConfig({ NODE_ENV: "production" })).toThrow(
      "JOIN_TOKEN_SECRET",
    );
  });

  it("accepts an independent integration credential registry without enabling the integration API", () => {
    expect(
      validateApiConfig({
        NODE_ENV: "test",
        INTEGRATION_JWT_CREDENTIALS_JSON: JSON.stringify([
          {
            integrationId: "crm-alpha",
            issuer: "crm-alpha",
            audience: "conference-integrations",
            hs256Secret: "a-secret-with-at-least-thirty-two-chars",
          },
        ]),
        INTEGRATION_RATE_LIMIT_WINDOW_SECONDS: "30",
        INTEGRATION_RATE_LIMIT_MAX_REQUESTS: "10",
      }),
    ).toMatchObject({
      INTEGRATION_API_ENABLED: false,
      INTEGRATION_JWT_CREDENTIALS_JSON: [
        expect.objectContaining({ integrationId: "crm-alpha" }),
      ],
      INTEGRATION_RATE_LIMIT_WINDOW_SECONDS: 30,
      INTEGRATION_RATE_LIMIT_MAX_REQUESTS: 10,
    });
  });

  it("rejects duplicate integration credential identifiers", () => {
    expect(() =>
      validateApiConfig({
        NODE_ENV: "test",
        INTEGRATION_JWT_CREDENTIALS_JSON: JSON.stringify([
          {
            integrationId: "crm-alpha",
            issuer: "crm-alpha",
            audience: "conference-integrations",
            hs256Secret: "a-secret-with-at-least-thirty-two-chars",
          },
          {
            integrationId: "crm-alpha",
            issuer: "crm-alpha-secondary",
            audience: "conference-integrations",
            hs256Secret: "another-secret-with-at-least-thirty-two-chars",
          },
        ]),
      }),
    ).toThrow("INTEGRATION_JWT_CREDENTIALS_JSON.1.integrationId");
  });

  it("rejects a signing secret reused by separate integrations", () => {
    const sharedSecret = "a-secret-with-at-least-thirty-two-chars";

    expect(() =>
      validateApiConfig({
        NODE_ENV: "test",
        INTEGRATION_JWT_CREDENTIALS_JSON: JSON.stringify([
          {
            integrationId: "crm-alpha",
            issuer: "crm-alpha",
            audience: "conference-integrations",
            hs256Secret: sharedSecret,
          },
          {
            integrationId: "scheduling-beta",
            issuer: "scheduling-beta",
            audience: "conference-integrations",
            hs256Secret: sharedSecret,
          },
        ]),
      }),
    ).toThrow("INTEGRATION_JWT_CREDENTIALS_JSON.1.hs256Secret");
  });

  it("rejects enabled integration API without complete service JWT settings", () => {
    expect(() =>
      validateApiConfig({
        NODE_ENV: "test",
        INTEGRATION_API_ENABLED: "true",
      }),
    ).toThrow("INTEGRATION_JWT_CREDENTIALS_JSON");
  });

  it("requires bot admission signing configuration to be complete when configured", () => {
    expect(() => validateApiConfig({
      NODE_ENV: "test",
      RECORDING_BOT_ADMISSION_JWT_ISSUER: "conference-api",
    })).toThrow("RECORDING_BOT_ADMISSION_JWT_HS256_SECRET");
  });

  it("rejects bot admission TTL above the 60-second contract maximum", () => {
    expect(() => validateApiConfig({ NODE_ENV: "test", RECORDING_BOT_ADMISSION_TTL_SECONDS: "61" })).toThrow(
      "RECORDING_BOT_ADMISSION_TTL_SECONDS"
    );
  });

  it("accepts complete bot admission configuration", () => {
    expect(validateApiConfig({
      NODE_ENV: "test",
      RECORDING_BOT_ADMISSION_JWT_ISSUER: "conference-api",
      RECORDING_BOT_ADMISSION_JWT_HS256_SECRET: "recording-bot-admission-secret-32-chars",
      RECORDING_BOT_ADMISSION_TTL_SECONDS: "45",
    })).toMatchObject({ RECORDING_BOT_ADMISSION_TTL_SECONDS: 45 });
  });
});
