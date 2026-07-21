import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class ExchangeAdmissionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  code!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  roomId?: string;
}
