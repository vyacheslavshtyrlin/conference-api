import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { CompositionJobState, RecordingState } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service.js";
import { RecordingStorageService } from "./recording-storage.service.js";
import type { SegmentUploadItemDto } from "./recording-worker.dto.js";

@Injectable()
export class RecordingWorkerService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(RecordingStorageService) private readonly storage: RecordingStorageService) {}

  async allocateSegments(recordingId: string, segments: SegmentUploadItemDto[]) {
    await this.requireCapturing(recordingId);
    return Promise.all(segments.map(async (segment) => {
      this.validateSegment(segment);
      const objectKey = segmentKey(recordingId, segment.generation, segment.sequence);
      const expiresAt = Math.floor(Date.now() / 1_000) + 900;
      const uploadId = this.storage.signUpload({ recordingId, ...segment, objectKey, exp: expiresAt });
      const target = await this.storage.allocatePut({ objectKey, bytes: segment.bytes, sha256: segment.sha256, contentType: "video/webm" });
      return { uploadId, sequence: segment.sequence, generation: segment.generation, uploadUrl: target.url, expiresAt: target.expiresAt };
    }));
  }

  async commitSegment(recordingId: string, input: SegmentUploadItemDto & { uploadId: string }) {
    const allocation = this.storage.verifyUpload(input.uploadId);
    if (!allocation || allocation.recordingId !== recordingId || !sameAllocation(allocation, input)) {
      throw new ConflictException({ code: "SEGMENT_CONFLICT", message: "Segment upload allocation is invalid" });
    }
    const objectKey = String(allocation.objectKey);
    await this.storage.verify({ objectKey, bytes: input.bytes, sha256: input.sha256, contentType: "video/webm" });
    const existing = await this.prisma.recordingSegment.findUnique({
      where: { recordingId_generation_sequence: { recordingId, generation: input.generation, sequence: input.sequence } },
    });
    if (existing) {
      if (existing.sha256 === input.sha256 && existing.bytes === BigInt(input.bytes) && existing.timelineStartMs === BigInt(input.timelineStartMs) && existing.timelineEndMs === BigInt(input.timelineEndMs)) return { committed: true };
      throw new ConflictException({ code: "SEGMENT_CONFLICT", message: "Segment identity conflicts" });
    }
    await this.requireCapturing(recordingId);
    await this.prisma.recordingSegment.create({ data: { recordingId, generation: input.generation, sequence: input.sequence, timelineStartMs: BigInt(input.timelineStartMs), timelineEndMs: BigInt(input.timelineEndMs), bytes: BigInt(input.bytes), sha256: input.sha256, objectKey, contentType: "video/webm" } });
    return { committed: true };
  }

  async failCapture(recordingId: string, input: { code: string; message: string }) {
    const failureMessage = input.message.replace(/[\r\n\t]+/g, " ").trim().slice(0, 512);
    const result = await this.prisma.recording.updateMany({
      where: { id: recordingId, state: { in: [RecordingState.REQUESTED, RecordingState.CAPTURING] } },
      data: { state: RecordingState.FAILED, failureCode: input.code, failureMessage },
    });
    if (result.count === 1) return { failed: true };
    const existing = await this.prisma.recording.findUnique({ where: { id: recordingId }, select: { state: true } });
    if (!existing) throw new NotFoundException();
    if (existing.state === RecordingState.FAILED) return { failed: true };
    throw new ConflictException({ code: "RECORDING_STATE_CONFLICT", message: "Recording cannot be failed" });
  }

  async seal(recordingId: string) {
    return this.prisma.$transaction(async (tx) => {
      const recording = await tx.recording.findUnique({ where: { id: recordingId }, select: { state: true } });
      if (!recording) throw new NotFoundException();
      if (recording.state === RecordingState.CAPTURED || recording.state === RecordingState.COMPOSING || recording.state === RecordingState.READY) return { sealed: true };
      if (recording.state !== RecordingState.CAPTURING) throw new ConflictException({ code: "RECORDING_STATE_CONFLICT", message: "Recording cannot be sealed" });
      const count = await tx.recordingSegment.count({ where: { recordingId } });
      if (count === 0) throw new ConflictException({ code: "RECORDING_STATE_CONFLICT", message: "Recording has no segments" });
      await tx.recording.update({ where: { id: recordingId }, data: { state: RecordingState.CAPTURED, capturedAt: new Date() } });
      await tx.compositionJob.upsert({ where: { recordingId_version: { recordingId, version: 1 } }, create: { recordingId, version: 1, state: CompositionJobState.QUEUED }, update: {} });
      return { sealed: true };
    });
  }

  private async requireCapturing(recordingId: string): Promise<void> {
    const recording = await this.prisma.recording.findUnique({ where: { id: recordingId }, select: { state: true, roomId: true } });
    if (!recording) throw new NotFoundException();
    if (!recording.roomId || (recording.state !== RecordingState.REQUESTED && recording.state !== RecordingState.CAPTURING)) throw new ConflictException({ code: "RECORDING_STATE_CONFLICT", message: "Recording is not accepting segments" });
    if (recording.state === RecordingState.REQUESTED) await this.prisma.recording.update({ where: { id: recordingId }, data: { state: RecordingState.CAPTURING } });
  }

  private validateSegment(segment: SegmentUploadItemDto): void {
    if (segment.timelineEndMs < segment.timelineStartMs) throw new ConflictException({ code: "SEGMENT_CONFLICT", message: "Invalid segment timeline" });
  }
}

function segmentKey(recordingId: string, generation: number, sequence: number): string { return `raw/${recordingId}/generations/${generation}/segments/${sequence}.webm`; }
function sameAllocation(allocation: Record<string, unknown>, input: SegmentUploadItemDto): boolean { return ["generation", "sequence", "timelineStartMs", "timelineEndMs", "bytes", "sha256"].every((key) => String(allocation[key]) === String(input[key as keyof SegmentUploadItemDto])); }
