import type { SchemaObject } from "@nestjs/swagger/dist/interfaces/open-api-spec.interface.js";

const stringSchema = { type: "string", minLength: 1 } satisfies SchemaObject;
const dateTimeSchema = { type: "string", format: "date-time" } satisfies SchemaObject;

export const contractErrorOpenApiSchema = {
  type: "object",
  required: ["code", "message"],
  properties: {
    code: {
      type: "string",
      enum: [
        "ROOM_NOT_FOUND",
        "ROOM_EXPIRED",
        "ROOM_CLOSED",
        "INVALID_TOKEN",
        "INVALID_PAYLOAD",
        "APPROVAL_REQUIRED",
        "AUTH_NOT_CONFIGURED",
        "INTEGRATION_AUTH_NOT_CONFIGURED",
        "INTEGRATION_CONFLICT",
        "INTEGRATION_FORBIDDEN",
        "INTEGRATION_NOT_IMPLEMENTED",
        "RATE_LIMITED",
      ],
      example: "ROOM_NOT_FOUND",
    },
    message: { type: "string", example: "Room not found" },
  },
} satisfies SchemaObject;

export const createRoomRequestOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    accessPolicy: { type: "string", enum: ["link", "approval"], default: "link", example: "approval" },
  },
} satisfies SchemaObject;

export const createRoomResponseOpenApiSchema = {
  type: "object",
  required: [
    "roomId",
    "slug",
    "joinUrl",
    "accessPolicy",
    "participantId",
    "roomSessionToken",
    "displayName",
    "mediaNodeId",
    "signalingUrl",
    "expiresAt",
  ],
  properties: {
    roomId: { ...stringSchema, example: "room_01H..." },
    slug: { ...stringSchema, example: "x7k2q9" },
    joinUrl: { type: "string", format: "uri", example: "http://localhost:5173/r/x7k2q9" },
    accessPolicy: { type: "string", enum: ["link", "approval", "admission"], example: "approval" },
    participantId: { ...stringSchema, example: "peer_01H..." },
    roomSessionToken: { ...stringSchema, example: "browser-private-session-value" },
    displayName: { type: "string", minLength: 1, nullable: true, example: "Anna Ivanova" },
    mediaNodeId: { ...stringSchema, example: "local" },
    signalingUrl: { type: "string", format: "uri", example: "ws://localhost:4000/ws" },
    expiresAt: { ...dateTimeSchema, nullable: true, example: "2026-06-02T12:15:00.000Z" },
  },
} satisfies SchemaObject;

export const getRoomResponseOpenApiSchema = {
  type: "object",
  required: [
    "roomId",
    "slug",
    "expiresAt",
    "status",
    "closedReason",
    "accessPolicy",
    "mediaNodeId",
    "signalingUrl",
    "participantCount",
  ],
  properties: {
    roomId: { ...stringSchema, example: "room_01H..." },
    slug: { ...stringSchema, example: "x7k2q9" },
    expiresAt: { ...dateTimeSchema, nullable: true, example: null },
    status: { type: "string", enum: ["active", "closed"], example: "active" },
    closedReason: {
      type: "string",
      enum: ["closed_by_creator", "empty_timeout", "server_shutdown", "media_server_error"],
      nullable: true,
      example: null,
    },
    accessPolicy: { type: "string", enum: ["link", "approval", "admission"], example: "approval" },
    mediaNodeId: { ...stringSchema, example: "local" },
    signalingUrl: { type: "string", format: "uri", example: "ws://localhost:4000/ws" },
    participantCount: { type: "integer", minimum: 0, example: 2 },
  },
} satisfies SchemaObject;

export const joinRoomRequestOpenApiSchema = {
  type: "object",
  required: ["displayName"],
  properties: {
    displayName: { type: "string", minLength: 1, maxLength: 80, example: "Alex" },
    roomSessionToken: { ...stringSchema, example: "browser-private-session-value" },
  },
  additionalProperties: false,
} satisfies SchemaObject;

export const joinRoomResponseOpenApiSchema = {
  type: "object",
  required: ["participantId", "isCreator", "token", "roomSessionToken", "signalingUrl"],
  properties: {
    participantId: { ...stringSchema, example: "peer_01H..." },
    isCreator: { type: "boolean", example: true },
    token: { ...stringSchema, example: "short-lived-signaling-token" },
    roomSessionToken: { ...stringSchema, example: "browser-private-session-value" },
    signalingUrl: { type: "string", format: "uri", example: "ws://localhost:4000/ws" },
  },
} satisfies SchemaObject;

