import type { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import type { OpenAPIObject } from "@nestjs/swagger/dist/interfaces/open-api-spec.interface.js";
import {
  createIntegrationAdmissionRequestOpenApiSchema,
  createIntegrationAdmissionResponseOpenApiSchema,
  createIntegrationAdmissionOpenApiDescription,
  createIntegrationRoomOpenApiDescription,
  createIntegrationRoomResponseOpenApiSchema,
  createIntegrationRoomRequestOpenApiSchema,
  exchangeAdmissionOpenApiDescription,
  exchangeAdmissionRequestOpenApiSchema,
  exchangeAdmissionResponseOpenApiSchema,
  integrationAdmissionErrorResponsesOpenApi,
  integrationErrorResponsesOpenApi,
  integrationServiceJwtOpenApiDescription,
  integrationTagDescription,
} from "./integrations/integrations.openapi.js";
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
} from "./rooms/rooms.openapi.js";

const appConfigResponseOpenApiSchema = {
  type: "object",
  required: [
    "authCookieEnabled",
    "integrationApiEnabled",
    "loginUrl",
    "identity",
  ],
  properties: {
    authCookieEnabled: { type: "boolean", example: false },
    integrationApiEnabled: { type: "boolean", example: false },
    loginUrl: {
      type: "string",
      format: "uri",
      nullable: true,
      example: "https://users.example.com/login",
    },
    identity: {
      type: "object",
      nullable: true,
      required: ["displayName"],
      properties: {
        displayName: { type: "string", minLength: 1, maxLength: 80, example: "Anna Ivanova" },
        avatarUrl: { type: "string", format: "uri", maxLength: 512 },
      },
    },
  },
};

