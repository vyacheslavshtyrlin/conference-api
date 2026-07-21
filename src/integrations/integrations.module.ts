import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { RoomsModule } from "../rooms/rooms.module.js";
import { AdmissionsController } from "./admissions.controller.js";
import { IntegrationAuthGuard } from "./integration-auth.guard.js";
import { IntegrationAuthService } from "./integration-auth.service.js";
import { IntegrationRateLimiterService } from "./integration-rate-limiter.service.js";
import { IntegrationsService } from "./integrations.service.js";
import { IntegrationsController } from "./integrations.controller.js";

@Module({
  imports: [ConfigModule, RoomsModule],
  controllers: [IntegrationsController, AdmissionsController],
  providers: [IntegrationAuthGuard, IntegrationAuthService, IntegrationRateLimiterService, IntegrationsService],
})
export class IntegrationsModule {}
