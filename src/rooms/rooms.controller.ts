import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, ValidationPipe } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import type {
  CreateJoinRequestResponse,
  CreateRoomAdmissionResponse,
  CreateRoomResponse,
  DecideJoinRequestResponse,
  GetRoomResponse,
  JoinRoomResponse,
  JoinRequestStatusResponse,
  ListJoinRequestsResponse,
  RoomSessionRefreshResponse,
} from "#contracts";
import { TrustedCookieAuthService } from "../auth/trusted-cookie-auth.service.js";
import { CreateRoomDto } from "./dto/create-room.dto.js";
import {
  CreateJoinRequestDto,
  CreatorJoinRequestAuthDto,
  DecideJoinRequestDto,
  JoinRequestDecisionParamsDto,
  JoinRequestParamsDto,
  JoinRequestStatusDto,
} from "./dto/join-request.dto.js";
import { JoinRoomDto } from "./dto/join-room.dto.js";
import { RoomParamsDto } from "./dto/room-params.dto.js";
import { SessionRefreshDto } from "./dto/session-refresh.dto.js";
import {
  contractErrorOpenApiSchema,
  createJoinRequestRequestOpenApiSchema,
  createJoinRequestResponseOpenApiSchema,
  createRoomAdmissionRequestOpenApiSchema,
  createRoomAdmissionResponseOpenApiSchema,
  createRoomRequestOpenApiSchema,
  createRoomResponseOpenApiSchema,
  decideJoinRequestRequestOpenApiSchema,
  decideJoinRequestResponseOpenApiSchema,
  getRoomResponseOpenApiSchema,
  joinRequestStatusRequestOpenApiSchema,
  joinRequestStatusResponseOpenApiSchema,
  joinRoomRequestOpenApiSchema,
  joinRoomResponseOpenApiSchema,
  listJoinRequestsRequestOpenApiSchema,
  listJoinRequestsResponseOpenApiSchema,
  roomSessionRefreshRequestOpenApiSchema,
  roomSessionRefreshResponseOpenApiSchema,
} from "./rooms.openapi.js";
import { RoomsService } from "./rooms.service.js";

const dtoValidationPipe = (expectedType: new () => object) =>
  new ValidationPipe({
    expectedType,
    forbidNonWhitelisted: true,
    transform: true,
    whitelist: true,
  });

@Controller("rooms")
@ApiTags("rooms")
export class RoomsController {
  constructor(
    @Inject(RoomsService) private readonly rooms: RoomsService,
    @Inject(TrustedCookieAuthService) private readonly trustedCookieAuth: TrustedCookieAuthService
  ) {}

  @Post()
  @ApiBody({ schema: createRoomRequestOpenApiSchema })
  @ApiCreatedResponse({ schema: createRoomResponseOpenApiSchema })
  @ApiBadRequestResponse({ schema: contractErrorOpenApiSchema })
  createRoom(
    @Body(dtoValidationPipe(CreateRoomDto)) body: CreateRoomDto,
    @Headers("cookie") cookieHeader?: string | string[]
  ): Promise<CreateRoomResponse> {
    return this.rooms.createRoom(body, this.trustedCookieAuth.resolve(cookieHeader));
  }

  @Get(":slug")
  @ApiParam({ name: "slug", example: "x7k2q9" })
  @ApiOkResponse({ schema: getRoomResponseOpenApiSchema })
  @ApiNotFoundResponse({ schema: contractErrorOpenApiSchema })
  @ApiGoneResponse({ schema: contractErrorOpenApiSchema })
  getRoom(@Param(dtoValidationPipe(RoomParamsDto)) params: RoomParamsDto): Promise<GetRoomResponse> {
    return this.rooms.getRoom(params.slug);
  }

  @Post(":slug/join")
  @ApiParam({ name: "slug", example: "x7k2q9" })
  @ApiBody({ schema: joinRoomRequestOpenApiSchema })
  @ApiCreatedResponse({ schema: joinRoomResponseOpenApiSchema })
  @ApiBadRequestResponse({ schema: contractErrorOpenApiSchema })
  @ApiNotFoundResponse({ schema: contractErrorOpenApiSchema })
  @ApiGoneResponse({ schema: contractErrorOpenApiSchema })
  @ApiUnauthorizedResponse({ schema: contractErrorOpenApiSchema })
  joinRoom(
    @Param(dtoValidationPipe(RoomParamsDto)) params: RoomParamsDto,
    @Body(dtoValidationPipe(JoinRoomDto)) body: JoinRoomDto,
    @Headers("cookie") cookieHeader?: string | string[]
  ): Promise<JoinRoomResponse> {
    return this.rooms.joinRoom(params.slug, body.displayName, body.roomSessionToken, this.trustedCookieAuth.resolve(cookieHeader));
  }

