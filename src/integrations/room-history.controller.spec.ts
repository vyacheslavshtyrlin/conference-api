import "reflect-metadata";

import { HEADERS_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import { RoomHistoryController } from "./room-history.controller.js";

describe("RoomHistoryController", () => {
  it("prevents caching an integration response that may include an upstream recording URL", () => {
    const headers = Reflect.getMetadata(HEADERS_METADATA, RoomHistoryController.prototype.get) as Array<{
      name: string;
      value: string;
    }>;

    expect(headers).toContainEqual({ name: "Cache-Control", value: "private, no-store" });
  });
});
