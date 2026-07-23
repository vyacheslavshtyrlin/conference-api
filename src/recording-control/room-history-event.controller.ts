import { Body, Controller, Inject, Post, UseGuards } from "@nestjs/common";
import { RecordingControlAuthGuard } from "./recording-control-auth.guard.js";
import { RoomHistoryEventService } from "./room-history-event.service.js";
@UseGuards(RecordingControlAuthGuard)
@Controller("internal/v1/room-history")
export class RoomHistoryEventController {
  constructor(@Inject(RoomHistoryEventService) private readonly history: RoomHistoryEventService) {}
  @Post("events") record(@Body() event: Parameters<RoomHistoryEventService["record"]>[0]) { return this.history.record(event); }
}