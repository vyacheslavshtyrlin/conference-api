import "reflect-metadata";

import { RequestMethod, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { createHmac } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RoomMetadata } from "#contracts";
import type { ApiConfig } from "../config/api-config.js";
import type {
  AdmissionRecord,
  ConsumeAdmissionCommand,
  CreateRoomOptions,
  CreateRoomRecord,
  IntegrationRoomOwnerRecord,
  JoinRequestRecord,
  RoomSessionRecord,
} from "../rooms/room.repository.js";
import { IntegrationRoomConflictError, RoomRepository } from "../rooms/room.repository.js";
import { RoomTokenService } from "../rooms/room-token.service.js";
import { invalidToken } from "../rooms/room-errors.js";
import { IntegrationsModule } from "./integrations.module.js";
import { RecordingControlModule } from "../recording-control/recording-control.module.js";

const integrationCredentials = {
  "crm-alpha": {
    issuer: "crm-alpha-tests",
    audience: "conference-integrations",
    secret: "integration-alpha-test-secret-with-32-chars",
  },
  "scheduling-beta": {
    issuer: "scheduling-beta-tests",
    audience: "conference-integrations",
    secret: "integration-beta-test-secret-with-32-chars",
  },
} as const;

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signIntegrationJwt(payload: Record<string, unknown>, integrationId: keyof typeof integrationCredentials = "crm-alpha"): string {
  const credential = integrationCredentials[integrationId];
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const body = encodeJson({
    iss: credential.issuer,
    aud: credential.audience,
    sub: integrationId,
    iat: issuedAt,
    exp: issuedAt + 60,
    ...payload,
  });
  const signature = createHmac("sha256", credential.secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function signRecordingControlJwt(payload: Record<string, unknown> = {}): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const body = encodeJson({
    iss: "conference-signaling-tests",
    aud: "conference-recording-control",
    sub: "signaling",
    iat: issuedAt,
    exp: issuedAt + 60,
    ...payload,
  });
  const signature = createHmac("sha256", "recording-control-test-secret-with-32-chars")
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    NODE_ENV: "test",
    AUTH_COOKIE_ENABLED: false,
    INTEGRATION_API_ENABLED: true,
    AUTH_LOGIN_URL: null,
    AUTH_COOKIE_NAME: "conference_identity",
    PORT: 3000,
    REDIS_URL: "redis://localhost:6379",
    WEB_PUBLIC_URL: "http://localhost:5173",
    MEDIA_NODE_ID: "local",
    SIGNALING_PUBLIC_URL: "ws://localhost:4000/ws",
    JOIN_TOKEN_SECRET: "test-secret",
    JOIN_TOKEN_TTL_SECONDS: 300,
    INTEGRATION_JWT_CREDENTIALS_JSON: [
      {
        integrationId: "crm-alpha",
        issuer: integrationCredentials["crm-alpha"].issuer,
        audience: integrationCredentials["crm-alpha"].audience,
        hs256Secret: integrationCredentials["crm-alpha"].secret,
      },
      {
        integrationId: "scheduling-beta",
        issuer: integrationCredentials["scheduling-beta"].issuer,
        audience: integrationCredentials["scheduling-beta"].audience,
        hs256Secret: integrationCredentials["scheduling-beta"].secret,
      },
    ],
    INTEGRATION_JWT_MAX_TTL_SECONDS: 900,
    INTEGRATION_RATE_LIMIT_WINDOW_SECONDS: 60,
    INTEGRATION_RATE_LIMIT_MAX_REQUESTS: 60,
    RECORDING_DELIVERY_ENABLED: false,
    RECORDING_S3_FORCE_PATH_STYLE: false,
    RECORDING_S3_PRESIGN_TTL_SECONDS: 900,
    RECORDING_COMPOSITION_LEASE_SECONDS: 300,
    RECORDING_CONTROL_JWT_HS256_SECRET: "recording-control-test-secret-with-32-chars",
    ...overrides,
  };
}

