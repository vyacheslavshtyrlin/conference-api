import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { RecordingBotAdmissionResponse } from "#contracts";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { ApiConfig } from "../config/api-config.js";
import { RoomRepository } from "../rooms/room.repository.js";
import { RecordingBotAdmissionStore } from "./recording-bot-admission.store.js";

const audience = "conference-recording-bot-signaling";
const protocolVersion = "recording-bot.v1" as const;

@Injectable()
export class RecordingBotAdmissionService {
  constructor(
    @Inject(RoomRepository) private readonly rooms: RoomRepository,
    @Inject(RecordingBotAdmissionStore) private readonly store: RecordingBotAdmissionStore,
    @Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>
  ) {}

  async issue(recordingId: string): Promise<RecordingBotAdmissionResponse> {
    const owner = await this.rooms.getIntegrationRoomOwnerByRecordingId(recordingId);
    if (!owner || owner.recordingId !== recordingId) throw this.rejected();

    const room = await this.rooms.getRoomById(owner.roomId).catch(() => undefined);
    const activation = await this.rooms.getRecordingActivation(recordingId);
    const controlState = await this.rooms.getRecordingControlState(recordingId);
    // The current single-node recording-control JWT has no media-node claim;
    // assignment is therefore bound to this API instance's configured node.
    const configuredMediaNodeId = this.config.get("MEDIA_NODE_ID", { infer: true });
    if (!room || room.status !== "active" || room.roomId !== owner.roomId || room.mediaNodeId !== configuredMediaNodeId || !activation || controlState !== "capturing") {
      throw this.rejected();
    }

    const issuer = this.config.get("RECORDING_BOT_ADMISSION_JWT_ISSUER", { infer: true });
    const secret = this.config.get("RECORDING_BOT_ADMISSION_JWT_HS256_SECRET", { infer: true });
    if (!issuer || !secret) {
      throw new ServiceUnavailableException({ code: "BOT_ADMISSION_NOT_CONFIGURED", message: "Recording bot admission signing is not configured" });
    }

    const nowSeconds = Math.floor(Date.now() / 1_000);
    const configuredTtl = this.config.get("RECORDING_BOT_ADMISSION_TTL_SECONDS", { infer: true });
    const roomDeadlineSeconds = room.expiresAt ? Math.floor(Date.parse(room.expiresAt) / 1_000) : Number.MAX_SAFE_INTEGER;
    const expiresSeconds = Math.min(nowSeconds + configuredTtl, roomDeadlineSeconds);
    if (expiresSeconds <= nowSeconds) throw this.rejected();

    const expiresAt = new Date(expiresSeconds * 1_000).toISOString();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const jti = randomUUID();
      const jtiHash = createHash("sha256").update(jti).digest("hex");
      const issuedAt = new Date(nowSeconds * 1_000).toISOString();
      const persisted = await this.store.issue(
        jtiHash,
        { roomId: room.roomId, recordingId, mediaNodeId: room.mediaNodeId, issuedAt, expiresAt },
        (expiresSeconds - nowSeconds) * 1_000
      );
      if (!persisted) continue;

      const header = this.encode({ alg: "HS256", typ: "recording-bot+jwt" });
      const payload = this.encode({
        iss: issuer,
        aud: audience,
        sub: "recording-bot",
        roomId: room.roomId,
        recordingId,
        mediaNodeId: room.mediaNodeId,
        jti,
        iat: nowSeconds,
        exp: expiresSeconds,
      });
      const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
      return { protocolVersion, admission: `${header}.${payload}.${signature}`, expiresAt };
    }

    throw new ServiceUnavailableException({ code: "BOT_ADMISSION_ISSUE_FAILED", message: "Recording bot admission could not be issued" });
  }

  private encode(value: object): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  }

  private rejected(): ForbiddenException {
    return new ForbiddenException({ code: "BOT_ADMISSION_REJECTED", message: "Recording bot admission rejected" });
  }
}
