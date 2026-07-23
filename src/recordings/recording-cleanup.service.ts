import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { CallbackDeliveryState, RecordingState } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import type { ApiConfig } from "../config/api-config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { RecordingStorageService } from "./recording-storage.service.js";

@Injectable()
export class RecordingCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(RecordingStorageService) private readonly storage: RecordingStorageService, @Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>) {}
  onModuleInit(): void { if (this.config.get("RECORDING_DELIVERY_ENABLED", { infer: true })) this.timer = setInterval(() => void this.run(), 60_000).unref(); }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  async run(): Promise<void> {
    const expired = await this.prisma.recording.findMany({ where: { state: RecordingState.READY, expiresAt: { lte: new Date() } }, include: { artifacts: true, callbackDeliveries: true }, take: 50 });
    for (const recording of expired) {
      await this.prisma.$transaction(async (tx) => {
        await tx.callbackDelivery.updateMany({ where: { recordingId: recording.id, state: CallbackDeliveryState.PENDING }, data: { state: CallbackDeliveryState.FAILED, lastError: "ARTIFACT_EXPIRED" } });
        await tx.recording.updateMany({ where: { id: recording.id, state: RecordingState.READY }, data: { state: RecordingState.EXPIRED } });
      });
      await Promise.all(recording.artifacts.map((artifact) => this.storage.delete(artifact.objectKey).catch(() => undefined)));
    }
  }
}
