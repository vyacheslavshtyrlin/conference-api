import { describe, expect, it } from "vitest";
import { validateApiConfig } from "./api-config.js";

describe("validateApiConfig", () => {
  it("rejects invalid startup configuration with a clear field message", () => {
    expect(() => validateApiConfig({ PORT: "not-a-port" })).toThrow("Invalid API configuration: PORT");
  });

  it("rejects the local join-token default in production", () => {
    expect(() => validateApiConfig({ NODE_ENV: "production" })).toThrow("JOIN_TOKEN_SECRET");
  });
});
