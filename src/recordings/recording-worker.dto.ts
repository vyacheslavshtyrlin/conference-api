import { IsArray, IsInt, IsNumber, IsString, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

export class SegmentUploadItemDto {
  @IsInt() @Min(1) generation!: number;
  @IsInt() @Min(0) sequence!: number;
  @IsInt() @Min(0) timelineStartMs!: number;
  @IsInt() @Min(0) timelineEndMs!: number;
  @IsInt() @Min(1) @Max(2_000_000_000) bytes!: number;
  @IsString() @Matches(/^[a-f0-9]{64}$/) sha256!: string;
}

export class SegmentUploadBatchDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => SegmentUploadItemDto)
  segments!: SegmentUploadItemDto[];
}

export class SegmentCommitDto extends SegmentUploadItemDto {
  @IsString() uploadId!: string;
}

export class CaptureFailureDto {
  @IsString() @Matches(/^[A-Z0-9_:-]{1,128}$/) code!: string;
  @IsString() @MaxLength(512) message!: string;
}

export class ArtifactDto {
  @IsInt() @Min(1) @Max(20_000_000_000) bytes!: number;
  @IsString() @Matches(/^[a-f0-9]{64}$/) sha256!: string;
  @IsNumber() @Min(0.001) @Max(86_400_000) durationSeconds!: number;
  @IsInt() @Min(1) @Max(8_192) width!: number;
  @IsInt() @Min(1) @Max(8_192) height!: number;
  @IsNumber() @Min(1) @Max(240) frameRate!: number;
}

export class CompositionFailureDto extends CaptureFailureDto {}
