import "reflect-metadata";

import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RoomMetadata } from "#contracts";
import { TrustedCookieAuthService } from "../auth/trusted-cookie-auth.service.js";
import { validateApiConfig, type ApiConfig } from "../config/api-config.js";
import { roomNotFound } from "./room-errors.js";
import type {
  AdmissionRecord,
  ConsumeAdmissionCommand,
  CreateRoomRecord,
  IntegrationRoomOwnerRecord,
  JoinRequestRecord,
  RoomSessionRecord,
} from "./room.repository.js";
import { RoomRepository } from "./room.repository.js";
import { RoomTokenService } from "./room-token.service.js";
import { RoomsController } from "./rooms.controller.js";
import { RoomsService } from "./rooms.service.js";

class InMemoryRoomRepository extends RoomRepository {
  readonly rooms = new Map<string, RoomMetadata>();
  readonly slugs = new Map<string, string>();
  readonly participantCounts = new Map<string, number>();
  readonly liveParticipants = new Set<string>();
  readonly sessions = new Map<string, RoomSessionRecord>();
  readonly joinRequests = new Map<string, JoinRequestRecord>();
  readonly admissions = new Map<string, AdmissionRecord>();

  async createRoom(record: CreateRoomRecord): Promise<RoomMetadata> {
    const room: RoomMetadata = { ...record, accessPolicy: record.accessPolicy ?? "link", status: "active", closedReason: null };
    this.rooms.set(room.roomId, room);
    this.slugs.set(room.slug, room.roomId);
    return room;
  }

  async getRoomBySlug(slug: string): Promise<RoomMetadata> {
    const roomId = this.slugs.get(slug);
    const room = roomId ? this.rooms.get(roomId) : undefined;

    if (!room) {
      throw roomNotFound();
    }

    return room;
  }

  async getRoomById(roomId: string): Promise<RoomMetadata> {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw roomNotFound();
    }
    return room;
  }

  async getIntegrationRoomOwner(): Promise<IntegrationRoomOwnerRecord | undefined> {
    return undefined;
  }

  async createAdmission(record: AdmissionRecord): Promise<void> {
    this.admissions.set(record.codeHash, record);
  }

  async consumeAdmission(_command: ConsumeAdmissionCommand): Promise<{ room: RoomMetadata; session: RoomSessionRecord }> {
    throw new Error("Not used by room controller tests");
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
    if (!joinRequest) throw roomNotFound();
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
    if (!joinRequest) throw roomNotFound();
    const next = { ...joinRequest, approvedParticipantId: participantId, approvedTokenHash: tokenHash };
    this.joinRequests.set(`${roomId}:${requestId}`, next);
    await this.saveRoomSession(roomId, session);
    return next;
  }

  async getParticipantCount(roomId: string): Promise<number> {
    return this.participantCounts.get(roomId) ?? 0;
  }

  async hasLiveParticipant(roomId: string, participantId: string): Promise<boolean> {
    return this.liveParticipants.has(`${roomId}:${participantId}`);
  }

  async saveRoomSession(roomId: string, session: RoomSessionRecord): Promise<void> {
    this.sessions.set(`${roomId}:${session.participantId}`, session);
  }

  async getRoomSession(roomId: string, participantId: string): Promise<RoomSessionRecord | undefined> {
    return this.sessions.get(`${roomId}:${participantId}`);
  }

  async findRoomSessionByTokenHash(roomId: string, tokenHash: string): Promise<RoomSessionRecord | undefined> {
    return Array.from(this.sessions.entries())
      .filter(([key]) => key.startsWith(`${roomId}:`))
      .map(([, session]) => session)
      .find((session) => session.tokenHash === tokenHash);
  }
}

