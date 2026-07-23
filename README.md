# Документация проекта conference-be

Backend API сервиса видеоконференций. Стек: **NestJS 10 + TypeScript + Redis**.
Отвечает за HTTP control plane: комнаты, browser admission flow, room-session/join tokens, app-config и server-to-server интеграции. Room metadata и сессии хранит в Redis.
Не занимается WebRTC/media plane — отдаёт клиенту публичный signaling URL и токены, а media-сервис обрабатывает WebSocket и mediasoup. Канонические HTTP, WebSocket, Redis и lifecycle-контракты находятся в [`../docs/contracts.md`](../docs/contracts.md); Zod-схемы в `src/contracts/` реализуют API-границу.

---

## Порты

| Сервис / процесс | Порт | Где настраивается |
| --- | --- | --- |
| HTTP API (NestJS) | `3000` (внутр.) | `PORT`, `docker-compose.yml` проброс `API_PORT` |
| Redis | `6379` (внешний сервис) | `REDIS_URL` (обычно на media-сервере) |

Edge-маршрутизация: `https://domain/api/v1/` → `api:3000/api/v1/`. Integration API живёт отдельно: `https://domain/api/integrations/v1/` → `api:3000/api/integrations/v1/`.
Operational endpoints: `GET /api/v1/health`, `GET /api/v1/ready`, `GET /api/v1/metrics`.

---

## HTTP API

| Метод | Путь | Назначение |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Liveness-проверка (`{status, service: "api"}`). |
| `GET` | `/api/v1/ready` | Readiness-проверка Redis с bounded timeout (`200`/`503`). |
| `GET` | `/api/v1/metrics` | Prometheus text exposition для operations scraping; не browser product API. |
| `GET` | `/api/v1/app-config` | Публичная read-only конфигурация доступных browser capabilities. |
| `POST` | `/api/v1/rooms` | Создать комнату и pending-сессию создателя. |
| `GET` | `/api/v1/rooms/:slug` | Метаданные комнаты. |
| `POST` | `/api/v1/rooms/:slug/join` | Войти в room session и получить короткоживущий signaling token. |
| `POST` | `/api/v1/rooms/:slug/join-requests` | Создать заявку гостя для комнаты с access policy `approval`. |
| `POST` | `/api/v1/rooms/:slug/join-requests/list` | Получить ожидающие заявки создателю комнаты. |
| `POST` | `/api/v1/rooms/:slug/join-requests/:requestId/status` | Проверить статус заявки гостя. |
| `POST` | `/api/v1/rooms/:slug/join-requests/:requestId/approve` | Одобрить заявку создателю комнаты. |
| `POST` | `/api/v1/rooms/:slug/join-requests/:requestId/deny` | Отклонить заявку создателю комнаты. |
| `POST` | `/api/v1/rooms/:slug/admissions` | Выдать одноразовую ссылку входа создателю приватной комнаты. |
| `POST` | `/api/v1/rooms/:slug/session/refresh` | Обновить signaling token для той же room session. |
| `POST` | `/api/v1/admissions/exchange` | Обменять одноразовый browser admission code на pending room session. |
| `POST` | `/api/integrations/v1/rooms` | Создать или идемпотентно получить integration room по `externalRoomId`. Требуется service JWT. |
| `POST` | `/api/integrations/v1/rooms/:roomId/admissions` | Выдать персональную одноразовую ссылку входа для integration room. Требуется service JWT. |
| `GET` | `/api/integrations/v1/recordings/:recordingId` | Получить owner-scoped статус записи. Для готового MP4 возвращает короткоживущий presigned download URL. |
| `GET` | `/api/integrations/v1/rooms/:roomId/recordings` | Получить записи комнаты только в границах своей integration. |
| `GET` | `/api/integrations/v1/rooms/:roomId/history` | Получить durable историю комнаты: lifecycle, участники, чат и запись. |
| `POST` | `/api/integrations/v1/recordings/:recordingId/callbacks/retry` | Повторно поставить в очередь неуспешный ready callback. |

Создание комнаты и выдача admission **не создают** живого участника — создатель или гость входят только после явного Join. `isCreator` даёт только документированные room-local live controls: закрытие комнаты для всех, управление live-участниками и передачу creator status; durable host roles и глобальная модерация отсутствуют.

Swagger UI доступен по `GET /api/docs`, OpenAPI JSON — по `GET /api/docs-json`. В Swagger есть только placeholder-примеры: service JWT и реальные секреты туда не вставляются.

