import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AppConfigController } from "./app-config.controller.js";
import { AppConfigService } from "./app-config.service.js";

@Module({
  imports: [AuthModule],
  controllers: [AppConfigController],
  providers: [AppConfigService],
})
export class AppConfigModule {}
