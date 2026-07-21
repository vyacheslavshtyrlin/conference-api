import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TrustedCookieAuthService } from "./trusted-cookie-auth.service.js";

@Module({
  imports: [ConfigModule],
  providers: [TrustedCookieAuthService],
  exports: [TrustedCookieAuthService],
})
export class AuthModule {}