`/metrics` отдаёт агрегированные API HTTP, room-control, Redis operation и Node.js process метрики. Labels фиксированы и низкокардинальны; room IDs, participant IDs, request IDs, command IDs и токены не используются как labels.

---

## Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `NODE_ENV` | Режим выполнения (`production`). |
| `PORT` | Порт HTTP API (по умолчанию `3000`). |
| `REDIS_URL` | Redis для room metadata и сессий (обычно media-сервер). |
| `WEB_PUBLIC_URL` | Публичный URL фронта (генерация ссылок и CORS origin). |
| `MEDIA_NODE_ID` | Логический id media-ноды, к которой привязываются новые комнаты. |
| `SIGNALING_PUBLIC_URL` | Browser-visible WebSocket URL signaling (`wss://…/ws`). |
| `AUTH_COOKIE_ENABLED` | Enables optional parent-domain trusted cookie identity for browser requests. Defaults to `false`; room creation remains available without it. |
| `AUTH_COOKIE_NAME` | Trusted cookie name, default `conference_identity`. |
| `AUTH_COOKIE_JWT_ISSUER` / `AUTH_COOKIE_JWT_AUDIENCE` / `AUTH_COOKIE_JWT_HS256_SECRET` | Required when `AUTH_COOKIE_ENABLED=true`. |
| `INTEGRATION_API_ENABLED` | Enables service-JWT integration room/admission endpoints. |
| `INTEGRATION_JWT_CREDENTIALS_JSON` | Required when `INTEGRATION_API_ENABLED=true`: JSON registry of independent `{ integrationId, issuer, audience, hs256Secret }` service-JWT credentials. A token identity claim must equal its configured `integrationId`; each signing secret must be unique. |
| `INTEGRATION_JWT_MAX_TTL_SECONDS` | Maximum accepted service-JWT lifetime; defaults to 900 seconds. |
| `INTEGRATION_RATE_LIMIT_WINDOW_SECONDS` / `INTEGRATION_RATE_LIMIT_MAX_REQUESTS` | Integration service rate-limit window and request count. |
| `AUTH_LOGIN_URL` | Optional login URL shown by auth-capable frontend flows. |
| `JOIN_TOKEN_SECRET` | Секрет подписи join-токена. **Должен совпадать** с `media`. |
| `JOIN_TOKEN_TTL_SECONDS` | TTL join-токена (по умолчанию `300`). |
| `ROOM_SESSION_TOKEN_SECRET` | Отдельный секрет для хэша `roomSessionToken` (если не задан — fallback на `JOIN_TOKEN_SECRET`). |
| `DATABASE_URL` | PostgreSQL durable control plane для E12 recording, artifact, composition job и callback delivery. |
| `RECORDING_DELIVERY_ENABLED` | Включает E12 storage/delivery runtime; требует полный набор recording-переменных. |
| `RECORDING_S3_ENDPOINT` / `RECORDING_S3_PUBLIC_ENDPOINT` | Internal и browser-reachable S3 endpoint. Для Yandex: `https://storage.yandexcloud.net`. |
| `RECORDING_S3_REGION` / `RECORDING_S3_BUCKET` | Регион и private bucket. Для Yandex регион — `ru-central1`. |
| `RECORDING_S3_ACCESS_KEY_ID` / `RECORDING_S3_SECRET_ACCESS_KEY` | Статический ключ service account. Эти значения доступны только API. |
| `RECORDING_S3_FORCE_PATH_STYLE` | Для Yandex — `true`. |
| `RECORDING_ARTIFACT_RETENTION_DAYS` | Срок хранения итогового MP4; production значение — `30`. |
| `RECORDING_CAPTURE_SERVICE_SECRET` / `RECORDING_COMPOSITION_SERVICE_SECRET` | Разные secrets внутренних API capture и composition worker. |
| `BE_IMAGE` | Docker-образ для `docker-compose.yml` (подставляется CI). |
| `API_BIND_ADDR` / `API_PORT` | Внешний проброс порта (по умолчанию `127.0.0.1:3000`). |

В `docker-compose.yml` пустые optional JWT-поля не передаются в контейнер. Не задавайте их пустой строкой: либо не задавайте вовсе, либо передавайте полный набор `AUTH_COOKIE_JWT_*`; для интеграции включайте `INTEGRATION_API_ENABLED=true` только вместе с непустым `INTEGRATION_JWT_CREDENTIALS_JSON`.

---

## Структура `src/`

