import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isIntegrationApiEnabled, type ApiConfig } from "../config/api-config.js";
import { IntegrationAuthService } from "./integration-auth.service.js";
import { integrationDisabled } from "./integration-auth.errors.js";
import { IntegrationRateLimiterService } from "./integration-rate-limiter.service.js";

type HttpRequest = {
  headers?: Record<string, string | string[] | undefined>;
  integration?: {
    integrationId: string;
    subject: string;
  };
};

export type IntegrationHttpRequest = HttpRequest & {
  integration: NonNullable<HttpRequest["integration"]>;
};

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class IntegrationAuthGuard implements CanActivate {
  constructor(
    @Inject(IntegrationAuthService) private readonly auth: IntegrationAuthService,
    @Inject(IntegrationRateLimiterService) private readonly rateLimiter: IntegrationRateLimiterService,
    @Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!isIntegrationApiEnabled(this.configSnapshot())) {
      throw integrationDisabled();
    }

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const credential = this.auth.verifyBearerHeader(firstHeader(request.headers?.authorization));

    this.rateLimiter.assertAllowed(credential.integrationId);
    request.integration = {
      integrationId: credential.integrationId,
      subject: credential.subject,
    };

    return true;
  }

  private configSnapshot(): Pick<ApiConfig, "INTEGRATION_API_ENABLED"> {
    return {
      INTEGRATION_API_ENABLED: this.config.get("INTEGRATION_API_ENABLED", { infer: true }),
    };
  }
}
