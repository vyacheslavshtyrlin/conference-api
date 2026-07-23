import { Inject, Injectable } from "@nestjs/common";
import { RecordingState } from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service.js";

export type RequestedRecording = {
  recordingId: string;
  roomId: string | null;
};

@Injectable()
export class RecordingRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async ensureRequested(input: {
    recordingId: string;
    integrationId: string;
    externalRoomId: string;
    requestFingerprint: string;
    expiresAt: Date;
  }): Promise<RequestedRecording> {
    const externalRoomHash = sha256(input.externalRoomId);
    const existing = await this.prisma.recording.findUnique({
      where: {
        integrationId_externalRoomHash: {
          integrationId: input.integrationId,
          externalRoomHash,
        },
      },
      select: { id: true, roomId: true, requestFingerprint: true },
    });
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new RecordingRequestConflictError();
      }
      return { recordingId: existing.id, roomId: existing.roomId };
    }

    try {
      const recording = await this.prisma.recording.create({
        data: {
          id: input.recordingId,
          integrationId: input.integrationId,
          externalRoomHash,
          requestFingerprint: input.requestFingerprint,
          expiresAt: input.expiresAt,
          state: RecordingState.REQUESTED,
        },
        select: { id: true, roomId: true },
      });
      return { recordingId: recording.id, roomId: recording.roomId };
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      return this.ensureRequested(input);
    }
  }

  async attachRoom(recordingId: string, roomId: string): Promise<void> {
    const result = await this.prisma.recording.updateMany({
      where: { id: recordingId, roomId: null, state: RecordingState.REQUESTED },
      data: { roomId },
    });
    if (result.count === 1) return;
    const existing = await this.prisma.recording.findUnique({
      where: { id: recordingId },
      select: { roomId: true },
    });
    if (existing?.roomId === roomId) return;
    throw new Error("recording room ownership conflict");
  }
}

export class RecordingRequestConflictError extends Error {}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
