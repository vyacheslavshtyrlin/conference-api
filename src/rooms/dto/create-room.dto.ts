import { IsIn, IsOptional } from "class-validator";

export class CreateRoomDto {
  @IsOptional()
  @IsIn(["link", "approval"])
  accessPolicy?: "link" | "approval";
}
