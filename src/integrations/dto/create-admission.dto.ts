import { Transform, Type } from "class-transformer";
import {
  IsDefined,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";

export class IntegrationAdmissionIdentityDto {
  @IsIn(["guest", "authenticated"])
  kind!: "guest" | "authenticated";

  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @MinLength(1)
  @MaxLength(160)
  externalSubject!: string;

  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @MinLength(1)
  @MaxLength(80)
  displayName!: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(512)
  avatarUrl?: string;
}

export class CreateIntegrationAdmissionDto {
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => IntegrationAdmissionIdentityDto)
  identity!: IntegrationAdmissionIdentityDto;

  @IsIn(["creator", "none"])
  roomControls!: "creator" | "none";

  @IsISO8601({ strict: true })
  expiresAt!: string;
}
