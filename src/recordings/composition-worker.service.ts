import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { CompositionJobState, RecordingState } from "@prisma/client";
import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import type { ApiConfig } from "../config/api-config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { RecordingStorageService } from "./recording-storage.service.js";

@Injectable()
export class CompositionWorkerService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(RecordingStorageService) private readonly storage: RecordingStorageService, @Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>) {}

  async claim() {
    const token = this.storage.randomLease();
    const tokenHash = hash(token);
    const leaseExpiresAt = new Date(Date.now() + this.config.get("RECORDING_COMPOSITION_LEASE_SECONDS", { infer: true }) * 1_000);
    const jobs = await this.prisma.$queryRaw<Array<{ id: string; recordingId: string }>>`
      WITH candidate AS (
        SELECT id FROM "CompositionJob"
        WHERE (state = 'QUEUED' OR (state = 'RUNNING' AND "leaseExpiresAt" < NOW()))
        ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "CompositionJob" job SET state = 'RUNNING', attempts = attempts + 1,
        "leaseTokenHash" = ${tokenHash}, "leaseExpiresAt" = ${leaseExpiresAt}, "updatedAt" = NOW()
      FROM candidate WHERE job.id = candidate.id
      RETURNING job.id, job."recordingId";
    `;
    const job = jobs[0];
    if (!job) return { job: null };
    await this.prisma.recording.updateMany({ where: { id: job.recordingId, state: RecordingState.CAPTURED }, data: { state: RecordingState.COMPOSING } });
    return { job: { jobId: job.id, recordingId: job.recordingId, leaseToken: token, leaseExpiresAt: leaseExpiresAt.toISOString() } };
  }

  async heartbeat(jobId: string, leaseToken: string) {
    const leaseExpiresAt = new Date(Date.now() + this.config.get("RECORDING_COMPOSITION_LEASE_SECONDS", { infer: true }) * 1_000);
    const updated = await this.prisma.compositionJob.updateMany({ where: { id: jobId, state: CompositionJobState.RUNNING, leaseTokenHash: hash(leaseToken), leaseExpiresAt: { gt: new Date() } }, data: { leaseExpiresAt } });
    if (!updated.count) throw staleLease();
    return { leaseExpiresAt: leaseExpiresAt.toISOString() };
  }

  async segments(jobId: string, leaseToken: string, cursor?: string) {
    const job = await this.lease(jobId, leaseToken);
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    const segments = await this.prisma.recordingSegment.findMany({ where: { recordingId: job.recordingId }, orderBy: [{ generation: "asc" }, { sequence: "asc" }], skip: Number.isSafeInteger(offset) && offset > 0 ? offset : 0, take: 100, select: { generation: true, sequence: true, timelineStartMs: true, timelineEndMs: true, bytes: true, sha256: true, objectKey: true } });
    return { segments: await Promise.all(segments.map(async (segment) => ({ generation: segment.generation, sequence: segment.sequence, timelineStartMs: Number(segment.timelineStartMs), timelineEndMs: Number(segment.timelineEndMs), bytes: Number(segment.bytes), sha256: segment.sha256, download: await this.storage.allocateGet(segment.objectKey) }))), nextCursor: segments.length === 100 ? String((Number.isSafeInteger(offset) ? offset : 0) + segments.length) : null };
  }

  async allocateOutput(jobId: string, leaseToken: string, input: ArtifactInput) {
    const job = await this.lease(jobId, leaseToken);
    const objectKey = `final/${job.recordingId}/${jobId}.mp4`;
    const upload = await this.storage.allocatePut({ objectKey, bytes: input.bytes, sha256: input.sha256, contentType: "video/mp4" });
    return { objectKey: undefined, uploadUrl: upload.url, expiresAt: upload.expiresAt };
  }

  async complete(jobId: string, leaseToken: string, input: ArtifactInput) {
    const job = await this.lease(jobId, leaseToken);
    const objectKey = `final/${job.recordingId}/${jobId}.mp4`;
    await this.storage.verify({ objectKey, bytes: input.bytes, sha256: input.sha256, contentType: "video/mp4" });
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.compositionJob.updateMany({ where: { id: jobId, state: CompositionJobState.RUNNING, leaseTokenHash: hash(leaseToken), leaseExpiresAt: { gt: new Date() } }, data: { state: CompositionJobState.COMPLETED, leaseTokenHash: null, leaseExpiresAt: null } });
      if (!claimed.count) throw staleLease();
      const artifact = await tx.recordingArtifact.upsert({ where: { compositionJobId: jobId }, create: { recordingId: job.recordingId, compositionJobId: jobId, objectKey, bytes: BigInt(input.bytes), sha256: input.sha256, contentType: "video/mp4", durationSeconds: input.durationSeconds, width: input.width, height: input.height, frameRate: input.frameRate }, update: {} });
      await tx.recording.update({ where: { id: job.recordingId }, data: { state: RecordingState.READY, readyAt: new Date() } });
      await tx.callbackDelivery.upsert({ where: { recordingId_artifactId_eventType: { recordingId: job.recordingId, artifactId: artifact.id, eventType: "recording.ready" } }, create: { recordingId: job.recordingId, artifactId: artifact.id, eventType: "recording.ready", eventId: `evt_${this.storage.randomLease()}` }, update: {} });
    });
    return { completed: true };
  }

  async fail(jobId: string, leaseToken: string, input: { code: string; message?: string }) {
    const message = (input.message ?? input.code).replace(/[\r\n\t]+/g, " ").slice(0, 2048);
    const job = await this.lease(jobId, leaseToken);
    const failed = await this.prisma.compositionJob.updateMany({ where: { id: jobId, state: CompositionJobState.RUNNING, leaseTokenHash: hash(leaseToken), leaseExpiresAt: { gt: new Date() } }, data: { state: CompositionJobState.FAILED, lastError: message, leaseTokenHash: null, leaseExpiresAt: null } });
    if (!failed.count) throw staleLease();
    await this.prisma.recording.updateMany({ where: { id: job.recordingId, state: { in: [RecordingState.CAPTURED, RecordingState.COMPOSING] } }, data: { state: RecordingState.FAILED, failureCode: input.code, failureMessage: message.slice(0, 512) } });
    return { failed: true };
  }

  private async lease(jobId: string, leaseToken: string) {
    const job = await this.prisma.compositionJob.findFirst({ where: { id: jobId, state: CompositionJobState.RUNNING, leaseTokenHash: hash(leaseToken), leaseExpiresAt: { gt: new Date() } }, select: { recordingId: true } });
    if (!job) throw staleLease();
    return job;
  }
}
export type ArtifactInput = { bytes: number; sha256: string; durationSeconds: number; width: number; height: number; frameRate: number; };
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function staleLease(): ConflictException { return new ConflictException({ code: "STALE_LEASE", message: "Composition lease is stale" }); }
