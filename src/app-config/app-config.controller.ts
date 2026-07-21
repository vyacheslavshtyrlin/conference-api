import { Controller, Get, Headers, Inject } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { AppConfigResponse } from "#contracts";
import { AppConfigService } from "./app-config.service.js";
import { AppConfigResponseDto } from "./dto/app-config-response.dto.js";

@ApiTags("app-config")
@Controller("app-config")
export class AppConfigController {
  constructor(@Inject(AppConfigService) private readonly appConfig: AppConfigService) {}

  @Get()
  @ApiOkResponse({ type: AppConfigResponseDto })
  getAppConfig(@Headers("cookie") cookieHeader?: string | string[]): AppConfigResponse {
    return this.appConfig.getPublicConfig(cookieHeader);
  }
}
