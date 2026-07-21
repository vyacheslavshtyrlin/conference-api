import { ApiProperty } from "@nestjs/swagger";

export class AppConfigResponseDto {
  @ApiProperty({ example: false, type: Boolean })
  authCookieEnabled!: boolean;

  @ApiProperty({ example: false, type: Boolean })
  integrationApiEnabled!: boolean;

  @ApiProperty({
    nullable: true,
    example: "https://users.example.com/login",
    type: String,
  })
  loginUrl!: string | null;

  @ApiProperty({
    nullable: true,
    example: { displayName: "Anna Ivanova", avatarUrl: "https://users.example/avatars/4821.png" },
    type: Object,
  })
  identity!: { displayName: string; avatarUrl?: string } | null;
}