class InMemoryIntegrationRoomRepository extends RoomRepository {
  readonly rooms = new Map<string, RoomMetadata>();
  readonly owners = new Map<string, IntegrationRoomOwnerRecord>();
  readonly admissions = new Map<string, AdmissionRecord & { consumedAt?: string }>();
  readonly sessions = new Map<string, RoomSessionRecord>();
  readonly joinRequests = new Map<string, JoinRequestRecord>();
  readonly externalRooms = new Map<string, { requestHash: string; roomId: string }>();
  readonly recordingStates = new Map<string, "capturing" | "finalizing">();

  async createRoom(record: CreateRoomRecord, options: CreateRoomOptions = {}): Promise<RoomMetadata> {
    const integration = options.integration;
    if (integration) {
      const externalKey = `${integration.integrationId}:${integration.externalRoomId}`;
      const external = this.externalRooms.get(externalKey);
      if (external) {
        if (external.requestHash !== integration.requestHash) {
          throw new IntegrationRoomConflictError("external_conflict");
        }
        const existing = this.rooms.get(external.roomId);
        if (existing) return existing;
      }
    }

    const room: RoomMetadata = { ...record, accessPolicy: record.accessPolicy ?? "link", status: "active", closedReason: null };
    this.rooms.set(room.roomId, room);

    if (integration) {
      const mapping = { requestHash: integration.requestHash, roomId: room.roomId };
      this.externalRooms.set(`${integration.integrationId}:${integration.externalRoomId}`, mapping);
      this.owners.set(room.roomId, {
        roomId: room.roomId,
        integrationId: integration.integrationId,
        externalRoomHash: integration.externalRoomId,
        requestHash: integration.requestHash,
        createdAt: room.createdAt,
        recordingId: integration.recordingId,
      });
    }

    return room;
  }

