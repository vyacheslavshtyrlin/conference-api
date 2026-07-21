import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AppConfigController } from "./app-config.controller.js";
import { AppConfigService } from "./app-config.service.js";

describe("AppConfigController", () => {
  it("returns public extension configuration without secrets", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AppConfigController],
      providers: [
        {
          provide: AppConfigService,
          useValue: {
            getPublicConfig: () => ({
              authCookieEnabled: true,
              integrationApiEnabled: false,
              loginUrl: "https://users.example.com/login",
              identity: null,
            }),
          },
        },
      ],
    }).compile();

    const controller = moduleRef.get(AppConfigController);

    expect(controller.getAppConfig()).toEqual({
      authCookieEnabled: true,
      integrationApiEnabled: false,
      loginUrl: "https://users.example.com/login",
      identity: null,
    });
  });
});
