import { describe, expect, it } from "vitest";
import { ReadyController } from "./ready.controller.js";

class FakeRedisConnection {
  constructor(private readonly ready: () => Promise<boolean>) {}

  isReady(): Promise<boolean> {
    return this.ready();
  }
}

describe("ReadyController", () => {
  it("reflects Redis loss and recovery without recreating the controller", async () => {
    let available = false;
    const controller = new ReadyController(new FakeRedisConnection(async () => available) as never);

    await expect(controller.ready()).rejects.toMatchObject({
      response: { status: "unavailable", service: "api", checks: { redis: "unavailable" } },
    });

    available = true;
    await expect(controller.ready()).resolves.toEqual({
      status: "ok",
      service: "api",
      checks: { redis: "ok" },
    });
  });
});