export const roomSessionRefreshRequestOpenApiSchema = {
  type: "object",
  required: ["participantId", "roomSessionToken"],
  properties: {
    participantId: { ...stringSchema, example: "peer_01H..." },
    roomSessionToken: { ...stringSchema, example: "browser-private-session-value" },
  },
  additionalProperties: false,
} satisfies SchemaObject;

export const roomSessionRefreshResponseOpenApiSchema = {
  type: "object",
  required: ["token", "signalingUrl"],
  properties: {
    token: { ...stringSchema, example: "short-lived-signaling-token" },
    signalingUrl: { type: "string", format: "uri", example: "ws://localhost:4000/ws" },
  },
} satisfies SchemaObject;

export const createJoinRequestRequestOpenApiSchema = {
  type: "object",
  required: ["displayName"],
  additionalProperties: false,
  properties: {
    displayName: { type: "string", minLength: 1, maxLength: 80, example: "Sam" },
  },
} satisfies SchemaObject;

export const createJoinRequestResponseOpenApiSchema = {
  type: "object",
  required: ["requestId", "requestToken", "status", "displayName", "expiresAt"],
  additionalProperties: false,
  properties: {
    requestId: { ...stringSchema, example: "join_01H..." },
    requestToken: { ...stringSchema, example: "browser-private-request-token" },
    status: { type: "string", enum: ["pending"], example: "pending" },
    displayName: { type: "string", minLength: 1, maxLength: 80, example: "Sam" },
    expiresAt: { ...dateTimeSchema, example: "2026-06-02T12:15:00.000Z" },
  },
} satisfies SchemaObject;

export const joinRequestStatusRequestOpenApiSchema = {
  type: "object",
  required: ["requestToken"],
  additionalProperties: false,
  properties: {
    requestToken: { ...stringSchema, example: "browser-private-request-token" },
  },
} satisfies SchemaObject;

export const joinRequestStatusResponseOpenApiSchema = {
  type: "object",
  required: ["requestId", "status", "displayName", "expiresAt"],
  additionalProperties: false,
  properties: {
    requestId: { ...stringSchema, example: "join_01H..." },
    status: { type: "string", enum: ["pending", "approved", "denied", "expired"], example: "approved" },
    displayName: { type: "string", minLength: 1, maxLength: 80, example: "Sam" },
    participantId: { ...stringSchema, example: "peer_01H..." },
    roomSessionToken: { ...stringSchema, example: "browser-private-session-value" },
    isCreator: { type: "boolean", enum: [false], example: false },
    expiresAt: { ...dateTimeSchema, example: "2026-06-02T12:15:00.000Z" },
  },
} satisfies SchemaObject;

export const listJoinRequestsRequestOpenApiSchema = {
  type: "object",
  required: ["participantId", "roomSessionToken"],
  additionalProperties: false,
  properties: {
    participantId: { ...stringSchema, example: "peer_01H..." },
    roomSessionToken: { ...stringSchema, example: "browser-private-session-value" },
  },
} satisfies SchemaObject;

export const listJoinRequestsResponseOpenApiSchema = {
  type: "object",
  required: ["requests"],
  additionalProperties: false,
  properties: {
    requests: {
      type: "array",
      items: {
        type: "object",
        required: ["requestId", "displayName", "createdAt", "expiresAt"],
        additionalProperties: false,
        properties: {
          requestId: { ...stringSchema, example: "join_01H..." },
          displayName: { type: "string", minLength: 1, maxLength: 80, example: "Sam" },
          createdAt: { ...dateTimeSchema, example: "2026-06-02T12:00:00.000Z" },
          expiresAt: { ...dateTimeSchema, example: "2026-06-02T12:15:00.000Z" },
        },
      },
    },
  },
} satisfies SchemaObject;

export const createRoomAdmissionRequestOpenApiSchema = listJoinRequestsRequestOpenApiSchema;

export const createRoomAdmissionResponseOpenApiSchema = {
  type: "object",
  required: ["entryUrl", "expiresAt"],
  additionalProperties: false,
  properties: {
    entryUrl: {
      type: "string",
      format: "uri",
      example: "http://localhost:5173/r/x7k2q9#code=opaque-admission-code",
    },
    expiresAt: { ...dateTimeSchema, example: "2026-06-02T12:15:00.000Z" },
  },
} satisfies SchemaObject;

export const decideJoinRequestRequestOpenApiSchema = listJoinRequestsRequestOpenApiSchema;

export const decideJoinRequestResponseOpenApiSchema = {
  type: "object",
  required: ["requestId", "status"],
  additionalProperties: false,
  properties: {
    requestId: { ...stringSchema, example: "join_01H..." },
    status: { type: "string", enum: ["approved", "denied"], example: "approved" },
  },
} satisfies SchemaObject;
