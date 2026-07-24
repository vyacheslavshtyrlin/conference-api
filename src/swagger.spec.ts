import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureSwaggerDocumentation } from "./swagger.js";

describe("configureSwaggerDocumentation", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({}).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    configureSwaggerDocumentation(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("exposes documented integration OpenAPI without credential examples", async () => {
    const response = await request(app.getHttpServer()).get("/api/docs-json").expect(200);
    const bodyText = JSON.stringify(response.body);

    expect(response.body.paths).toHaveProperty("/api/v1/app-config");
    expect(response.body.paths).toHaveProperty("/api/v1/rooms");
    expect(response.body.paths).toHaveProperty("/api/integrations/v1/rooms");
    expect(response.body.paths).toHaveProperty("/api/integrations/v1/rooms/{roomId}/admissions");
    expect(response.body.paths).toHaveProperty("/api/integrations/v1/recordings/{recordingId}");
    expect(response.body.paths).toHaveProperty("/api/integrations/v1/recordings/{recordingId}/callbacks/retry");
    expect(response.body.paths).toHaveProperty("/api/integrations/v1/rooms/{roomId}/recordings");
    expect(response.body.paths).toHaveProperty("/api/integrations/v1/rooms/{roomId}/history");
    expect(response.body.paths["/api/v1/rooms"].post.responses["201"].content["application/json"].schema).toBeDefined();
    expect(response.body.paths["/api/integrations/v1/rooms"].post.security).toEqual([
      { "integration-service-jwt": [] },
    ]);
    expect(response.body.paths["/api/integrations/v1/rooms"].post.parameters).toBeUndefined();
    expect(response.body.paths["/api/integrations/v1/rooms"].post.description).toContain("initialUser");
    expect(response.body.paths["/api/integrations/v1/rooms"].post.requestBody.content["application/json"].examples).toHaveProperty(
      "managerInOneCall"
    );
    expect(
      response.body.paths["/api/integrations/v1/rooms"].post.requestBody.content["application/json"].examples
        .managerInOneCall.value.recordingRequested
    ).toBe(true);
    expect(
      response.body.paths["/api/integrations/v1/rooms"].post.responses["201"].content["application/json"].examples
        .managerInOneCall.value.recordingId
    ).toBe("rec_01H...");
    expect(
      response.body.paths["/api/integrations/v1/rooms"].post.requestBody.content["application/json"].schema.properties
        .externalRoomId.pattern
    ).toBe("^[a-zA-Z0-9._:-]+$");
    expect(response.body.paths["/api/integrations/v1/rooms/{roomId}/admissions"].post.description).toContain(
      "одноразовую браузерную ссылку входа"
    );
    expect(response.body.paths["/api/integrations/v1/rooms/{roomId}/admissions"].post.responses).toEqual(
      expect.objectContaining({
        "404": expect.objectContaining({ description: expect.stringContaining("ROOM_NOT_FOUND") }),
        "410": expect.objectContaining({ description: expect.stringContaining("ROOM_EXPIRED") }),
      })
    );
    expect(response.body.paths["/api/integrations/v1/rooms/{roomId}/admissions"].post.responses).not.toHaveProperty("409");
    expect(response.body.paths["/api/integrations/v1/recordings/{recordingId}"].get.responses["200"].content["application/json"].examples).toHaveProperty("ready");
    expect(response.body.paths["/api/integrations/v1/rooms/{roomId}/recordings"].get.responses["200"].content["application/json"].schema.properties.recordings.type).toBe("array");
    expect(response.body.paths["/api/integrations/v1/rooms/{roomId}/history"].get.responses["200"].content["application/json"].schema.properties).toEqual(
      expect.objectContaining({ participants: expect.any(Object), chat: expect.any(Object) })
    );
    expect(response.body.paths["/api/integrations/v1/recordings/{recordingId}/callbacks/retry"].post.responses["201"].content["application/json"].schema.properties.retried).toBeDefined();
    expect(response.body.components.securitySchemes["integration-service-jwt"].description).toContain("HS256");
    expect(response.body.components.securitySchemes["integration-service-jwt"].description).toContain("обязательному `sub`");
    expect(response.body.tags).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "integrations", description: expect.stringContaining("Сервер-серверный") })])
    );
    expect(response.body.paths["/api/integrations/v1/rooms"].post.responses["201"].content["application/json"].schema).toBeDefined();
    expect(response.body.paths["/api/integrations/v1/rooms"].post.responses["409"].content["application/json"].schema).toBeDefined();
    expect(response.body.components.securitySchemes).toHaveProperty("integration-service-jwt");
    expect(bodyText).not.toContain("replace-with");
    expect(bodyText).not.toContain("room-session-token");
    expect(bodyText).not.toContain("user-4821");
    expect(bodyText).not.toContain("postman-local-crm-alpha-test-secret-2026");
  });
});
