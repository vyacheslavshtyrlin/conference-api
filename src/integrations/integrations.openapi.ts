import type { SchemaObject } from "@nestjs/swagger/dist/interfaces/open-api-spec.interface.js";
import { contractErrorOpenApiSchema } from "../rooms/rooms.openapi.js";

export const integrationTagDescription = `
Сервер-серверный API для доверенных внешних бэкендов, например CRM. Это не браузерный API: никогда не передавайте bearer-учётные данные, секрет подписи или исходный JWT во фронтенд-код.

Настройте в Conference API независимую запись реестра для каждой интеграции. Сервисный токен использует **HS256** и обязан содержать \`iss\`, \`aud\`, \`iat\`, \`exp\` и \`sub\`. Значение \`sub\` должно совпадать с настроенным ID интеграции. Максимальное значение \`exp - iat\` задаётся конфигурацией API.

Обычный сценарий менеджера: вызовите **Создать комнату интеграции** с \`initialUser\`; ответ будет содержать одноразовый \`entryUrl\` этого менеджера. **Создать персональную ссылку входа** используйте только для последующих участников.\n`;

export const integrationServiceJwtOpenApiDescription = `
Сервисный JWT HS256 для одной настроенной интеграции. API находит запись реестра по обязательному \`sub\`, затем проверяет подпись, issuer, audience, время выпуска и срок действия.

Обязательные claims:

- \`iss\`: issuer из реестра;
- \`aud\`: audience из реестра;
- \`sub\`: ID интеграции из реестра;
- \`iat\` и неистёкший \`exp\`.

Не вставляйте production-учётные данные в Swagger UI и не отправляйте их из браузера.\n`;

export const createIntegrationRoomOpenApiDescription = `
Создаёт приватную комнату \`approval\` для этой интеграции.

Передайте \`initialUser\`, чтобы получить в том же ответе одноразовую ссылку для первого менеджера. API сопоставляет \`initialUser.id\` с приватной внешней идентичностью, а \`initialUser.name\` — с доверенным отображаемым именем менеджера. Выдаются только существующие локальные права создателя комнаты; живой участник при этом не создаётся.

Передавайте стабильный \`externalRoomId\` из внешней системы. Эквивалентный повторный запрос вернёт ту же комнату. При наличии \`initialUser\` каждый эквивалентный повтор выдаёт новую одноразовую ссылку менеджера, поскольку исходные коды входа не хранятся. Повторное использование \`externalRoomId\` с другим запросом вернёт \`409 INTEGRATION_CONFLICT\`.\n`;

export const createIntegrationAdmissionOpenApiDescription = `
Выдаёт человеку одноразовую браузерную ссылку входа после создания комнаты. Комната должна принадлежать вызывающей интеграции.

Ссылка конфиденциальна: передавайте её только назначенному получателю. Код одноразовый, истекает в указанное время или при истечении комнаты — смотря что наступит раньше — и находится во фрагменте URL, поэтому не уходит в первом HTTP-запросе браузера.\n`;

export const exchangeAdmissionOpenApiDescription = `
Браузерный этап входа по ссылке допуска. Этот endpoint **не** использует сервисный JWT интеграции. Браузер читает непрозрачный код из фрагмента URL и обменивает его один раз. Ответ содержит приватные для браузера данные сессии комнаты; внешний бэкенд не должен вызывать этот endpoint или сохранять эти значения.\n`;

export const createIntegrationRoomRequestOpenApiSchema = {
  type: "object",
  required: ["externalRoomId"],
  additionalProperties: false,
  properties: {
    externalRoomId: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[a-zA-Z0-9._:-]+$",
      example: "crm-call-123",
      description: "Обязательное поле. Стабильный ID комнаты во внешней системе; уникален в пределах этой интеграции.",
    },
    title: { type: "string", maxLength: 160, example: "Консультация клиента", description: "Необязательное поле. Название комнаты." },
    accessPolicy: {
      type: "string",
      enum: ["approval"],
      default: "approval",
      example: "approval",
      description: "Необязательное поле. Можно передать только approval; если поле отсутствует, используется approval.",
    },
    recordingRequested: {
      type: "boolean",
      default: false,
      description: "Необязательное поле. Доступно только сервисной интеграции; при true API создаёт opaque recordingId без browser recording controls.",
    },
    initialUser: {
      type: "object",
      required: ["id", "name"],
      additionalProperties: false,
      description: "Необязательное поле. Первый менеджер; при передаче обязательны id и name.",
      properties: {
        id: {
          type: "string",
          minLength: 1,
          maxLength: 160,
          example: "manager-42",
          description: "Обязательное поле initialUser. Приватный стабильный внешний идентификатор; не возвращается браузерным клиентам.",
        },
        name: { type: "string", minLength: 1, maxLength: 80, example: "Анна Иванова", description: "Обязательное поле initialUser. Доверенное отображаемое имя." },
      },
    },
  },
} satisfies SchemaObject;

export const createIntegrationRoomResponseOpenApiSchema = {
  type: "object",
  required: ["roomId", "slug", "mediaNodeId", "signalingUrl", "expiresAt", "status", "accessPolicy", "recordingId"],
  additionalProperties: false,
  properties: {
    roomId: { type: "string", minLength: 1, example: "room_01H..." },
    slug: { type: "string", minLength: 1, example: "x7k2q9" },
    mediaNodeId: { type: "string", minLength: 1, example: "local" },
    signalingUrl: { type: "string", format: "uri", example: "ws://localhost:4000/ws" },
    expiresAt: { type: "string", format: "date-time", nullable: true, example: "2026-06-02T12:15:00.000Z" },
    status: { type: "string", enum: ["active", "closed"], example: "active" },
    accessPolicy: { type: "string", enum: ["approval"], example: "approval" },
    recordingId: {
      type: "string",
      nullable: true,
      example: "rec_01H...",
      description: "Opaque recording identifier for an integration-requested recording; null otherwise.",
    },
    entryUrl: {
      type: "string",
      format: "uri",
      example: "http://localhost:5173/r/x7k2q9#code=opaque-admission-code",
      description: "Одноразовая ссылка входа первого менеджера. Присутствует только при передаче initialUser.",
    },
    entryExpiresAt: {
      type: "string",
      format: "date-time",
      example: "2026-07-13T12:30:00.000Z",
      description: "Время истечения entryUrl; не позже срока действия комнаты.",
    },
  },
} satisfies SchemaObject;

