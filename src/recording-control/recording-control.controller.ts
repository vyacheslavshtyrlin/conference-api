import { Controller, Get, HttpStatus, Inject, Param, Post, Res, UseGuards, ValidationPipe } from "@nestjs/common";
import { RecordingControlAuthGuard } from "./recording-control-auth.guard.js";
import { RecordingControlService } from "./recording-control.service.js";
import { RecordingBotAdmissionService } from "./recording-bot-admission.service.js";
import { RecordingControlRecordingParamsDto, RecordingControlRoomParamsDto } from "./dto/recording-control-params.dto.js";

const paramsPipe = (expectedType: new () => object) =>
  new ValidationPipe({ expectedType, forbidNonWhitelisted: true, transform: true, whitelist: true });

@UseGuards(RecordingControlAuthGuard)
@Controller("internal/v1")
export class RecordingControlController {
  constructor(
    @Inject(RecordingControlService) private readonly recordings: RecordingControlService,
    @Inject(RecordingBotAdmissionService) private readonly botAdmissions: RecordingBotAdmissionService
  ) {}

  @Get("rooms/:roomId/recording")
  async lookup(
    @Param(paramsPipe(RecordingControlRoomParamsDto)) params: RecordingControlRoomParamsDto,
    @Res({ passthrough: true }) response: { status(code: number): unknown }
  ) {
    const recording = await this.recordings.lookup(params.roomId);
    if (!recording) response.status(HttpStatus.NO_CONTENT);
    return recording;
  }

  @Post("rooms/:roomId/recording/activate")
  async activate(
    @Param(paramsPipe(RecordingControlRoomParamsDto)) params: RecordingControlRoomParamsDto,
    @Res({ passthrough: true }) response: { status(code: number): unknown }
  ) {
    const recording = await this.recordings.activate(params.roomId);
    if (!recording) response.status(HttpStatus.NO_CONTENT);
    return recording;
  }

  @Post("recordings/:recordingId/close-inputs")
  async closeInputs(
    @Param(paramsPipe(RecordingControlRecordingParamsDto)) params: RecordingControlRecordingParamsDto,
    @Res({ passthrough: true }) response: { status(code: number): unknown }
  ) {
    const recording = await this.recordings.closeInputs(params.recordingId);
    if (!recording) response.status(HttpStatus.NO_CONTENT);
    return recording;
  }

  @Post("recordings/:recordingId/bot-admissions")
  issueBotAdmission(
    @Param(paramsPipe(RecordingControlRecordingParamsDto)) params: RecordingControlRecordingParamsDto
  ) {
    return this.botAdmissions.issue(params.recordingId);
  }
}
