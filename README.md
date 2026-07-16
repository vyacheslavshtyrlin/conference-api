# Документация проекта conference-be

Backend API сервиса видеоконференций. Стек: **NestJS 10 + TypeScript + Redis**.
Отвечает за создание комнат, lookup, join flow и выдачу join-токенов. Room metadata и сессии хранит в Redis.
Не занимается WebRTC/media plane — отдаёт клиенту публичный signaling URL и токены, а media-сервис обрабатывает WebSocket и mediasoup. Контракты API описаны **Zod** в `src/contracts/` и едины для всех сервисов.

---

## Порты

| Сервис / процесс | Порт | Где настраивается |
| --- | --- | --- |
| HTTP API (NestJS) | `3000` (внутр.) | `PORT`, `docker-compose.yml` проброс `API_PORT` |
| Redis | `6379` (внешний сервис) | `REDIS_URL` (обычно на media-сервере) |

Edge-маршрутизация: `https://domain/api/v1/` → `api:3000/api/v1/`. Operational endpoints:
`GET /api/v1/health`, `GET /api/v1/ready`, `GET /api/v1/metrics`.

---

## REST API (префикс `/api/v1`)

| Метод | Путь | Назначение |
| --- | --- | --- |
| `GET` | `/health` | Health-проверка (`{status, service: "api"}`). |
| `GET` | `/ready` | Readiness-проверка Redis с bounded timeout (`200`/`503`). |
| `GET` | `/metrics` | Prometheus text exposition для operations scraping; не browser product API. |
| `POST` | `/rooms` | Создать комнату → возвращает `slug`, `roomId`, `participantId`, `roomSessionToken`, `signalingUrl`, `mediaNodeId`. |
| `GET` | `/rooms/:slug` | Метаданные комнаты: `status`, `expiresAt`, `closedReason`, `participantCount`, `signalingUrl`. |
| `POST` | `/rooms/:slug/join` | Присоединиться: выдаёт `participantId`, `isCreator`, `token` (join), `roomSessionToken`, `signalingUrl`. |
| `POST` | `/rooms/:slug/session/refresh` | Обновить join-токен по `participantId` + `roomSessionToken`. |

Создание комнаты **не создаёт** живого участника — создатель заходит только после явного Join. `isCreator` — метаданные, а не права хоста.

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
| `JOIN_TOKEN_SECRET` | Секрет подписи join-токена. **Должен совпадать** с `media`. |
| `JOIN_TOKEN_TTL_SECONDS` | TTL join-токена (по умолчанию `300`). |
| `ROOM_SESSION_TOKEN_SECRET` | Отдельный секрет для хэша `roomSessionToken` (если не задан — fallback на `JOIN_TOKEN_SECRET`). |
| `API_IMAGE` | Docker-образ для `docker-compose.yml` (подставляется CI). |
| `API_BIND_ADDR` / `API_PORT` | Внешний проброс порта (по умолчанию `127.0.0.1:3000`). |

---

## Структура `src/`

### Корень
| Файл | Что делает |
| --- | --- |
| `main.ts` | Bootstrap NestJS: глобальный префикс `api/v1`, CORS (origin = `WEB_PUBLIC_URL`), `ValidationPipe` (whitelist + transform), listen на `0.0.0.0:PORT`. |
| `app.module.ts` | Корневой модуль: импортирует `ConfigModule`, `RedisModule`, `HealthModule`, `RoomsModule`. |
| `contracts/index.ts` | Zod-схемы и TS-типы REST/WS-контрактов (rooms, participants, chat, WS-события, коды ошибок). Единый источник истины для формата API. |

### `health/` — health-check
| Файл | Что делает |
| --- | --- |
| `health.controller.ts` | `GET /health` → `{status: "ok", service: "api"}`. |
| `health.module.ts` | Регистрация контроллера. |

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
| `room.repository.ts` | `RedisRoomRepository` (`abstract RoomRepository`): запись/чтение room metadata и сессий участников, подсчёт участников, проверка live-участника. Хранение только сериализуемых данных. |
| `room-token.service.ts` | Генерация/верификация токенов: join-токен (JWT-подобный, HS256, с TTL) и `roomSessionToken` (HMAC-SHA256 хэш). |
| `room-errors.ts` | HTTP-исключения с кодами: `ROOM_NOT_FOUND`, `ROOM_EXPIRED`, `ROOM_CLOSED`, `INVALID_TOKEN`. |
| `dto/create-room.dto.ts` | Тело запроса создания комнаты. |
| `dto/join-room.dto.ts` | Тело join (`displayName`, `roomSessionToken?`). |
| `dto/room-params.dto.ts` | Валидация `:slug`. |
| `dto/session-refresh.dto.ts` | Тело refresh (`participantId`, `roomSessionToken`). |

---

## Ключи в Redis

| Ключ | Тип | Назначение |
| --- | --- | --- |
| `room:{roomId}` | string | Метаданные комнаты (статус, expiresAt, signalingUrl…). |
| `room_slug:{slug}` | string | Маппинг slug → roomId. |
| `room:{roomId}:sessions` | hash | Сессии участников (`participantId` → запись с `tokenHash`, `isCreator`…). TTL по `expiresAt`. |
| `room_session_token:{hmac}` | string | Прямой индекс HMAC `roomSessionToken` → `{roomId, participantId}`. TTL совпадает с session. |
| `room:{roomId}:participants` | hash | Живые участники (заполняется media-сервисом; API только читает `hLen`/`hGet`). |

---

## CI/CD

`.gitlab-ci.yml` — pipeline на ветке `main`:
1. **validate** — lint, typecheck, test, build.
2. **build** — сборка Docker-образа (`--target production`), теги `<sha>` + `latest`.
3. **deploy** — копирование `.env` (`DEPLOY_ENV_PROD` или `.env.example`), `docker compose up -d` (сеть `conference-net`).
4. **cleanup** — prune контейнеров/образов старше 24ч.

Runner: `158.160.25.200`. Продуктивная среда: `prod`.
