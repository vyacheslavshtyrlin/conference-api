import { ConflictException, GoneException, NotFoundException, UnauthorizedException } from "@nestjs/common";

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

export function roomFull() {
  return new ConflictException({
    code: "ROOM_FULL",
    message: "Room is full",
  });
}

export function invalidToken(message = "Invalid token") {
  return new UnauthorizedException({
    code: "INVALID_TOKEN",
    message,
  });
}
