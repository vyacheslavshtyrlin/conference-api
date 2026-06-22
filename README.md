# Conference API

Backend API сервиса видеоконференций. Это NestJS + TypeScript сервис, который отвечает за создание комнат, join flow, выдачу join token и хранение room metadata в Redis.

API не занимается WebRTC media plane напрямую. Для подключения клиента к конференции API возвращает публичный signaling URL и токены, а signaling/media сервис уже обрабатывает WebSocket и mediasoup.

## Команды

```bash
npm ci
npm run dev
npm run build
npm run lint
npm run typecheck
npm run test
```

Docker:

```bash
docker compose --env-file .env.example config
docker compose --env-file .env up -d --build
docker compose --env-file .env down
```

## HTTP

Сервис слушает `PORT`, по умолчанию `3000`.

Health endpoint:

```text
GET /api/v1/health
```

## Переменные окружения

| Переменная | Пример | Описание |
| --- | --- | --- |
| `NODE_ENV` | `production` | Режим выполнения Node.js приложения. Для сервера использовать `production`. |
| `PORT` | `3000` | Порт HTTP API внутри контейнера/процесса. |
| `API_IMAGE` | `registry.git.victory-crm.ru/conference/api:latest` | Docker image, который использует `docker-compose.yml` при деплое. |
| `REDIS_URL` | `redis://10.0.0.12:6379` | Redis для room metadata, participants state и TTL. В двухсерверной модели обычно указывает на Redis на media server private IP. |
| `WEB_PUBLIC_URL` | `https://conference.example.com` | Публичный URL фронтенда. Используется для генерации ссылок на комнаты и CORS origin. |
| `MEDIA_NODE_ID` | `media-1` | Логический id media node, к которой API привязывает новые комнаты. |
| `SIGNALING_PUBLIC_URL` | `wss://conference.example.com/ws` | Browser-visible WebSocket URL signaling сервиса. Обычно идет через edge nginx. |
| `JOIN_TOKEN_SECRET` | `replace-with-shared-secret` | Секрет подписи join token. Должен совпадать с `JOIN_TOKEN_SECRET` в media/signaling сервисе. |
| `CREATOR_TOKEN_SECRET` | `replace-with-secret` | Опциональный отдельный секрет для creator token. Если не задан, используется логика приложения по умолчанию. |
| `JOIN_TOKEN_TTL_SECONDS` | `300` | Время жизни join token в секундах. |
| `ROOM_SESSION_TOKEN_SECRET` | `replace-with-secret` | Optional separate secret for hashing `roomSessionToken`. If unset, API falls back to `JOIN_TOKEN_SECRET`. |

## Production routing

Внешний edge должен проксировать:

```text
https://domain/api/v1/ -> api:3000/api/v1/
```
