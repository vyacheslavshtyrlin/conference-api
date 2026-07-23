import { Controller, Get, Inject, Param, Req, UseGuards } from "@nestjs/common";
import { IntegrationAuthGuard, type IntegrationHttpRequest } from "./integration-auth.guard.js";
import { IntegrationsService } from "./integrations.service.js";

@UseGuards(IntegrationAuthGuard)
@Controller("api/integrations/v1/rooms")
export class RoomRecordingsController {
  constructor(@Inject(IntegrationsService) private readonly integrations: IntegrationsService) {}

  @Get(":roomId/recordings")
  get(@Req() request: IntegrationHttpRequest, @Param("roomId") roomId: string) {
    return this.integrations.getRoomRecordings(
      request.integration.integrationId,
      roomId,
    );
  }
}