import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from "class-validator";

export class InitialIntegrationUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}

export class CreateIntegrationRoomDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9._:-]+$/)
  externalRoomId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsIn(["approval"])
  accessPolicy?: "approval";

  @IsOptional()
  @IsBoolean()
  recordingRequested?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => InitialIntegrationUserDto)
  initialUser?: InitialIntegrationUserDto;
}