  async getRoomById(roomId: string): Promise<RoomMetadata> {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Room not found");
    return room;
  }
  async getRoomBySlug(): Promise<RoomMetadata> {
    throw new Error("Not used by integration tests");
  }
  async getIntegrationRoomOwner(roomId: string): Promise<IntegrationRoomOwnerRecord | undefined> {
    return this.owners.get(roomId);
  }
  async getIntegrationRoomOwnerByRecordingId(recordingId: string): Promise<IntegrationRoomOwnerRecord | undefined> {
    return Array.from(this.owners.values()).find((owner) => owner.recordingId === recordingId);
  }
  async getRecordingControlState(recordingId: string) {
    return this.recordingStates.get(recordingId) ?? "requested";
  }
  async activateRecording(recordingId: string) {
    const state = this.recordingStates.get(recordingId);
    if (state === "finalizing") return state;
    this.recordingStates.set(recordingId, "capturing");
    return "capturing" as const;
  }
  async closeRecordingInputs(recordingId: string) {
    if (this.recordingStates.get(recordingId) !== "capturing" && this.recordingStates.get(recordingId) !== "finalizing") {
      return "inactive" as const;
    }
    this.recordingStates.set(recordingId, "finalizing");
    return "finalizing" as const;
  }
  async createAdmission(record: AdmissionRecord): Promise<void> {
    this.admissions.set(record.codeHash, record);
  }
  async consumeAdmission(command: ConsumeAdmissionCommand): Promise<{ room: RoomMetadata; session: RoomSessionRecord }> {
    const admission = this.admissions.get(command.codeHash);
    if (!admission || admission.consumedAt || (command.expectedRoomId && command.expectedRoomId !== admission.roomId)) {
      throw invalidToken("Invalid admission code");
    }
    admission.consumedAt = new Date().toISOString();
    const room = this.rooms.get(admission.roomId);
    if (!room || room.status === "closed") {
      throw invalidToken("Invalid admission code");
    }
    const identity: RoomSessionRecord["identity"] =
      admission.identity.source === "integration_admission"
        ? {
        kind: admission.identity.kind,
        source: "integration_admission",
            integrationId: admission.integrationId!,
            externalSubject: admission.identity.externalSubject!,
        avatarUrl: admission.identity.avatarUrl,
          }
        : {
            kind: "guest",
            source: "room_admission",
          };
    const session: RoomSessionRecord = {
      ...command.session,
      displayName: admission.identity.displayName ?? null,
      isCreator: admission.roomControls === "creator",
      identity,
    };
    this.sessions.set(`${admission.roomId}:${session.participantId}`, session);
    return { room, session };
  }
  async createJoinRequest(record: JoinRequestRecord): Promise<void> {
    this.joinRequests.set(`${record.roomId}:${record.requestId}`, record);
  }
  async getJoinRequest(roomId: string, requestId: string): Promise<JoinRequestRecord | undefined> {
    return this.joinRequests.get(`${roomId}:${requestId}`);
  }
  async listPendingJoinRequests(roomId: string): Promise<JoinRequestRecord[]> {
    return Array.from(this.joinRequests.values()).filter(
      (joinRequest) =>
        joinRequest.roomId === roomId && joinRequest.status === "pending" && Date.parse(joinRequest.expiresAt) > Date.now()
    );
  }
  async decideJoinRequest(
    roomId: string,
    requestId: string,
    status: "approved" | "denied",
    decidedByParticipantId: string
  ): Promise<JoinRequestRecord> {
    const joinRequest = this.joinRequests.get(`${roomId}:${requestId}`);
    if (!joinRequest) throw invalidToken("Invalid join request");
    const next = { ...joinRequest, status, decidedByParticipantId, decidedAt: new Date().toISOString() };
    this.joinRequests.set(`${roomId}:${requestId}`, next);
    return next;
  }
  async fulfillApprovedJoinRequest(
    roomId: string,
    requestId: string,
    participantId: string,
    tokenHash: string,
    session: RoomSessionRecord
  ): Promise<JoinRequestRecord> {
    const joinRequest = this.joinRequests.get(`${roomId}:${requestId}`);
    if (!joinRequest) throw invalidToken("Invalid join request");
    const next = { ...joinRequest, approvedParticipantId: participantId, approvedTokenHash: tokenHash };
    this.joinRequests.set(`${roomId}:${requestId}`, next);
    this.sessions.set(`${roomId}:${session.participantId}`, session);
    return next;
  }
  async getParticipantCount(): Promise<number> {
    return 0;
  }
  async hasLiveParticipant(): Promise<boolean> {
    return false;
  }
  async saveRoomSession(): Promise<void> {
    throw new Error("Not used by integration tests");
  }
  async getRoomSession(): Promise<RoomSessionRecord | undefined> {
    return undefined;
  }
  async findRoomSessionByTokenHash(): Promise<RoomSessionRecord | undefined> {
    return undefined;
  }
}

async function createTestApp(config: ApiConfig): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [IntegrationsModule, RecordingControlModule],
  })
    .overrideProvider(RoomRepository)
    .useClass(InMemoryIntegrationRoomRepository)
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(config))
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1", {
    exclude: [
      { path: "api/integrations/v1/rooms", method: RequestMethod.ALL },
      { path: "api/integrations/v1/rooms/(.*)", method: RequestMethod.ALL },
      { path: "internal/v1/rooms/(.*)", method: RequestMethod.ALL },
      { path: "internal/v1/recordings/(.*)", method: RequestMethod.ALL },
    ],
  });
  await app.init();
  return app;
}