### Корень
| Файл | Что делает |
| --- | --- |
| `main.ts` | Создаёт Nest application и слушает `0.0.0.0:PORT`. |
| `bootstrap.ts` | Глобальный префикс `api/v1` с исключением integration routes, CORS, validation, logging и Swagger. |
| `app.module.ts` | Корневой модуль: `ConfigModule`, `AppConfigModule`, `IntegrationsModule`, `RedisModule`, `HealthModule`, `RoomsModule`. |
| `contracts/index.ts` | Zod-схемы и TypeScript-типы API boundary; канонический межсервисный контракт — `../docs/contracts.md`. |

### `health/` — health-check
| Файл | Что делает |
| --- | --- |
| `health.controller.ts` | `GET /health` → `{status: "ok", service: "api"}`. |
| `ready.controller.ts` | `GET /ready` — Redis readiness (`200` или `503`). |
| `health.module.ts` | Регистрирует health, readiness и metrics controllers. |

### `redis/` — инфраструктура Redis
| Файл | Что делает |
| --- | --- |
| `redis.module.ts` | Создаёт Redis-клиент из `REDIS_URL`, экспортирует как глобальный провайдер `REDIS_CLIENT`. |
| `redis.types.ts` | Интерфейс `RedisClient` (get/set/hSet/hLen/…/eval). |
| `redis.constants.ts` | DI-токен `REDIS_CLIENT`. |

### `rooms/` — основная фича
| Файл | Что делает |
| --- | --- |
| `rooms.controller.ts` | Тонкие REST-эндпоинты (`POST /rooms`, `GET /rooms/:slug`, `POST .../join`, `POST .../session/refresh`) с валидацией DTO. |
| `rooms.service.ts` | Бизнес-логика: создание комнаты (slug, mediaNode, signalingUrl), lookup, join (восстановление сессии по токену, выдача join-токена), refresh сессии. |
| `room.repository.ts` | `RedisRoomRepository` (`abstract RoomRepository`): room metadata, session, admission, approval-request и integration ownership/idempotency state. Хранение только сериализуемых данных. |
| `room-token.service.ts` | Генерация/верификация токенов: join-токен (JWT-подобный, HS256, с TTL) и `roomSessionToken` (HMAC-SHA256 хэш). |
| `room-errors.ts` | HTTP-исключения с кодами: `ROOM_NOT_FOUND`, `ROOM_EXPIRED`, `ROOM_CLOSED`, `INVALID_TOKEN`. |
| `dto/create-room.dto.ts` | Тело запроса создания комнаты. |
| `dto/join-room.dto.ts` | Тело join (`displayName`, `roomSessionToken?`). |
| `dto/room-params.dto.ts` | Валидация `:slug`. |
| `dto/session-refresh.dto.ts` | Тело refresh (`participantId`, `roomSessionToken`). |

### `app-config/`, `auth/`, `integrations/`, `observability/`
| Каталог | Что делает |
| --- | --- |
| `app-config/` | Возвращает browser-safe config и опционально trusted cookie identity. |
| `auth/` | Валидирует optional trusted parent-domain cookie JWT. |
| `integrations/` | Проверяет service JWT registry, rate-limit и создаёт integration rooms/admissions. |
| `observability/` | API logging interceptor и Prometheus metrics. |

---

## Redis

API хранит только сериализуемые metadata, room sessions, session-token indexes, approval requests, one-time admission state и integration ownership/idempotency mappings. Signaling/media отдельно хранит live participants, media lease и chat history; mediasoup runtime objects не попадают в Redis.

Полный перечень ключей, их формат и TTL — в [`../docs/contracts.md`](../docs/contracts.md#redis-keys). В частности, integration room использует `integration_room:{integrationId}:{externalRoomHash}` и `integration_room_owner:{roomId}`; эти mappings живут без TTL, пока в комнате есть live-участники, и получают общий 15-минутный TTL для новой пустой комнаты, после выхода последнего участника или после закрытия комнаты.

---

## CI/CD

`.gitlab-ci.yml` запускает:
1. **validate** — lint, typecheck, test, build для `main` и merge requests;
2. **build** — на `main` собирает production image с тегами `<sha>` и `latest`;
3. **deploy** — на `main` получает production `.env` из GitLab variable `DEPLOY_ENV_PROD` (либо использует `.env.example`) и запускает `docker compose up -d` в сети `conference-net`;
4. **cleanup** — на `main` очищает старые контейнеры и образы.

GitLab secrets должны содержать значения для включённых optional возможностей; README и `.env.example` не содержат production credential values.
