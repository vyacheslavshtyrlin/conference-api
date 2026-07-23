import { IsString, Matches } from "class-validator";

export class RecordingControlRoomParamsDto {
  @IsString()
  @Matches(/^room_[a-zA-Z0-9-]+$/)
  roomId!: string;
}

export class RecordingControlRecordingParamsDto {
  @IsString()
  @Matches(/^rec_[a-zA-Z0-9-]+$/)
  recordingId!: string;
}
