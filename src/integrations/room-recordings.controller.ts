import { Controller, Get, Header, Inject, Param, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { contractErrorOpenApiSchema } from "../rooms/rooms.openapi.js";
import { IntegrationAuthGuard, type IntegrationHttpRequest } from "./integration-auth.guard.js";
import { IntegrationsService } from "./integrations.service.js";

@UseGuards(IntegrationAuthGuard)
@ApiTags("integration recordings")
@ApiBearerAuth("integration-service-jwt")
@Controller("api/integrations/v1/rooms")
export class RoomRecordingsController {
  constructor(@Inject(IntegrationsService) private readonly integrations: IntegrationsService) {}

  @Get(":roomId/recordings")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Получить записи комнаты", description: "Возвращает записи только текущей integration. Готовая запись содержит короткоживущий presigned URL для прямого скачивания из private S3." })
  @ApiParam({ name: "roomId", example: "room_01H..." })
  @ApiOkResponse({ description: "Список записей комнаты." })
  @ApiUnauthorizedResponse({ schema: contractErrorOpenApiSchema })
  @ApiForbiddenResponse({ schema: contractErrorOpenApiSchema })
  get(@Req() request: IntegrationHttpRequest, @Param("roomId") roomId: string) {
    return this.integrations.getRoomRecordings(
      request.integration.integrationId,
      roomId,
    );
  }
}