  @Post(":slug/join-requests")
  @ApiParam({ name: "slug", example: "x7k2q9" })
  @ApiBody({ schema: createJoinRequestRequestOpenApiSchema })
  @ApiCreatedResponse({ schema: createJoinRequestResponseOpenApiSchema })
  @ApiBadRequestResponse({ schema: contractErrorOpenApiSchema })
  @ApiNotFoundResponse({ schema: contractErrorOpenApiSchema })
  @ApiGoneResponse({ schema: contractErrorOpenApiSchema })
  createJoinRequest(
    @Param(dtoValidationPipe(RoomParamsDto)) params: RoomParamsDto,
    @Body(dtoValidationPipe(CreateJoinRequestDto)) body: CreateJoinRequestDto,
    @Headers("cookie") cookieHeader?: string | string[]
  ): Promise<CreateJoinRequestResponse> {
    return this.rooms.createJoinRequest(params.slug, body.displayName, this.trustedCookieAuth.resolve(cookieHeader));
  }

  @Post(":slug/join-requests/list")
  @HttpCode(200)
  @ApiParam({ name: "slug", example: "x7k2q9" })
  @ApiBody({ schema: listJoinRequestsRequestOpenApiSchema })
  @ApiOkResponse({ schema: listJoinRequestsResponseOpenApiSchema })
  @ApiUnauthorizedResponse({ schema: contractErrorOpenApiSchema })
  listJoinRequests(
    @Param(dtoValidationPipe(RoomParamsDto)) params: RoomParamsDto,
    @Body(dtoValidationPipe(CreatorJoinRequestAuthDto)) body: CreatorJoinRequestAuthDto
  ): Promise<ListJoinRequestsResponse> {
    return this.rooms.listJoinRequests(params.slug, body.participantId, body.roomSessionToken);
  }

  @Post(":slug/admissions")
  @ApiParam({ name: "slug", example: "x7k2q9" })
  @ApiBody({ schema: createRoomAdmissionRequestOpenApiSchema })
  @ApiCreatedResponse({ schema: createRoomAdmissionResponseOpenApiSchema })
  @ApiUnauthorizedResponse({ schema: contractErrorOpenApiSchema })
  @ApiNotFoundResponse({ schema: contractErrorOpenApiSchema })
  @ApiGoneResponse({ schema: contractErrorOpenApiSchema })
  createRoomAdmission(
    @Param(dtoValidationPipe(RoomParamsDto)) params: RoomParamsDto,
    @Body(dtoValidationPipe(CreatorJoinRequestAuthDto)) body: CreatorJoinRequestAuthDto
  ): Promise<CreateRoomAdmissionResponse> {
    return this.rooms.createRoomAdmission(params.slug, body.participantId, body.roomSessionToken);
  }

  @Post(":slug/join-requests/:requestId/status")
  @HttpCode(200)
  @ApiParam({ name: "slug", example: "x7k2q9" })
  @ApiParam({ name: "requestId", example: "join_01H..." })
  @ApiBody({ schema: joinRequestStatusRequestOpenApiSchema })
  @ApiOkResponse({ schema: joinRequestStatusResponseOpenApiSchema })
  @ApiUnauthorizedResponse({ schema: contractErrorOpenApiSchema })
  getJoinRequestStatus(
    @Param(dtoValidationPipe(JoinRequestParamsDto)) params: JoinRequestParamsDto,
    @Body(dtoValidationPipe(JoinRequestStatusDto)) body: JoinRequestStatusDto
  ): Promise<JoinRequestStatusResponse> {
    return this.rooms.getJoinRequestStatus(params.slug, params.requestId, body.requestToken);
  }

  @Post(":slug/join-requests/:requestId/:decision")
  @HttpCode(200)
  @ApiParam({ name: "slug", example: "x7k2q9" })
  @ApiParam({ name: "requestId", example: "join_01H..." })
  @ApiParam({ name: "decision", enum: ["approve", "deny"] })
  @ApiBody({ schema: decideJoinRequestRequestOpenApiSchema })
  @ApiOkResponse({ schema: decideJoinRequestResponseOpenApiSchema })
  @ApiUnauthorizedResponse({ schema: contractErrorOpenApiSchema })
  decideJoinRequest(
    @Param(dtoValidationPipe(JoinRequestDecisionParamsDto)) params: JoinRequestDecisionParamsDto,
    @Body(dtoValidationPipe(DecideJoinRequestDto)) body: DecideJoinRequestDto
  ): Promise<DecideJoinRequestResponse> {
    return this.rooms.decideJoinRequest(
      params.slug,
      params.requestId,
      body.participantId,
      body.roomSessionToken,
      params.decision
    );
  }

  @Post(":slug/session/refresh")
  @ApiParam({ name: "slug", example: "x7k2q9" })
  @ApiBody({ schema: roomSessionRefreshRequestOpenApiSchema })
  @ApiCreatedResponse({ schema: roomSessionRefreshResponseOpenApiSchema })
  @ApiBadRequestResponse({ schema: contractErrorOpenApiSchema })
  @ApiNotFoundResponse({ schema: contractErrorOpenApiSchema })
  @ApiGoneResponse({ schema: contractErrorOpenApiSchema })
  @ApiUnauthorizedResponse({ schema: contractErrorOpenApiSchema })
  refreshRoomSession(
    @Param(dtoValidationPipe(RoomParamsDto)) params: RoomParamsDto,
    @Body(dtoValidationPipe(SessionRefreshDto)) body: SessionRefreshDto
  ): Promise<RoomSessionRefreshResponse> {
    return this.rooms.refreshRoomSession(params.slug, body.participantId, body.roomSessionToken);
  }
}
