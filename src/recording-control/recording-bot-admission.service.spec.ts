import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateApiConfig } from "../config/api-config.js";
import { RoomRepository } from "../rooms/room.repository.js";
import { RecordingBotAdmissionService } from "./recording-bot-admission.service.js";
import { RecordingBotAdmissionStore } from "./recording-bot-admission.store.js";

const room = {
  roomId: "room_test",
  slug: "test",
  accessPolicy: "approval" as const,
  mediaNodeId: "local",
  signalingUrl: "ws://localhost:4000/ws",
  createdAt: "2026-07-22T10:00:00.000Z",
  expiresAt: null,
  status: "active" as const,
  closedReason: null,
};

async function setup(overrides: Record<string, string> = {}) {
  const config = validateApiConfig({
    NODE_ENV: "test",
    RECORDING_BOT_ADMISSION_JWT_ISSUER: "conference-api",
    RECORDING_BOT_ADMISSION_JWT_HS256_SECRET: "recording-bot-admission-secret-32-chars",
    RECORDING_BOT_ADMISSION_TTL_SECONDS: "60",
    ...overrides,
  });
  const rooms = {
    getIntegrationRoomOwnerByRecordingId: vi.fn().mockResolvedValue({
      roomId: room.roomId,
      integrationId: "crm",
      requestHash: "hash",
      createdAt: room.createdAt,
      recordingId: "rec_test",
    }),
    getRoomById: vi.fn().mockResolvedValue(room),
    getRecordingActivation: vi.fn().mockResolvedValue({ activatedAt: room.createdAt }),
    getRecordingControlState: vi.fn().mockResolvedValue("capturing"),
  };
  const store = { issue: vi.fn().mockResolvedValue(true) };
  const module = await Test.createTestingModule({
    providers: [
      RecordingBotAdmissionService,
      { provide: RoomRepository, useValue: rooms },
      { provide: RecordingBotAdmissionStore, useValue: store },
      { provide: ConfigService, useValue: new ConfigService(config) },
    ],
  }).compile();
  return { service: module.get(RecordingBotAdmissionService), rooms, store };
}

afterEach(() => vi.useRealTimers());

describe("RecordingBotAdmissionService", () => {
  it("issues a scoped signed JWT and persists only its hashed jti marker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:00:00.000Z"));
    const { service, store } = await setup();
    const result = await service.issue("rec_test");
    const [header, payload] = result.admission.split(".").slice(0, 2).map((part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")));

    expect(header).toEqual({ alg: "HS256", typ: "recording-bot+jwt" });
    expect(payload).toMatchObject({ iss: "conference-api", aud: "conference-recording-bot-signaling", sub: "recording-bot", roomId: "room_test", recordingId: "rec_test", mediaNodeId: "local", iat: 1784714400, exp: 1784714460 });
    expect(store.issue).toHaveBeenCalledWith(createHash("sha256").update(payload.jti).digest("hex"), expect.objectContaining({ roomId: "room_test", recordingId: "rec_test", mediaNodeId: "local" }), 60_000);
    expect(JSON.stringify(store.issue.mock.calls)).not.toContain(result.admission);
  });

  it("caps expiry at the room deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:00:00.000Z"));
    const { service, rooms } = await setup();
    rooms.getRoomById.mockResolvedValue({ ...room, expiresAt: "2026-07-22T10:00:12.000Z" });
    await expect(service.issue("rec_test")).resolves.toMatchObject({ expiresAt: "2026-07-22T10:00:12.000Z" });
  });

  it.each([
    ["cross recording", { ownerRecordingId: "rec_other" }],
    ["cross room", { ownerRoomId: "room_other" }],
    ["cross node", { mediaNodeId: "other-node" }],
    ["finalizing recording after rejoin", { controlState: "finalizing" }],
    ["inactive recording", { controlState: "requested" }],
  ])("rejects %s issuance", async (_name, change) => {
    const { service, rooms } = await setup();
    if ("ownerRecordingId" in change) rooms.getIntegrationRoomOwnerByRecordingId.mockResolvedValue({ roomId: "room_test", integrationId: "crm", requestHash: "h", createdAt: room.createdAt, recordingId: change.ownerRecordingId });
    if ("ownerRoomId" in change) rooms.getIntegrationRoomOwnerByRecordingId.mockResolvedValue({ roomId: change.ownerRoomId, integrationId: "crm", requestHash: "h", createdAt: room.createdAt, recordingId: "rec_test" });
    if ("mediaNodeId" in change) rooms.getRoomById.mockResolvedValue({ ...room, mediaNodeId: change.mediaNodeId });
    if ("controlState" in change) rooms.getRecordingControlState.mockResolvedValue(change.controlState);
    await expect(service.issue("rec_test")).rejects.toMatchObject({ response: { code: "BOT_ADMISSION_REJECTED" } });
  });
});