describe("RoomsController", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RoomsController],
      providers: [
        RoomsService,
        RoomTokenService,
        {
          provide: RoomRepository,
          useClass: InMemoryRoomRepository,
        },
        {
          provide: ConfigService,
          useValue: new ConfigService<ApiConfig, true>(validateApiConfig({
            NODE_ENV: "test",
            JOIN_TOKEN_SECRET: "test-secret",
            WEB_PUBLIC_URL: "http://web.test",
            SIGNALING_PUBLIC_URL: "ws://signaling.test/ws",
          })),
        },
        {
          provide: TrustedCookieAuthService,
          useValue: { resolve: () => undefined },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true,
      })
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("supports create, lookup and creator/guest join HTTP flow", async () => {
    const createResponse = await request(app.getHttpServer()).post("/api/v1/rooms").send({}).expect(201);

    expect(createResponse.body).toMatchObject({
      roomId: expect.stringMatching(/^room_/),
      slug: expect.any(String),
      participantId: expect.stringMatching(/^peer_/),
      roomSessionToken: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect(Date.parse(createResponse.body.expiresAt)).toBeGreaterThan(Date.now());
    expect(createResponse.body.joinUrl).toBe(`http://web.test/r/${createResponse.body.slug}`);
    expect(createResponse.body.joinUrl).not.toContain(createResponse.body.roomSessionToken);
    expect(createResponse.body.mediaNodeId).toBe("local");
    expect(createResponse.body.signalingUrl).toBe("ws://signaling.test/ws");

    await request(app.getHttpServer())
      .get(`/api/v1/rooms/${createResponse.body.slug}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          roomId: createResponse.body.roomId,
          slug: createResponse.body.slug,
          status: "active",
          mediaNodeId: "local",
          signalingUrl: "ws://signaling.test/ws",
          participantCount: 0,
        });
      });

    const creatorJoinResponse = await request(app.getHttpServer())
      .post(`/api/v1/rooms/${createResponse.body.slug}/join`)
      .send({ displayName: "Alex", roomSessionToken: createResponse.body.roomSessionToken })
      .expect(201)
      .expect(({ body }) => {
        expect(body.participantId).toBe(createResponse.body.participantId);
        expect(body.isCreator).toBe(true);
        expect(body.signalingUrl).toBe("ws://signaling.test/ws");
        expect(body.token).toEqual(expect.any(String));
        expect(body.roomSessionToken).toBe(createResponse.body.roomSessionToken);
      });

    await request(app.getHttpServer())
      .post(`/api/v1/rooms/${createResponse.body.slug}/join`)
      .send({ displayName: "Sam" })
      .expect(201)
      .expect(({ body }) => {
        expect(body.isCreator).toBe(false);
        expect(body.roomSessionToken).toEqual(expect.any(String));
      });

    await request(app.getHttpServer())
      .post(`/api/v1/rooms/${createResponse.body.slug}/session/refresh`)
      .send({
        participantId: creatorJoinResponse.body.participantId,
        roomSessionToken: creatorJoinResponse.body.roomSessionToken,
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.signalingUrl).toBe("ws://signaling.test/ws");
        expect(body.token).toEqual(expect.any(String));
      });
  });

  it("rejects invalid join DTO payloads", async () => {
    const createResponse = await request(app.getHttpServer()).post("/api/v1/rooms").send({}).expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/rooms/${createResponse.body.slug}/join`)
      .send({ displayName: "" })
      .expect(400);
  });

  it("supports private approval join-request HTTP flow", async () => {
    const createResponse = await request(app.getHttpServer())
      .post("/api/v1/rooms")
      .send({ accessPolicy: "approval" })
      .expect(201);

    expect(createResponse.body.accessPolicy).toBe("approval");

    await request(app.getHttpServer())
      .post(`/api/v1/rooms/${createResponse.body.slug}/admissions`)
      .send({
        participantId: createResponse.body.participantId,
        roomSessionToken: createResponse.body.roomSessionToken,
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.entryUrl).toMatch(new RegExp(`/r/${createResponse.body.slug}#code=`));
        expect(body.entryUrl).not.toContain(createResponse.body.roomSessionToken);
        expect(body.expiresAt).toEqual(expect.any(String));
      });

    await request(app.getHttpServer())
      .post(`/api/v1/rooms/${createResponse.body.slug}/join`)
      .send({ displayName: "Sam" })
      .expect(403)
      .expect(({ body }) => {
        expect(body.code).toBe("APPROVAL_REQUIRED");
      });

    await request(app.getHttpServer())
      .post(`/api/v1/rooms/${createResponse.body.slug}/join-requests`)
      .send({ displayName: "   " })
      .expect(400);

    const requestResponse = await request(app.getHttpServer())
      .post(`/api/v1/rooms/${createResponse.body.slug}/join-requests`)
      .send({ displayName: "  Sam  " })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          requestId: expect.stringMatching(/^join_/),
          requestToken: expect.any(String),
          status: "pending",
          displayName: "Sam",
          expiresAt: expect.any(String),
        });
      });

    await request(app.getHttpServer())
      .post(`/api/v1/rooms/${createResponse.body.slug}/join-requests/list`)
      .send({
        participantId: createResponse.body.participantId,
        roomSessionToken: createResponse.body.roomSessionToken,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.requests).toEqual([
          expect.objectContaining({
            requestId: requestResponse.body.requestId,
            displayName: "Sam",
          }),
        ]);
      });

    await request(app.getHttpServer())
      .post(`/api/v1/rooms/${createResponse.body.slug}/join-requests/${requestResponse.body.requestId}/approve`)
      .send({
        participantId: createResponse.body.participantId,
        roomSessionToken: createResponse.body.roomSessionToken,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          requestId: requestResponse.body.requestId,
          status: "approved",
        });
      });

    const approvedStatus = await request(app.getHttpServer())
      .post(`/api/v1/rooms/${createResponse.body.slug}/join-requests/${requestResponse.body.requestId}/status`)
      .send({ requestToken: requestResponse.body.requestToken })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          requestId: requestResponse.body.requestId,
          status: "approved",
          displayName: "Sam",
          participantId: expect.stringMatching(/^peer_/),
          roomSessionToken: expect.any(String),
          isCreator: false,
        });
      });

    await request(app.getHttpServer())
      .post(`/api/v1/rooms/${createResponse.body.slug}/join`)
      .send({ displayName: "Sam", roomSessionToken: approvedStatus.body.roomSessionToken })
      .expect(201)
      .expect(({ body }) => {
        expect(body.participantId).toBe(approvedStatus.body.participantId);
        expect(body.isCreator).toBe(false);
        expect(body.roomSessionToken).toBe(approvedStatus.body.roomSessionToken);
      });
  });
});
