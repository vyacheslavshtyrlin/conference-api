import { ForbiddenException, GoneException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";

export function roomNotFound() {
  return new NotFoundException({
    code: "ROOM_NOT_FOUND",
    message: "Room not found",
  });
}

export function roomExpired() {
  return new GoneException({
    code: "ROOM_EXPIRED",
    message: "Room expired",
  });
}

export function roomClosed() {
  return new GoneException({
    code: "ROOM_CLOSED",
    message: "Room closed",
  });
}

export function invalidToken(message = "Invalid token") {
  return new UnauthorizedException({
    code: "INVALID_TOKEN",
    message,
  });
}

export function approvalRequired() {
  return new ForbiddenException({
    code: "APPROVAL_REQUIRED",
    message: "Room requires creator approval",
  });
}

export function authNotConfigured() {
  return new ServiceUnavailableException({
    code: "AUTH_NOT_CONFIGURED",
    message: "Trusted cookie authentication is not configured",
  });
}
