import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { RoomsModule } from "../rooms/rooms.module.js";
import { RedisModule } from "../redis/redis.module.js";
import { RecordingControlAuthGuard } from "./recording-control-auth.guard.js";
import { RecordingControlAuthService } from "./recording-control-auth.service.js";
import { RecordingControlController } from "./recording-control.controller.js";
import { RecordingControlService } from "./recording-control.service.js";
import { RecordingBotAdmissionService } from "./recording-bot-admission.service.js";
import { RecordingBotAdmissionStore } from "./recording-bot-admission.store.js";
import { RoomHistoryEventController } from "./room-history-event.controller.js";
import { RoomHistoryEventService } from "./room-history-event.service.js";

@Module({
  imports: [ConfigModule, RedisModule, RoomsModule],
  controllers: [RecordingControlController, RoomHistoryEventController],
  providers: [
    RecordingControlAuthGuard,
    RecordingControlAuthService,
    RecordingControlService,
    RecordingBotAdmissionService,
    RecordingBotAdmissionStore, RoomHistoryEventService,
  ],
})
export class RecordingControlModule {}
