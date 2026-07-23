import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { RecordingControlProjection, RecordingProjection } from "#contracts";
import type { ApiConfig } from "../config/api-config.js";
import { RoomRepository } from "../rooms/room.repository.js";

@Injectable()
export class RecordingControlService {
  constructor(
    @Inject(RoomRepository) private readonly rooms: RoomRepository,
    @Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>
  ) {}

  async lookup(roomId: string): Promise<RecordingControlProjection | undefined> {
    const owner = await this.rooms.getIntegrationRoomOwner(roomId);
    if (!owner?.recordingId) return undefined;
    return this.controlProject(
      owner.integrationId,
      owner.recordingId,
      owner.createdAt,
      await this.rooms.getRecordingControlState(owner.recordingId)
    );
  }

  async activate(roomId: string): Promise<RecordingControlProjection | undefined> {
    const owner = await this.rooms.getIntegrationRoomOwner(roomId);
    if (!owner?.recordingId) return undefined;
    const room = await this.rooms.getRoomById(roomId);
    return this.controlProject(
      owner.integrationId,
      owner.recordingId,
      owner.createdAt,
      await this.rooms.activateRecording(
        owner.recordingId,
        room.expiresAt
      )
    );
  }

  async closeInputs(recordingId: string): Promise<RecordingProjection | undefined> {
    const owner = await this.rooms.getIntegrationRoomOwnerByRecordingId(recordingId);
    if (!owner?.recordingId || (await this.rooms.closeRecordingInputs(owner.recordingId)) === "inactive") return undefined;
    return this.project(owner.recordingId, "finalizing");
  }

  private project(recordingId: string, status: RecordingProjection["status"]): RecordingProjection {
    return { recordingId, status };
  }

  private controlProject(
    integrationId: string,
    recordingId: string,
    requestedAt: string,
    status: RecordingControlProjection["status"]
  ): RecordingControlProjection {
    return { integrationId, recordingId, requestedAt, status };
  }
}
