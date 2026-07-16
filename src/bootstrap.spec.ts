import { describe, expect, it, vi } from "vitest";
import { configureApiApplication } from "./bootstrap.js";

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
      PORT: 3000,
      REDIS_URL: "redis://localhost:6379",
      WEB_PUBLIC_URL: "http://localhost:5173",
      MEDIA_NODE_ID: "local",
      SIGNALING_PUBLIC_URL: "ws://localhost:4000/ws",
      JOIN_TOKEN_SECRET: "test-secret",
      JOIN_TOKEN_TTL_SECONDS: 300,
    });

    expect(app.enableShutdownHooks).toHaveBeenCalledOnce();
    expect(app.useGlobalInterceptors).toHaveBeenCalledOnce();
  });
});
