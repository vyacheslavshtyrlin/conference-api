import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { RecordingRepository } from "./recording.repository.js";
import { RecordingStorageService } from "./recording-storage.service.js";
import { RecordingWorkerAuthGuard, CompositionWorkerAuthGuard } from "./recording-worker-auth.guard.js";
import { RecordingWorkerController } from "./recording-worker.controller.js";
import { RecordingWorkerService } from "./recording-worker.service.js";
import { CompositionWorkerService } from "./composition-worker.service.js";
import { CompositionWorkerController } from "./composition-worker.controller.js";
import { CallbackDispatcherService } from "./callback-dispatcher.service.js";
import { RecordingCleanupService } from "./recording-cleanup.service.js";

@Module({
  imports: [ConfigModule],
  controllers: [RecordingWorkerController, CompositionWorkerController],
  providers: [RecordingRepository, RecordingStorageService, RecordingWorkerService, CompositionWorkerService, CallbackDispatcherService, RecordingCleanupService, RecordingWorkerAuthGuard, CompositionWorkerAuthGuard],
  exports: [RecordingRepository, RecordingStorageService, RecordingWorkerService, CompositionWorkerAuthGuard],
})
export class RecordingsModule {}
