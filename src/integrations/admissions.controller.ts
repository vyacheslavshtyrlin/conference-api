import { Body, Controller, HttpCode, Inject, Post, ValidationPipe } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBody, ApiOkResponse, ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { contractErrorOpenApiSchema } from "../rooms/rooms.openapi.js";
import { ExchangeAdmissionDto } from "./dto/exchange-admission.dto.js";
import { invalidPayload } from "./integration-auth.errors.js";
import { exchangeAdmissionRequestOpenApiSchema, exchangeAdmissionResponseOpenApiSchema } from "./integrations.openapi.js";
import { IntegrationsService } from "./integrations.service.js";

const dtoValidationPipe = (expectedType: new () => object) =>
  new ValidationPipe({
    expectedType,
    exceptionFactory: () => invalidPayload(),
    forbidNonWhitelisted: true,
    transform: true,
    whitelist: true,
  });

@ApiTags("admissions")
@Controller("admissions")
export class AdmissionsController {
  constructor(@Inject(IntegrationsService) private readonly integrations: IntegrationsService) {}

  @Post("exchange")
  @HttpCode(200)
  @ApiBody({ schema: exchangeAdmissionRequestOpenApiSchema })
  @ApiOkResponse({ schema: exchangeAdmissionResponseOpenApiSchema })
  @ApiBadRequestResponse({ schema: contractErrorOpenApiSchema })
  @ApiUnauthorizedResponse({ schema: contractErrorOpenApiSchema })
  exchange(@Body(dtoValidationPipe(ExchangeAdmissionDto)) body: ExchangeAdmissionDto) {
    return this.integrations.exchangeAdmission(body);
  }
}
