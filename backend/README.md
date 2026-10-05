# Comms Scribe - Backend API

The backend for the Comms Scribe collaborative content platform. It is a single Node 24 process
that serves:

- the REST API under `/api/*` (itty-router handlers, served through `@whatwg-node/server`);
- WebSocket rooms for real-time editing under `/api/ws/*` (`ws`);
- `GET /healthz`, which returns `200 {"ok":true}` for load-balancer health checks.

Data lives in S3 (MinIO locally) behind the `ObjectStore` interface, with an in-memory TTL cache in
front. Email goes through SES v2. In AWS it runs as one ECS Fargate task behind CloudFront and an
ALB. See `../docs/plans/2026-10-04-aws-migration-prd.md` and
`../docs/plans/2026-10-04-aws-migration-contracts.md`.

## Project structure

```
backend/
├── src/
│   ├── server.ts            # Entry point: load config, run startup work once, listen, handle SIGTERM
│   ├── httpServer.ts        # HTTP server: REST adapter + WebSocket upgrade handling
│   ├── index.ts             # itty-router app, CORS, initializeApp()
│   ├── config/env.ts        # Builds Env from process.env
│   ├── realtime/rooms.ts    # In-process WebSocket rooms (relay, presence, seq, ping)
│   ├── storage/             # ObjectStore interface, S3ObjectStore, MemoryObjectStore
│   ├── handlers/            # Route handlers (auth, blog, content, gallery, websocket, ...)
│   ├── services/            # Business logic (cacheService, userService, mediaService, ...)
│   ├── utils/               # email (SES v2), sessions, client IP, Turnstile, Google tokens
│   ├── authWrappers.ts      # Auth middleware
│   └── types.ts
├── test/                    # Jest tests (test/realtime/rooms.test.ts runs the real server)
├── Dockerfile               # Multi-stage node:24-alpine image, runs node dist/server.js
└── package.json
```

## Configuration

All configuration is read from environment variables once at boot (`src/config/env.ts`).

| Name | Required | Notes |
|---|---|---|
| `PORT` | no | default `8080` |
| `PUBLIC_URL` | yes | e.g. `https://aws-dev.scrivenly.com/api` |
| `FRONTEND_URL` | yes | e.g. `https://aws-dev.scrivenly.com` (used in email links) |
| `CORS_ORIGINS` | no | CSV; default `FRONTEND_URL` plus `http://localhost:3000` |
| `DATA_BUCKET` | yes* | S3 bucket (*not needed with `STORE_DRIVER=memory`) |
| `S3_ENDPOINT` | no | e.g. `http://localhost:9000` for MinIO (forces path-style) |
| `AWS_REGION` | no | default `us-east-1` (S3 client) |
| `SES_REGION` | no | default `us-east-1` |
| `EMAIL_FROM` | no | default `Comms Scribe <alex@scrivenly.com>` |
| `EMAIL_BCC` | no | CSV; default empty (no BCC) |
| `BOOTSTRAP_ADMIN_EMAILS` | no | CSV, case-insensitive; these users become approved Admins once they have proven the address (Google sign-in, or email verification, which clears the password: then use forgot-password) |
| `GOOGLE_CLIENT_ID` | yes | the frontend's OAuth client ID (Google tokens must be issued to it) |
| `TURNSTILESECRET` | yes | Cloudflare Turnstile secret (bot check on login/register/reset) |
| `DEV_BYPASS_AUTH` | no | `true` enables fake dev users. Local only |
| `MAX_BODY_BYTES` | no | largest request body in bytes; default `26214400` (25 MiB). Larger requests get 413 |
| `STORE_DRIVER` | no | `memory` uses an in-process store instead of S3 (tests, quick runs; data lost on restart) |

AWS credentials always come from the default credential chain: the ECS task role in AWS, a profile
or the MinIO keys (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) locally. No keys in code or config.

## Development

```bash
npm install
npm run dev          # tsx watch src/server.ts
npm run build        # esbuild bundle -> dist/server.js
npm start            # node dist/server.js
npm run typecheck    # tsc --noEmit
npm test             # Jest
```

### Quick run with no external services

```bash
STORE_DRIVER=memory DEV_BYPASS_AUTH=true \
PUBLIC_URL=http://localhost:8080/api FRONTEND_URL=http://localhost:3000 \
GOOGLE_CLIENT_ID=x TURNSTILESECRET=x \
npm run dev
```

### With MinIO (persistent local data)

From the repository root, `docker compose up -d --build` starts MinIO, creates the `scribe-local`
bucket and runs the backend container on port 8080. `DEV_BYPASS_AUTH=true docker compose up -d`
enables the fake dev users; `BOOTSTRAP_ADMIN_EMAILS=you@example.com docker compose up -d` makes your
account an admin when you sign in with Google (or after verifying your email). `docker compose down -v` removes everything, including the data.

To run the backend from source against the compose MinIO instead:

```bash
docker compose up -d minio minio-init
cd backend
S3_ENDPOINT=http://localhost:9000 DATA_BUCKET=scribe-local \
AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
PUBLIC_URL=http://localhost:8080/api FRONTEND_URL=http://localhost:3000 \
GOOGLE_CLIENT_ID=x TURNSTILESECRET=x \
npm run dev
```

Then run the frontend with `cd frontend && npm run start:local-backend`.

Email is sent through SES with whatever AWS credentials are available. Locally that usually fails
and is logged. With `DEV_BYPASS_AUTH=true`, the verification and password-reset endpoints return
the token in a `debug` field when the email could not be sent.

## Real-time rooms

`/api/ws/submissions/:id?sessionId=...` and `/api/ws/documents/:id?sessionId=...` upgrade to a
WebSocket after the same session and access checks as the REST API (`authorizeRoomConnection` in
`src/handlers/websocket.ts`). The room is a plain relay:

- on join the new client gets `room_state` and `connected`; others get `user_joined` and `room_state`;
- other messages are relayed to the rest of the room with the sender's `userId`/`userName`/`userEmail`
  and a per-room `seq`;
- `ping` gets `pong`, `heartbeat` gets `heartbeat_response`, and the server sends `ping` every 30 s;
- on disconnect the rest of the room gets `user_left` and `room_state`.

REST handlers broadcast with `broadcastToSubmissionRoom()` / `broadcastToDocumentRoom()`. Room state
is in memory, so the service runs as a single task.

## Docker

```bash
docker build -t comms-scribe:local .
docker run --rm -p 8080:8080 -e STORE_DRIVER=memory -e PUBLIC_URL=http://localhost:8080/api \
  -e FRONTEND_URL=http://localhost:3000 -e GOOGLE_CLIENT_ID=x -e TURNSTILESECRET=x comms-scribe:local
```

The container runs as the non-root `node` user, listens on 8080 and handles SIGTERM by closing
WebSocket connections (code 1001) and the HTTP server.
