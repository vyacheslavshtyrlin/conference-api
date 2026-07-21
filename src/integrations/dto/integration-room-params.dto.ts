import { IsString, Matches, MaxLength, MinLength } from "class-validator";

export class IntegrationRoomParamsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  roomId!: string;
}
