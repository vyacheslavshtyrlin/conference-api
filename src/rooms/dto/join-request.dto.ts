import { Transform } from "class-transformer";
import { IsIn, IsString, MaxLength, MinLength } from "class-validator";

export class CreateJoinRequestDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value
  )
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName!: string;
}

export class JoinRequestStatusDto {
  @IsString()
  @MinLength(1)
  requestToken!: string;
}

export class CreatorJoinRequestAuthDto {
  @IsString()
  @MinLength(1)
  participantId!: string;

  @IsString()
  @MinLength(1)
  roomSessionToken!: string;
}

export class DecideJoinRequestDto extends CreatorJoinRequestAuthDto {}

export class JoinRequestParamsDto {
  @IsString()
  @MinLength(1)
  slug!: string;

  @IsString()
  @MinLength(1)
  requestId!: string;
}

export class JoinRequestDecisionParamsDto extends JoinRequestParamsDto {
  @IsIn(["approve", "deny"])
  decision!: "approve" | "deny";
}