function createOpenApiDocument(): OpenAPIObject {
  return {
    openapi: "3.0.0",
    info: {
      title: "API конференций",
      description:
        "HTTP API управляющего контура конференций. Контракты WebSocket и медиасреды документированы отдельно. Раздел интеграций предназначен для обмена между серверами; браузерные приложения должны использовать обычные сценарии комнаты и входа по ссылке допуска.",
      version: "1.0",
    },
    paths: {
      "/api/v1/app-config": {
        get: {
          operationId: "AppConfigController_getAppConfig",
          tags: ["app-config"],
          responses: {
            "200": {
              description: "Конфигурация фронтенд-приложения только для чтения.",
              content: {
                "application/json": {
                  schema: appConfigResponseOpenApiSchema,
                },
              },
            },
          },
        },
      },
      "/api/v1/rooms": {
        post: {
          operationId: "RoomsController_createRoom",
          tags: ["rooms"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: createRoomRequestOpenApiSchema,
              },
            },
          },
          responses: {
            "201": {
              description: "Комната создана с ожидающей сессией создателя.",
              content: {
                "application/json": {
                  schema: createRoomResponseOpenApiSchema,
                },
              },
            },
            "400": { description: "Некорректное тело запроса.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
          },
        },
      },
      "/api/v1/rooms/{slug}": {
        get: {
          operationId: "RoomsController_getRoom",
          tags: ["rooms"],
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" }, example: "x7k2q9" }],
          responses: {
            "200": {
              description: "Метаданные комнаты.",
              content: {
                "application/json": {
                  schema: getRoomResponseOpenApiSchema,
                },
              },
            },
            "404": { description: "Комната не найдена.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "410": { description: "Срок действия комнаты истёк либо она закрыта.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
          },
        },
      },
      "/api/v1/rooms/{slug}/join": {
        post: {
          operationId: "RoomsController_joinRoom",
          tags: ["rooms"],
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" }, example: "x7k2q9" }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: joinRoomRequestOpenApiSchema,
              },
            },
          },
          responses: {
            "201": {
              description: "Выполнен вход в сессию комнаты и выдан короткоживущий токен сигналинга.",
              content: {
                "application/json": {
                  schema: joinRoomResponseOpenApiSchema,
                },
              },
            },
            "400": { description: "Некорректное тело запроса.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "401": { description: "Некорректный токен сессии комнаты.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "403": { description: "Требуется одобрение создателя комнаты.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "404": { description: "Комната не найдена.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "410": { description: "Срок действия комнаты истёк либо она закрыта.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
          },
        },
      },
      "/api/v1/rooms/{slug}/join-requests": {
        post: {
          operationId: "RoomsController_createJoinRequest",
          tags: ["rooms"],
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" }, example: "x7k2q9" }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: createJoinRequestRequestOpenApiSchema } },
          },
          responses: {
            "201": {
              description: "Для приватной комнаты с доступом по одобрению создана заявка на вход.",
              content: { "application/json": { schema: createJoinRequestResponseOpenApiSchema } },
            },
            "400": { description: "Некорректное тело запроса.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "403": { description: "В комнате не используется доступ по одобрению.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "404": { description: "Комната не найдена.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "410": { description: "Срок действия комнаты истёк либо она закрыта.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
          },
        },
      },
      "/api/v1/rooms/{slug}/join-requests/list": {
        post: {
          operationId: "RoomsController_listJoinRequests",
          tags: ["rooms"],
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" }, example: "x7k2q9" }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: listJoinRequestsRequestOpenApiSchema } },
          },
          responses: {
            "200": {
              description: "Ожидающие заявки на вход, доступные создателю комнаты.",
              content: { "application/json": { schema: listJoinRequestsResponseOpenApiSchema } },
            },
            "401": { description: "Некорректный токен сессии создателя комнаты.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "404": { description: "Комната не найдена.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
          },
        },
      },
      "/api/v1/rooms/{slug}/admissions": {
        post: {
          operationId: "RoomsController_createRoomAdmission",
          tags: ["rooms"],
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" }, example: "x7k2q9" }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: createRoomAdmissionRequestOpenApiSchema } },
          },
          responses: {
            "201": {
              description: "Одноразовая ссылка входа для приватной комнаты, выданная её локальным создателем.",
              content: { "application/json": { schema: createRoomAdmissionResponseOpenApiSchema } },
            },
            "401": { description: "Некорректный токен сессии создателя комнаты.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "403": { description: "В комнате не используется доступ по одобрению.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "404": { description: "Комната не найдена.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "410": { description: "Срок действия комнаты истёк либо она закрыта.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
          },
        },
      },
      "/api/v1/rooms/{slug}/join-requests/{requestId}/status": {
        post: {
          operationId: "RoomsController_getJoinRequestStatus",
          tags: ["rooms"],
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string" }, example: "x7k2q9" },
            { name: "requestId", in: "path", required: true, schema: { type: "string" }, example: "join_01H..." },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: joinRequestStatusRequestOpenApiSchema } },
          },
          responses: {
            "200": {
              description: "Статус заявки для периодической проверки. Первый статус approved содержит приватные для браузера данные сессии комнаты.",
              content: { "application/json": { schema: joinRequestStatusResponseOpenApiSchema } },
            },
            "401": { description: "Некорректный токен заявки на вход.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "404": { description: "Комната не найдена.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
          },
        },
      },
      "/api/v1/rooms/{slug}/join-requests/{requestId}/{decision}": {
        post: {
          operationId: "RoomsController_decideJoinRequest",
          tags: ["rooms"],
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string" }, example: "x7k2q9" },
            { name: "requestId", in: "path", required: true, schema: { type: "string" }, example: "join_01H..." },
            { name: "decision", in: "path", required: true, schema: { type: "string", enum: ["approve", "deny"] } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: decideJoinRequestRequestOpenApiSchema } },
          },
          responses: {
            "200": {
              description: "Заявка на вход одобрена или отклонена создателем комнаты.",
              content: { "application/json": { schema: decideJoinRequestResponseOpenApiSchema } },
            },
            "401": { description: "Некорректный токен сессии создателя комнаты.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "404": { description: "Комната не найдена.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
          },
        },
      },
      "/api/v1/rooms/{slug}/session/refresh": {
        post: {
          operationId: "RoomsController_refreshRoomSession",
          tags: ["rooms"],
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" }, example: "x7k2q9" }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: roomSessionRefreshRequestOpenApiSchema,
              },
            },
          },
          responses: {
            "201": {
              description: "Новый короткоживущий токен сигналинга для той же сессии комнаты.",
              content: {
                "application/json": {
                  schema: roomSessionRefreshResponseOpenApiSchema,
                },
              },
            },
            "400": { description: "Некорректное тело запроса.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "401": { description: "Некорректный токен сессии комнаты.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "404": { description: "Комната не найдена.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "410": { description: "Срок действия комнаты истёк либо она закрыта.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
          },
        },
      },
      "/api/integrations/v1/rooms": {
        post: {
          operationId: "IntegrationsController_createIntegrationRoom",
          tags: ["integrations"],
          summary: "Создать комнату интеграции с доступом по одобрению",
          description: createIntegrationRoomOpenApiDescription,
          security: [{ "integration-service-jwt": [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: createIntegrationRoomRequestOpenApiSchema,
                examples: {
                  managerInOneCall: {
                    summary: "Создать комнату и ссылку входа первого менеджера (accessPolicy по умолчанию)",
                    value: {
                      externalRoomId: "crm-call-123",
                      title: "Консультация клиента",
                      recordingRequested: true,
                      initialUser: { id: "manager-42", name: "Анна Иванова" },
                    },
                  },
                  roomOnly: {
                    summary: "Создать комнату без ссылки входа (минимальный запрос)",
                    value: { externalRoomId: "crm-call-124" },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description:
                "Комната интеграции создана либо возвращена для совпадающего идемпотентного запроса. entryUrl и entryExpiresAt присутствуют только при передаче initialUser.",
              content: {
                "application/json": {
                  schema: createIntegrationRoomResponseOpenApiSchema,
                  examples: {
                    managerInOneCall: {
                      summary: "Комната и одноразовая ссылка входа менеджера",
                      value: {
                        roomId: "room_01H...",
                        slug: "x7k2q9",
                        mediaNodeId: "local",
                        signalingUrl: "ws://localhost:4000/ws",
                        expiresAt: "2026-07-13T12:35:00.000Z",
                        status: "active",
                        accessPolicy: "approval",
                        recordingId: "rec_01H...",
                        entryUrl: "http://localhost:5173/r/x7k2q9#code=opaque-admission-code",
                        entryExpiresAt: "2026-07-13T12:30:00.000Z",
                      },
                    },
                  },
                },
              },
            },
            ...integrationErrorResponsesOpenApi,
          },
        },
      },
      "/api/integrations/v1/rooms/{roomId}/admissions": {
        post: {
          operationId: "IntegrationsController_createAdmission",
          tags: ["integrations"],
          summary: "Выдать персональную ссылку входа",
          description: createIntegrationAdmissionOpenApiDescription,
          security: [{ "integration-service-jwt": [] }],
          parameters: [
            {
              name: "roomId",
              in: "path",
              required: true,
              schema: { type: "string" },
              example: "room_01H...",
              description: "Обязательный параметр. Комната создана с использованием учётных данных той же интеграции.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: createIntegrationAdmissionRequestOpenApiSchema,
                example: {
                  identity: {
                    kind: "authenticated",
                    externalSubject: "client-81",
                    displayName: "Имя клиента",
                  },
                  roomControls: "none",
                  expiresAt: "2026-07-13T12:30:00.000Z",
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Для указанного браузерного участника выдана персональная одноразовая ссылка входа.",
              content: {
                "application/json": {
                  schema: createIntegrationAdmissionResponseOpenApiSchema,
                },
              },
            },
            ...integrationAdmissionErrorResponsesOpenApi,
          },
        },
      },
      "/api/v1/admissions/exchange": {
        post: {
          operationId: "AdmissionsController_exchange",
          tags: ["admissions"],
          summary: "Обменять одноразовый браузерный код входа",
          description: exchangeAdmissionOpenApiDescription,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: exchangeAdmissionRequestOpenApiSchema,
              },
            },
          },
          responses: {
            "200": {
              description: "Ссылка входа использована, возвращены ожидающие данные сессии комнаты.",
              content: {
                "application/json": {
                  schema: exchangeAdmissionResponseOpenApiSchema,
                },
              },
            },
            "400": { description: "Некорректное тело запроса.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "401": { description: "Код входа некорректен, уже использован, истёк или относится к другой комнате.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
            "410": { description: "Комната закрыта.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
          },
        },
      },
    },
    components: {
      schemas: {
        AppConfigResponseDto: appConfigResponseOpenApiSchema,
        ContractError: contractErrorOpenApiSchema,
      },
      securitySchemes: {
        "integration-service-jwt": {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: integrationServiceJwtOpenApiDescription,
        },
      },
    },
    tags: [
      { name: "admissions", description: "Браузерный обмен одноразового кода входа." },
      { name: "app-config", description: "Конфигурация возможностей браузера только для чтения." },
      { name: "integrations", description: integrationTagDescription },
      { name: "rooms", description: "Жизненный цикл комнат в браузере и операции приватного доступа по одобрению." },
    ],
  };
}

export function configureSwaggerDocumentation(app: INestApplication): void {
  const document = createOpenApiDocument();
  SwaggerModule.setup("api/docs", app, document, {
    jsonDocumentUrl: "api/docs-json",
    swaggerOptions: {
      persistAuthorization: false,
    },
  });
}
