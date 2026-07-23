import { Body, Controller, Inject, Param, Post, Req, UseGuards, ValidationPipe } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { contractErrorOpenApiSchema } from "../rooms/rooms.openapi.js";
import { CreateIntegrationAdmissionDto } from "./dto/create-admission.dto.js";
import { CreateIntegrationRoomDto } from "./dto/create-integration-room.dto.js";
import { IntegrationRoomParamsDto } from "./dto/integration-room-params.dto.js";
import { invalidPayload } from "./integration-auth.errors.js";
import { IntegrationAuthGuard, type IntegrationHttpRequest } from "./integration-auth.guard.js";
import {
  createIntegrationRoomResponseOpenApiSchema,
  createIntegrationAdmissionRequestOpenApiSchema,
  createIntegrationAdmissionResponseOpenApiSchema,
  createIntegrationRoomRequestOpenApiSchema,
} from "./integrations.openapi.js";
import { IntegrationsService } from "./integrations.service.js";

const dtoValidationPipe = (expectedType: new () => object) =>
  new ValidationPipe({
    expectedType,
    exceptionFactory: () => invalidPayload(),
    forbidNonWhitelisted: true,
    transform: true,
    whitelist: true,
  });

@ApiTags("integrations")
@ApiBearerAuth("integration-service-jwt")
@UseGuards(IntegrationAuthGuard)
@Controller("api/integrations/v1/rooms")
export class IntegrationsController {
  constructor(@Inject(IntegrationsService) private readonly integrations: IntegrationsService) {}

  @Post()
  @ApiBody({ schema: createIntegrationRoomRequestOpenApiSchema })
  @ApiCreatedResponse({ schema: createIntegrationRoomResponseOpenApiSchema })
  @ApiBadRequestResponse({ schema: contractErrorOpenApiSchema })
  @ApiUnauthorizedResponse({ schema: contractErrorOpenApiSchema })
  @ApiForbiddenResponse({ schema: contractErrorOpenApiSchema })
  @ApiConflictResponse({ schema: contractErrorOpenApiSchema })
  @ApiTooManyRequestsResponse({ schema: contractErrorOpenApiSchema })
  createIntegrationRoom(
    @Req() request: IntegrationHttpRequest,
    @Body(dtoValidationPipe(CreateIntegrationRoomDto)) body: CreateIntegrationRoomDto
  ) {
    return this.integrations.createRoom({
      integrationId: request.integration.integrationId,
      body,
    });
  }

  @Post(":roomId/admissions")
  @ApiParam({ name: "roomId", example: "room_01H..." })
  @ApiBody({ schema: createIntegrationAdmissionRequestOpenApiSchema })
  @ApiCreatedResponse({ schema: createIntegrationAdmissionResponseOpenApiSchema })
  @ApiBadRequestResponse({ schema: contractErrorOpenApiSchema })
  @ApiUnauthorizedResponse({ schema: contractErrorOpenApiSchema })
  @ApiForbiddenResponse({ schema: contractErrorOpenApiSchema })
  @ApiTooManyRequestsResponse({ schema: contractErrorOpenApiSchema })
  createAdmission(
    @Req() request: IntegrationHttpRequest,
    @Param(dtoValidationPipe(IntegrationRoomParamsDto)) params: IntegrationRoomParamsDto,
    @Body(dtoValidationPipe(CreateIntegrationAdmissionDto)) body: CreateIntegrationAdmissionDto
  ) {
    return this.integrations.createAdmission({
      integrationId: request.integration.integrationId,
      roomId: params.roomId,
      body,
    });
  }

}