describe("IntegrationsController", () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  describe("service JWT boundary", () => {
    beforeEach(async () => {
      app = await createTestApp(testConfig());
    });

    it("rejects browser-style requests without a bearer service credential", async () => {
      const response = await request(app.getHttpServer()).post("/api/integrations/v1/rooms").send({
        externalRoomId: "crm-call-1",
        accessPolicy: "approval",
      });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: "INVALID_TOKEN" });
    });

    it("rejects an expired service JWT", async () => {
      const expired = signIntegrationJwt({
        exp: Math.floor(Date.now() / 1000) - 1,
        scope: "rooms:create",
      });

      const response = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${expired}`)
        .send({ externalRoomId: "crm-call-1", accessPolicy: "approval" });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: "INVALID_TOKEN" });
    });

    it("rejects a service JWT with the wrong audience", async () => {
      const wrongAudience = signIntegrationJwt({
        aud: "other-service",
        scope: "rooms:create",
      });

      const response = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${wrongAudience}`)
        .send({ externalRoomId: "crm-call-1", accessPolicy: "approval" });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: "INVALID_TOKEN" });
    });

    it("rejects a service JWT without the required sub claim", async () => {
      const missingSubject = signIntegrationJwt({
        sub: undefined,
        integrationId: "crm-alpha",
        scope: "rooms:create",
      });

      const response = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${missingSubject}`)
        .send({ externalRoomId: "crm-call-1", accessPolicy: "approval" });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: "INVALID_TOKEN" });
    });

    it("rejects a service JWT whose sub does not exactly match the integration ID", async () => {
      const paddedSubject = signIntegrationJwt({
        sub: " crm-alpha ",
        scope: "rooms:create",
      });

      const response = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${paddedSubject}`)
        .send({ externalRoomId: "crm-call-1", accessPolicy: "approval" });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: "INVALID_TOKEN" });
    });

    it("allows a valid service JWT without a scope claim", async () => {
      const token = signIntegrationJwt({});

      const response = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${token}`)
        .send({ externalRoomId: "crm-call-1" });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ accessPolicy: "approval" });
    });

    it("validates DTOs after the service credential passes", async () => {
      const token = signIntegrationJwt({});

      const response = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${token}`)
        .send({ externalRoomId: "crm-call-1", accessPolicy: "link" });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "INVALID_PAYLOAD" });
    });

    it("creates an integration room with no room-session token after a valid credential", async () => {
      const token = signIntegrationJwt({});

      const response = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${token}`)
        .send({ externalRoomId: "crm-call-1" });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        roomId: expect.stringMatching(/^room_/),
        slug: expect.any(String),
        mediaNodeId: "local",
        signalingUrl: "ws://localhost:4000/ws",
        status: "active",
        accessPolicy: "approval",
      });
      expect(response.body).not.toHaveProperty("participantId");
      expect(response.body).not.toHaveProperty("roomSessionToken");
      expect(Date.parse(response.body.expiresAt)).toBeGreaterThan(Date.now());
    });

    it("creates a room and initial creator admission from an integration-facing initialUser", async () => {
      const token = signIntegrationJwt({});

      const response = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${token}`)
        .send({
          externalRoomId: "crm-call-initial-user",
          initialUser: { id: "manager-42", name: "Anna Ivanova" },
        })
        .expect(201);

      expect(response.body).toMatchObject({
        roomId: expect.stringMatching(/^room_/),
        entryUrl: expect.stringContaining(`/r/${response.body.slug}#code=`),
        entryExpiresAt: expect.any(String),
      });

      const code = new URL(response.body.entryUrl).hash.replace(/^#code=/, "");
      const exchanged = await request(app.getHttpServer())
        .post("/api/v1/admissions/exchange")
        .send({ code, roomId: response.body.roomId })
        .expect(200);

      expect(exchanged.body).toMatchObject({
        roomId: response.body.roomId,
        displayName: "Anna Ivanova",
        isCreator: true,
      });
      expect(JSON.stringify(exchanged.body)).not.toContain("manager-42");
    });

    it("reissues an initialUser admission on an idempotent room retry", async () => {
      const token = signIntegrationJwt({ scope: "rooms:create admissions:create" });
      const body = {
        externalRoomId: "crm-call-initial-user-retry",
        accessPolicy: "approval",
        initialUser: { id: "manager-42", name: "Anna Ivanova" },
      };

      const first = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${token}`)
        .send(body)
        .expect(201);

      const retry = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${token}`)
        .send(body)
        .expect(201);

      expect(retry.body.roomId).toBe(first.body.roomId);
      expect(retry.body.entryUrl).not.toBe(first.body.entryUrl);
      expect(Date.parse(retry.body.entryExpiresAt)).toBeLessThanOrEqual(Date.parse(retry.body.expiresAt));
    });

    it("allows initialUser when the service credential has no scope claim", async () => {
      const token = signIntegrationJwt({});

      const response = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${token}`)
        .send({
          externalRoomId: "crm-call-initial-user-forbidden",
          initialUser: { id: "manager-42", name: "Anna Ivanova" },
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty("entryUrl");
    });

    it("isolates independently signed integrations and rejects cross-integration admissions", async () => {
      const alphaToken = signIntegrationJwt({ scope: "rooms:create" });
      const betaRoomToken = signIntegrationJwt({ scope: "rooms:create" }, "scheduling-beta");
      const betaAdmissionToken = signIntegrationJwt({ scope: "admissions:create" }, "scheduling-beta");

      const alphaRoom = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${alphaToken}`)
        .send({ externalRoomId: "shared-external-id", accessPolicy: "approval" })
        .expect(201);

      const betaRoom = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${betaRoomToken}`)
        .send({ externalRoomId: "shared-external-id", accessPolicy: "approval" })
        .expect(201);

      expect(betaRoom.body.roomId).not.toBe(alphaRoom.body.roomId);

      const response = await request(app.getHttpServer())
        .post(`/api/integrations/v1/rooms/${alphaRoom.body.roomId}/admissions`)
        .set("Authorization", `Bearer ${betaAdmissionToken}`)
        .send({
          identity: {
            kind: "authenticated",
            externalSubject: "scheduler-user-1",
            displayName: "Scheduler",
          },
          roomControls: "creator",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "INTEGRATION_FORBIDDEN" });
    });

    it("returns the same room for equivalent idempotent integration room requests", async () => {
      const token = signIntegrationJwt({ scope: "rooms:create" });
      const payload = { externalRoomId: "crm-call-1", accessPolicy: "approval" };

      const first = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${token}`)
        .send(payload)
        .expect(201);
      const second = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${token}`)
        .send(payload)
        .expect(201);

      expect(second.body).toMatchObject({
        roomId: first.body.roomId,
        slug: first.body.slug,
      });
    });

    it("rejects a reused external room ID with a different request body", async () => {
      const token = signIntegrationJwt({ scope: "rooms:create" });

      await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${token}`)
        .send({ externalRoomId: "crm-call-1", title: "First", accessPolicy: "approval" })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${token}`)
        .send({ externalRoomId: "crm-call-1", title: "Changed", accessPolicy: "approval" });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "INTEGRATION_CONFLICT" });
    });

    it("creates an integration room without an idempotency header", async () => {
      const token = signIntegrationJwt({ scope: "rooms:create" });

      const response = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${token}`)
        .send({ externalRoomId: "crm-call-1", accessPolicy: "approval" });

      expect(response.status).toBe(201);
    });

    it("issues an admission entry URL without exposing the raw code as a separate field", async () => {
      const roomToken = signIntegrationJwt({ scope: "rooms:create" });
      const admissionToken = signIntegrationJwt({ scope: "admissions:create" });
      const room = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${roomToken}`)
        .send({ externalRoomId: "crm-call-admission", accessPolicy: "approval" })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post(`/api/integrations/v1/rooms/${room.body.roomId}/admissions`)
        .set("Authorization", `Bearer ${admissionToken}`)
        .send({
          identity: {
            kind: "authenticated",
            externalSubject: "crm-user-42",
            displayName: "Trusted Participant",
          },
          roomControls: "creator",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        entryUrl: expect.stringContaining(`/r/${room.body.slug}#code=`),
        expiresAt: expect.any(String),
      });
      expect(response.body).not.toHaveProperty("code");
      expect(JSON.stringify(response.body)).not.toContain("crm-user-42");
    });

    it("rejects malformed admission identity payloads before service execution", async () => {
      const roomToken = signIntegrationJwt({ scope: "rooms:create" });
      const admissionToken = signIntegrationJwt({ scope: "admissions:create" });
      const room = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${roomToken}`)
        .send({ externalRoomId: "crm-call-malformed-admission", accessPolicy: "approval" })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post(`/api/integrations/v1/rooms/${room.body.roomId}/admissions`)
        .set("Authorization", `Bearer ${admissionToken}`)
        .send({
          roomControls: "none",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "INVALID_PAYLOAD" });
    });

    it("exchanges an admission once for pending room-session artifacts without external subject or signaling token", async () => {
      const roomToken = signIntegrationJwt({ scope: "rooms:create" });
      const admissionToken = signIntegrationJwt({ scope: "admissions:create" });
      const room = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${roomToken}`)
        .send({ externalRoomId: "crm-call-exchange", accessPolicy: "approval" })
        .expect(201);
      const admission = await request(app.getHttpServer())
        .post(`/api/integrations/v1/rooms/${room.body.roomId}/admissions`)
        .set("Authorization", `Bearer ${admissionToken}`)
        .send({
          identity: {
            kind: "authenticated",
            externalSubject: "crm-user-42",
            displayName: "Trusted Participant",
          },
          roomControls: "creator",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
        .expect(201);
      const code = new URL(admission.body.entryUrl).hash.replace("#code=", "");

      const exchanged = await request(app.getHttpServer())
        .post("/api/v1/admissions/exchange")
        .send({ code, roomId: room.body.roomId });

      expect(exchanged.status).toBe(200);
      expect(exchanged.body).toMatchObject({
        roomId: room.body.roomId,
        slug: room.body.slug,
        participantId: expect.stringMatching(/^peer_/),
        roomSessionToken: expect.any(String),
        displayName: "Trusted Participant",
        isCreator: true,
        signalingUrl: "ws://localhost:4000/ws",
      });
      expect(exchanged.body).not.toHaveProperty("token");
      expect(JSON.stringify(exchanged.body)).not.toContain("crm-user-42");

      const reused = await request(app.getHttpServer()).post("/api/v1/admissions/exchange").send({ code });
      expect(reused.status).toBe(401);
      expect(reused.body).toMatchObject({ code: "INVALID_TOKEN" });
    });

    it("exchanges a room admission into unnamed non-creator pending room-session artifacts", async () => {
      const repository = app.get(RoomRepository) as InMemoryIntegrationRoomRepository;
      const tokenService = app.get(RoomTokenService);
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      await repository.createRoom({
        roomId: "room_private_admission",
        slug: "private-admit",
        accessPolicy: "approval",
        mediaNodeId: "local",
        signalingUrl: "ws://localhost:4000/ws",
        createdAt: new Date().toISOString(),
        expiresAt,
      });
      await repository.createAdmission({
        roomId: "room_private_admission",
        codeHash: tokenService.hashAdmissionCode("private-code"),
        identity: {
          kind: "guest",
          source: "room_admission",
        },
        roomControls: "none",
        createdAt: new Date().toISOString(),
        expiresAt,
      });

      const exchanged = await request(app.getHttpServer())
        .post("/api/v1/admissions/exchange")
        .send({ code: "private-code", roomId: "room_private_admission" });

      expect(exchanged.status).toBe(200);
      expect(exchanged.body).toMatchObject({
        roomId: "room_private_admission",
        slug: "private-admit",
        participantId: expect.stringMatching(/^peer_/),
        roomSessionToken: expect.any(String),
        displayName: null,
        isCreator: false,
        signalingUrl: "ws://localhost:4000/ws",
      });
      expect(exchanged.body).not.toHaveProperty("token");
    });

    it("rejects exchanging an admission for the wrong room", async () => {
      const roomToken = signIntegrationJwt({ scope: "rooms:create" });
      const admissionToken = signIntegrationJwt({ scope: "admissions:create" });
      const room = await request(app.getHttpServer())
        .post("/api/integrations/v1/rooms")
        .set("Authorization", `Bearer ${roomToken}`)
        .send({ externalRoomId: "crm-call-wrong-room", accessPolicy: "approval" })
        .expect(201);
      const admission = await request(app.getHttpServer())
        .post(`/api/integrations/v1/rooms/${room.body.roomId}/admissions`)
        .set("Authorization", `Bearer ${admissionToken}`)
        .send({
          identity: {
            kind: "guest",
            externalSubject: "crm-guest-42",
            displayName: "Guest Participant",
          },
          roomControls: "none",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
        .expect(201);
      const code = new URL(admission.body.entryUrl).hash.replace("#code=", "");

      const response = await request(app.getHttpServer())
        .post("/api/v1/admissions/exchange")
        .send({ code, roomId: "room_other" });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: "INVALID_TOKEN" });
    });
  });

  it("keeps a requested recording id stable and exposes its private signaling lifecycle only to signaling", async () => {
    app = await createTestApp(testConfig());
    const integrationToken = signIntegrationJwt({});
    const body = { externalRoomId: "crm-recording-1", recordingRequested: true };

    const first = await request(app.getHttpServer())
      .post("/api/integrations/v1/rooms")
      .set("Authorization", `Bearer ${integrationToken}`)
      .send(body)
      .expect(201);
    const retry = await request(app.getHttpServer())
      .post("/api/integrations/v1/rooms")
      .set("Authorization", `Bearer ${integrationToken}`)
      .send(body)
      .expect(201);

    expect(first.body.recordingId).toMatch(/^rec_/);
    expect(retry.body.recordingId).toBe(first.body.recordingId);
    expect(first.body).not.toHaveProperty("integrationId");

    await request(app.getHttpServer())
      .get(`/internal/v1/rooms/${first.body.roomId}/recording`)
      .expect(401);

    const recordingToken = signRecordingControlJwt();
    const lookup = await request(app.getHttpServer())
      .get(`/internal/v1/rooms/${first.body.roomId}/recording`)
      .set("Authorization", `Bearer ${recordingToken}`)
      .expect(200);
    expect(lookup.body).toEqual({
      integrationId: "crm-alpha",
      recordingId: first.body.recordingId,
      requestedAt: expect.any(String),
      status: "requested",
    });
    expect(new Date(lookup.body.requestedAt).toISOString()).toBe(lookup.body.requestedAt);

    const activation = await request(app.getHttpServer())
      .post(`/internal/v1/rooms/${first.body.roomId}/recording/activate`)
      .set("Authorization", `Bearer ${recordingToken}`)
      .expect(201);
    expect(activation.body).toEqual({
      integrationId: "crm-alpha",
      recordingId: first.body.recordingId,
      requestedAt: lookup.body.requestedAt,
      status: "capturing",
    });
    await request(app.getHttpServer())
      .post(`/internal/v1/recordings/${first.body.recordingId}/close-inputs`)
      .set("Authorization", `Bearer ${recordingToken}`)
      .expect(201)
      .expect({ recordingId: first.body.recordingId, status: "finalizing" });
  });

  it("rate-limits repeated integration requests by integration id", async () => {
    app = await createTestApp(testConfig({ INTEGRATION_RATE_LIMIT_MAX_REQUESTS: 1 }));
    const token = signIntegrationJwt({ scope: "rooms:create" });
    const payload = { externalRoomId: "crm-call-1", accessPolicy: "approval" };

    await request(app.getHttpServer())
      .post("/api/integrations/v1/rooms")
      .set("Authorization", `Bearer ${token}`)
      .send(payload)
      .expect(201);

    const response = await request(app.getHttpServer())
      .post("/api/integrations/v1/rooms")
      .set("Authorization", `Bearer ${token}`)
      .send(payload);

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("rejects integration service requests when the integration capability is explicitly disabled", async () => {
    app = await createTestApp(testConfig({ INTEGRATION_API_ENABLED: false }));
    const token = signIntegrationJwt({ scope: "rooms:create" });

    const response = await request(app.getHttpServer())
      .post("/api/integrations/v1/rooms")
      .set("Authorization", `Bearer ${token}`)
      .send({ externalRoomId: "crm-call-disabled", accessPolicy: "approval" });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "INTEGRATION_FORBIDDEN" });
  });
});
