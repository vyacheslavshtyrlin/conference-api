import { Controller, Get, Header, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { IntegrationAuthGuard, type IntegrationHttpRequest } from "./integration-auth.guard.js";
import { IntegrationsService } from "./integrations.service.js";

@UseGuards(IntegrationAuthGuard)
@Controller("api/integrations/v1/recordings")
export class RecordingStatusController {
  constructor(@Inject(IntegrationsService) private readonly integrations: IntegrationsService) {}
  @Get(":recordingId")
  @Header("Cache-Control", "private, no-store")
  get(@Req() request: IntegrationHttpRequest, @Param("recordingId") recordingId: string) {
    return this.integrations.getRecording(request.integration.integrationId, recordingId);
  }
  @Post(":recordingId/callbacks/retry")
  retry(@Req() request: IntegrationHttpRequest, @Param("recordingId") recordingId: string) {
    return this.integrations.retryRecordingCallback(request.integration.integrationId, recordingId);
  }
}
