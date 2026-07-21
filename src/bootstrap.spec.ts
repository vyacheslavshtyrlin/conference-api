import { describe, expect, it, vi } from "vitest";
import { configureApiApplication } from "./bootstrap.js";
import { configureSwaggerDocumentation } from "./swagger.js";

vi.mock("./swagger.js", () => ({
  configureSwaggerDocumentation: vi.fn(),
}));

describe("configureApiApplication", () => {
  it("enables Nest shutdown hooks before the API begins serving traffic", () => {
    const app = {
      enableShutdownHooks: vi.fn(),
      setGlobalPrefix: vi.fn(),
      enableCors: vi.fn(),
      useGlobalInterceptors: vi.fn(),
      useGlobalPipes: vi.fn(),
    };

    configureApiApplication(app as never, {
      NODE_ENV: "test",
      AUTH_COOKIE_ENABLED: false,
      INTEGRATION_API_ENABLED: false,
      AUTH_LOGIN_URL: null,
      AUTH_COOKIE_NAME: "conference_identity",
      PORT: 3000,
      REDIS_URL: "redis://localhost:6379",
      WEB_PUBLIC_URL: "http://localhost:5173",
      MEDIA_NODE_ID: "local",
      SIGNALING_PUBLIC_URL: "ws://localhost:4000/ws",
      JOIN_TOKEN_SECRET: "test-secret",
      JOIN_TOKEN_TTL_SECONDS: 300,
      INTEGRATION_JWT_MAX_TTL_SECONDS: 900,
      INTEGRATION_RATE_LIMIT_WINDOW_SECONDS: 60,
      INTEGRATION_RATE_LIMIT_MAX_REQUESTS: 60,
    });

    expect(app.enableShutdownHooks).toHaveBeenCalledOnce();
    expect(app.enableCors).toHaveBeenCalledWith({
      credentials: true,
      origin: "http://localhost:5173",
    });
    expect(app.useGlobalInterceptors).toHaveBeenCalledOnce();
    expect(configureSwaggerDocumentation).toHaveBeenCalledWith(app);
  });
});
