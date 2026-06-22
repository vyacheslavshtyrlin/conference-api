import { Transform } from "class-transformer";
import { IsString, MinLength } from "class-validator";

export class SessionRefreshDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value
  )
  @IsString()
  @MinLength(1)
  participantId!: string;

  @IsString()
  @MinLength(1)
  roomSessionToken!: string;
}