export const createIntegrationAdmissionRequestOpenApiSchema = {
  type: "object",
  required: ["identity", "roomControls", "expiresAt"],
  additionalProperties: false,
  properties: {
    identity: {
      type: "object",
      required: ["kind", "externalSubject", "displayName"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["guest", "authenticated"], example: "authenticated", description: "Обязательное поле. guest — гость, authenticated — доверенная внешняя идентичность." },
        externalSubject: { type: "string", minLength: 1, maxLength: 160, description: "Обязательное поле. Приватный ID человека во внешней системе." },
        displayName: { type: "string", minLength: 1, maxLength: 80, example: "Доверенный участник", description: "Обязательное поле. Отображаемое имя участника." },
        avatarUrl: { type: "string", format: "uri", maxLength: 512, description: "Необязательное поле. URL аватара." },
      },
    },
    roomControls: { type: "string", enum: ["creator", "none"], example: "none", description: "Обязательное поле. creator — локальные права создателя комнаты; none — обычный участник." },
    expiresAt: { type: "string", format: "date-time", example: "2026-07-13T12:30:00.000Z", description: "Обязательное поле. Время истечения ссылки в ISO 8601; не позже срока действия комнаты." },
  },
} satisfies SchemaObject;

export const createIntegrationAdmissionResponseOpenApiSchema = {
  type: "object",
  required: ["entryUrl", "expiresAt"],
  additionalProperties: false,
  properties: {
    entryUrl: {
      type: "string",
      format: "uri",
      example: "http://localhost:5173/r/x7k2q9#code=opaque-admission-code",
    },
    expiresAt: { type: "string", format: "date-time", example: "2026-07-13T12:30:00.000Z" },
  },
} satisfies SchemaObject;

export const exchangeAdmissionRequestOpenApiSchema = {
  type: "object",
  required: ["code"],
  additionalProperties: false,
  properties: {
    code: { type: "string", minLength: 1, maxLength: 256, example: "opaque-admission-code", description: "Обязательное поле. Одноразовый код из фрагмента ссылки входа." },
    roomId: { type: "string", minLength: 1, example: "room_01H...", description: "Необязательное поле. Если передано, код дополнительно привязывается к этой комнате." },
  },
} satisfies SchemaObject;

export const exchangeAdmissionResponseOpenApiSchema = {
  type: "object",
  required: [
    "roomId",
    "slug",
    "participantId",
    "roomSessionToken",
    "displayName",
    "isCreator",
    "mediaNodeId",
    "signalingUrl",
    "expiresAt",
  ],
  additionalProperties: false,
  properties: {
    roomId: { type: "string", minLength: 1, example: "room_01H..." },
    slug: { type: "string", minLength: 1, example: "x7k2q9" },
    participantId: { type: "string", minLength: 1, example: "peer_01H..." },
    roomSessionToken: { type: "string", minLength: 1, example: "browser-private-session-value" },
    displayName: { type: "string", minLength: 1, nullable: true, example: "Доверенный участник" },
    isCreator: { type: "boolean", example: false },
    mediaNodeId: { type: "string", minLength: 1, example: "local" },
    signalingUrl: { type: "string", format: "uri", example: "ws://localhost:4000/ws" },
    expiresAt: { type: "string", format: "date-time", nullable: true, example: "2026-06-02T12:15:00.000Z" },
  },
} satisfies SchemaObject;

export const integrationErrorResponsesOpenApi = {
  "400": { description: "Некорректное тело запроса.", content: { "application/json": { schema: contractErrorOpenApiSchema } } },
  "401": {
    description: "Сервисные учётные данные интеграции отсутствуют, истекли или некорректны.",
    content: { "application/json": { schema: contractErrorOpenApiSchema } },
  },
  "403": {
    description:
      "Integration API отключён либо комната не принадлежит этой интеграции.",
    content: { "application/json": { schema: contractErrorOpenApiSchema } },
  },
  "409": {
    description: "Ключ идемпотентности или внешнее сопоставление комнаты конфликтует с другим запросом.",
    content: { "application/json": { schema: contractErrorOpenApiSchema } },
  },
  "429": {
    description: "Превышен лимит запросов интеграции.",
    content: { "application/json": { schema: contractErrorOpenApiSchema } },
  },
} as const;

export const integrationAdmissionErrorResponsesOpenApi = {
  "400": integrationErrorResponsesOpenApi["400"],
  "401": integrationErrorResponsesOpenApi["401"],
  "403": integrationErrorResponsesOpenApi["403"],
  "404": {
    description: "Комната не найдена или больше недоступна (ROOM_NOT_FOUND).",
    content: { "application/json": { schema: contractErrorOpenApiSchema } },
  },
  "410": {
    description: "Срок действия комнаты истёк либо она закрыта (ROOM_EXPIRED или ROOM_CLOSED).",
    content: { "application/json": { schema: contractErrorOpenApiSchema } },
  },
  "429": integrationErrorResponsesOpenApi["429"],
} as const;
