# API Agent Guide

Owner: API implementation agent for `api/**`.
Reviewer: Reviewer agent (`../.agents/reviewer-agent.md`).

Use this file for changes under `api/**`.

Required reading:

- `../AGENTS.md`
- `../docs/agents.md`
- `../docs/architecture.md`
- `../docs/contracts.md`

Required skills:

- `nestjs-best-practices`
- `prisma-expert` for the approved E12 PostgreSQL/Prisma recording control
  plane

Ownership:

- Owns room creation, room lookup, join token issuing, creator marker handling and health checks.
- Owns API-side room metadata writes to Redis.
- Owns E12 PostgreSQL/Prisma recording, segment, composition-job, artifact and
  callback-delivery control state, plus worker-facing internal API endpoints.
- Does not own WebSocket sessions, mediasoup runtime, media routing, frontend device behavior or deployment topology.

Rules:

- Use NestJS feature modules with thin controllers and service-owned business logic.
- Keep the API boundary focused on room creation, room lookup, join token issuing and future product commands.
- Validate DTOs and keep response shapes aligned with `docs/contracts.md`.
- Keep `api/src/contracts` aligned with source-of-truth behavior in `docs/contracts.md`.
- Store only serializable room/session metadata in Redis.
- Keep E12 workers behind private API contracts: workers never receive
  `DATABASE_URL` or permanent S3 credentials, and API never proxies media
  bytes.
- Room creation must not create a live participant; creator joins only after explicit Join.
- `isCreator` is metadata and must not create host/moderation permissions without an architecture decision.
- Assign and persist `mediaNodeId` and `signalingUrl` when the room is created.
- Join responses must return the assigned room `signalingUrl`; do not randomly select a signaling node during join.
- If API work needs new REST, token or Redis shape, stop and route the contract change through the Architect first.

Verification before handoff:

- `npm run typecheck --workspace @conference/api`
- `npm run test --workspace @conference/api`
- Integration reasoning for create room -> room lookup -> join token issuing.
