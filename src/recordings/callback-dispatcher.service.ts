import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CallbackDeliveryState } from "@prisma/client";
import { createHmac } from "node:crypto";
import type { ApiConfig } from "../config/api-config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { RecordingStorageService } from "./recording-storage.service.js";

@Injectable()
export class CallbackDispatcherService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>, @Inject(RecordingStorageService) private readonly storage: RecordingStorageService) {}
  onModuleInit(): void { if (this.config.get("RECORDING_DELIVERY_ENABLED", { infer: true })) this.timer = setInterval(() => void this.dispatchDue(), 5_000).unref(); }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  async dispatchDue(): Promise<void> {
    const deliveries = await this.prisma.callbackDelivery.findMany({ where: { state: CallbackDeliveryState.PENDING, nextAttemptAt: { lte: new Date() } }, take: 20, include: { recording: true, artifact: true } });
    for (const delivery of deliveries) await this.dispatch(delivery).catch(() => undefined);
  }
  private async dispatch(delivery: Awaited<ReturnType<PrismaService["callbackDelivery"]["findMany"]>>[number] & { recording: { integrationId: string; id: string }; artifact: { objectKey: string; bytes: bigint; contentType: string } }): Promise<void> {
    const credentials = this.config.get("INTEGRATION_JWT_CREDENTIALS_JSON", { infer: true }) ?? [];
    const callback = credentials.find((item) => item.integrationId === delivery.recording.integrationId)?.recordingCallback;
    if (!callback) return this.markFailed(delivery.id, "CALLBACK_NOT_CONFIGURED");
    const download = await this.storage.allocatePublicGet(delivery.artifact.objectKey);
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ eventId: delivery.eventId, type: "recording.ready", occurredAt: timestamp, recordingId: delivery.recording.id, artifact: { bytes: Number(delivery.artifact.bytes), contentType: delivery.artifact.contentType, downloadUrl: download.url, downloadUrlExpiresAt: download.expiresAt } });
    try {
      const response = await fetch(callback.baseUrl, { method: "POST", headers: { "content-type": "application/json", "x-conference-timestamp": timestamp, "x-conference-signature": createHmac("sha256", callback.hs256Secret).update(`${timestamp}.${body}`).digest("hex") }, body, signal: AbortSignal.timeout(10_000) });
      if (response.ok) { await this.prisma.callbackDelivery.update({ where: { id: delivery.id }, data: { state: CallbackDeliveryState.DELIVERED, deliveredAt: new Date(), attempts: { increment: 1 } } }); return; }
      if (![408, 425, 429].includes(response.status) && response.status < 500) return this.markFailed(delivery.id, `HTTP_${response.status}`);
      await this.retry(delivery.id, delivery.attempts + 1, `HTTP_${response.status}`);
    } catch { await this.retry(delivery.id, delivery.attempts + 1, "NETWORK_ERROR"); }
  }
  private async retry(id: string, attempts: number, error: string): Promise<void> { if (attempts >= 12) return this.markFailed(id, error); await this.prisma.callbackDelivery.update({ where: { id }, data: { attempts, lastError: error, nextAttemptAt: new Date(Date.now() + Math.min(3_600_000, 1_000 * 2 ** attempts)) } }); }
  private async markFailed(id: string, error: string): Promise<void> { await this.prisma.callbackDelivery.update({ where: { id }, data: { state: CallbackDeliveryState.FAILED, lastError: error } }); }
}
