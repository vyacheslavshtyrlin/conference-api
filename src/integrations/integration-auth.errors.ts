import {
  ForbiddenException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotImplementedException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

export function invalidPayload() {
  return new BadRequestException({
    code: "INVALID_PAYLOAD",
    message: "Invalid payload",
  });
}

export function invalidIntegrationCredential() {
  return new UnauthorizedException({
    code: "INVALID_TOKEN",
    message: "Invalid integration credential",
  });
}

export function integrationAuthNotConfigured() {
  return new ServiceUnavailableException({
    code: "INTEGRATION_AUTH_NOT_CONFIGURED",
    message: "Integration authentication is not configured",
  });
}

export function integrationForbidden() {
  return new ForbiddenException({
    code: "INTEGRATION_FORBIDDEN",
    message: "Integration credential is not allowed to call this endpoint",
  });
}

export function integrationDisabled() {
  return new ForbiddenException({
    code: "INTEGRATION_FORBIDDEN",
    message: "Integration API is disabled",
  });
}

export function integrationConflict(message = "Integration request conflicts with an existing room mapping") {
  return new ConflictException({
    code: "INTEGRATION_CONFLICT",
    message,
  });
}

export function integrationRateLimited() {
  return new HttpException(
    {
      code: "RATE_LIMITED",
      message: "Integration request rate limit exceeded",
    },
    HttpStatus.TOO_MANY_REQUESTS
  );
}

export function integrationFeatureNotImplemented() {
  return new NotImplementedException({
    code: "INTEGRATION_NOT_IMPLEMENTED",
    message: "Integration room and admission commands are not implemented in this slice",
  });
}
