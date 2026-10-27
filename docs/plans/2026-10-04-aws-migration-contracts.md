# AWS migration: implementation contracts

Companion to `2026-10-04-aws-migration-prd.md`. These are the interfaces that the Phase 1, 2 and 3 work shared, and that the code still follows (the migration is done; see the PRD's status). Change them only on purpose, and update this file when you do.

## 1. Storage: `ObjectStore`

R2 is replaced by an injected object store. **Code never imports a concrete store.** It reads `env.STORE`.

- **Interface:** `backend/src/storage/objectStore.ts`
- **Implementations** (all in `backend/src/storage/`):
  - `s3ObjectStore.ts` (`@aws-sdk/client-s3`, endpoint configurable for MinIO)
  - `memoryObjectStore.ts` (in-process, for tests and quick local runs)
  - `latencyObjectStore.ts` (wraps the memory store with random S3-like delays, `STORE_LATENCY_MS`)

```ts
export interface ObjectInfo {
  key: string;
  size: number;
  uploaded: Date;
  etag?: string;
  contentType?: string;              // from S3 ContentType
  metadata: Record<string, string>;  // user metadata, keys restored to camelCase (see below)
}

export interface StoredObject extends ObjectInfo {
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface ListResult {
  objects: ObjectInfo[];  // ALL keys under the prefix (implementations paginate internally);
                          // list results carry metadata = {} (S3 ListObjectsV2 has no user metadata)
}

export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;   // null when missing (NoSuchKey/404)
  head(key: string): Promise<ObjectInfo | null>;    // null when missing
  put(key: string, body: string | ArrayBuffer | Uint8Array, options?: PutOptions): Promise<void>;
  delete(key: string): Promise<void>;               // no error when missing
  list(prefix: string): Promise<ListResult>;
}
```

- **Metadata casing.** S3 returns user-metadata keys in lowercase. `S3ObjectStore` maps them back to the camelCase keys the code uses: `userId`, `createdAt`, `updatedAt`, `isPublic`, `groupId`, `takenBy`, `memberId`, and any other keys found in `backend/src`. The memory store keeps keys as given.
- **Metadata values are percent-encoded** by `S3ObjectStore` on write and decoded on read, because S3 metadata travels as HTTP headers and non-ASCII values would otherwise be rejected. Anything reading objects outside `S3ObjectStore` (the AWS CLI or console) sees encoded values.
- **R2 → ObjectStore mapping:**
  - `httpMetadata.contentType` → `contentType`
  - `customMetadata` → `metadata`
  - R2 `list({prefix}).objects[].key` → `list(prefix).objects[].key`
- **`env.STORE: ObjectStore`** replaces `env.R2` in the `Env` interface, which is in `backend/src/utils/sessionManager.ts`.

## 2. Cache

`backend/src/services/cacheService.ts` keeps its exported function names and signatures (`getObject`, `putObject`, `deleteObject`, `listObjects`, `removeFromCache`, and the rest) so its roughly 200 call sites don't change.

- Internally it uses `env.STORE` and an **in-memory TTL map** (module-level `Map`) instead of D1.
- `initCache` and `cleanupExpiredCache` are trivial.
- The `__list__:<prefix>` cache entries remain in memory only.
- Everything written with `putObject` is **durable data** and goes to the store, including keys such as `__meta__:`, `__exists__:` and `change_comments:`.
- A store read that a write or invalidation of the same key overtakes is returned but not cached.
- Never `putObject` a copy derived from reads. Tracked changes are read straight from their own keys (`tracked-changes/submission/<id>/...`); the old `change:` shadows and `tracked_changes:submission:` arrays are no longer written, and any left in the store are ignored.

## 3. Runtime configuration (environment variables)

| Name | Required | Format / default |
|---|---|---|
| `PORT` | no | default `8080` |
| `PUBLIC_URL` | yes | e.g. `https://app.scrivenly.com/api` |
| `FRONTEND_URL` | yes | e.g. `https://app.scrivenly.com` |
| `CORS_ORIGINS` | no | comma-separated origins; default: `FRONTEND_URL` plus `http://localhost:3000` |
| `DATA_BUCKET` | yes, unless `STORE_DRIVER=memory` | S3 bucket name |
| `S3_ENDPOINT` | no | e.g. `http://localhost:9000` for MinIO (forces path-style) |
| `AWS_REGION` | no | default `us-east-1` (S3 client) |
| `SES_REGION` | no | default `us-east-1` |
| `EMAIL_FROM` | no | default `Comms Scribe <alex@scrivenly.com>` |
| `EMAIL_BCC` | no | comma-separated; default empty (no BCC) |
| `ANNOUNCE_EMAIL_TO` | no | Ranger Announce, the built-in mailing list for approved requests and newsletter editions; unset disables sending to it (production: `rangers-announce@burningman.org`) |
| `ALLOW_ANNOUNCEMENT_RESEND` | no | `"true"` lets a sent announcement be sent again (dev only) |
| `COMMS_EMAIL_OVERRIDE` | no | mailing-list sends, newsletter editions and workflow emails (`sendWorkflowEmail`: approval requests, reminders, digests, submitter updates) go only to this address, with `[for <real recipients>] ` before the subject (`commsRecipients()` in `utils/email.ts`; set in dev and staging, never in production). Sign-in emails are unaffected |
| `NUDGE_EMAIL_OVERRIDE` | no | Comms Calendar nudges go only to this address instead of the team contacts (set in dev and staging, never in production) |
| `REMINDER_DIGEST` | no | `off` stops the daily reminder digest (8am Pacific); on when unset |
| `BOOTSTRAP_ADMIN_EMAILS` | no | comma-separated, case-insensitive |
| `GOOGLE_CLIENT_ID` | yes | the frontend's OAuth client ID |
| `TURNSTILESECRET` | yes | secret, injected through the ECS task definition's `secrets` |
| `DEV_BYPASS_AUTH` | no | `"true"` enables fake users (local only) |
| `MAX_BODY_BYTES` | no | largest HTTP request body in bytes; default `26214400` (25 MiB, room for a gallery upload's three files). Larger requests get `413` before reaching the router; chunked bodies are cut off once they pass it |
| `WS_MAX_PAYLOAD_BYTES` | no | largest WebSocket message in bytes; default `16777216` (16 MiB; whole-document `realtime_content_update` messages carry full Lexical JSON, images go by URL). A larger message closes the socket with code `1009` |
| `COLLAB_MODE` | no | `yjs` or `legacy` (default). Served to the frontend by the unauthenticated `GET /api/config` as `{"collabMode": ...}`. `yjs` turns on merged editing over the Yjs socket (§9); `legacy` keeps whole-document sync. Any other value is a startup error |
| `STORE_DRIVER` | no | local/test only: `s3` (default) or `memory` (in-process store, data lost on restart; `DATA_BUCKET` not required). Never set it in AWS. |
| `STORE_LATENCY_MS` | no | local/test only: with `STORE_DRIVER=memory`, delays every store call by a random 0..N ms, like S3 round trips. Default `0` |

The loader is `backend/src/config/env.ts`. It fails at startup, listing every missing required variable.

AWS credentials come from the default credential chain: the task role on ECS, and a profile or MinIO keys locally. No static keys appear in code or config.

## 4. Container

- **Image:** `backend/Dockerfile`, build context `backend/`, multi-stage, Node 24 LTS Alpine (`node:24-alpine`; Node 20 reached end-of-life in April 2026). Runs `node dist/server.js`.
- **Process:** one process on `PORT` serving REST under `/api/*` and WebSocket upgrades under `/api/ws/*`.
- **Health:** `GET /healthz` returns `200 {"ok":true}` (outside `/api`, used by the ALB target group).
- **Image name:** ECR repository `comms-scribe`. The dev tag is `:dev`; the standard profile uses commit-ID tags (from `ranger-deploy`).

## 5. WebSocket protocol (JSON rooms)

The migration kept the old Durable Object's protocol, so the frontend client (`frontend/src/services/websocketService.ts`) worked unchanged. The server side is `backend/src/realtime/rooms.ts`:

- **Paths:** `/api/ws/submissions/:submissionId?sessionId=<id>` and `/api/ws/documents/:documentId?sessionId=<id>`.
- **Message types and shapes:** as the Durable Object had them:
  - the server stamps the sender's identity (`userId`, `userName`, `userEmail`) and a `seq` number on relayed messages. `seq` is counted per connection (each socket sees 1, 2, 3, ...), so a sender sees no gap for its own messages (PRD §12);
  - `connected`, `room_state`, `user_joined` and `user_left` work as before;
  - ping→pong and heartbeat→heartbeat_response replies work as before, and the server sends its own `ping` every 30 s.
- **Server-side broadcasts:** REST handlers call `broadcastToSubmissionRoom(...)` and `broadcastToDocumentRoom(...)` directly; their signatures didn't change.
- **Room keys:** one scheme for both connecting and broadcasting, `submission:<id>` and `document:<id>`. This fixed the old `document-` prefix mismatch.

## 6. Infrastructure naming

- **CDK app:** `infra/` (TypeScript, `aws-cdk-lib` v2, own `package.json`).
- **Configs:** `infra/config/{alex-dev,rangers-staging,rangers-production}.ts`.
- **Dev stacks:** `scribe-dev-persistent` and `scribe-dev-compute`.
- **Standard stacks:** `scribe-<env>` (for example `scribe-rangers-staging`).
- **Region:** `us-east-1` by default. That matches SES, and CloudFront certificates must be in us-east-1 anyway.
- **Synth works offline:** account IDs come from config, with environment-variable overrides. No `fromLookup` unless `useExisting` is set.

## 7. Frontend API base

`frontend/src/config.ts` chooses `API_URL` in this order:
1. `REACT_APP_API_URL` if set;
2. on `localhost` without it, `https://scrivenly.com/api` (the old `npm start` behavior; that API is offline until production moves to AWS, so use `npm run start:local-backend`);
3. otherwise `window.location.origin + '/api'`.

## 8. Guardrails for the migration's implementers (historical)

These rules applied to the agents that built Phases 1–3 in separate worktrees: no deploys or pushes, commit on your own branch and report its tip. They no longer apply. The 2 `pageService` tests that failed on the baseline were fixed during the migration (PRD §1a).

## 9. Yjs collaboration socket (Phase 5)

Server: `backend/src/realtime/yjsRooms.ts`. Client: `frontend/src/services/yjsProvider.ts` and `frontend/src/components/editor/collab/YjsCollaboration.tsx`. `COLLAB_MODE=yjs` is set in all three infra configs.

- **Endpoint:** `GET /api/ws/yjs/submissions/:submissionId?sessionId=<id>`, upgraded to a WebSocket.
  - Authorization is identical to the room sockets (`authorizeRoomConnection({ kind: 'submission', id })`).
  - It's a separate upgrade path from `/api/ws/submissions/:id`, which keeps carrying presence, cursors and workflow events.
- **Protocol:** the standard y-websocket wire protocol, so the stock `y-websocket` `WebsocketProvider` works as the client. Frames are binary, encoded with `lib0`:
  - `messageSync = 0`: `y-protocols/sync` (step 1, step 2, update);
  - `messageAwareness = 1`: `y-protocols/awareness` updates;
  - `messageQueryAwareness = 3`.
  
  The client connects with `new WebsocketProvider(wsBase + '/api/ws/yjs/submissions', submissionId, doc, { params: { sessionId } })`, where `wsBase` is `API_URL`'s origin with ws/wss.
- **Server state:** one `Y.Doc` per submission, in memory. It's destroyed 30 s after the last client leaves. A later session seeds again from saved content.
- **Exactly one bootstrap (seeding rule):**
  - While the room's doc is empty, the server answers sync step 1 from only **one** client, the seeder (the first to join). It sends that client step 2 (empty state) at once.
  - Every other client's step-1 reply is held until the doc becomes non-empty (the seed update arrives). Held clients then get step 2 with the full state.
  - If the seeder disconnects before seeding, the next waiting client becomes the seeder and gets its reply.
  - A held client therefore never sees an empty synced doc. Lexical's `CollaborationPlugin` only bootstraps (applies `initialEditorState`) when the synced doc is empty, so it can't duplicate content.
- **Relay:** each update from a client is applied to the server doc and broadcast to the other clients in the room. Awareness is relayed to every client, the sender included (the y-websocket client closes a socket that hears nothing for 30 s, and its own awareness renewal coming back keeps a lone client open), and cleaned up when a client disconnects.
- **Limits:** the existing `WS_MAX_PAYLOAD_BYTES` applies, and the same dead-connection rule as the rooms. The keepalive is a WebSocket protocol ping frame, never a JSON `ping` (the client decodes every message as binary).
- **Feature flag:** the frontend uses this socket only when `GET /api/config` returns `{"collabMode": "yjs"}` (`COLLAB_MODE=yjs`, §3). It fetches the flag once before showing the editor and falls back to `legacy` if the request fails.
  - In `yjs` mode the editor mounts Lexical's `CollaborationPlugin` with a fresh `Y.Doc` per mount, and the JSON room (§5) carries only presence and workflow events (`transaction_settled`, `change_status_updated`, ...). The editor never sends `realtime_content_update`, `content_updated`, typing or cursor messages, and never replaces the whole document after the initial load.
  - In `legacy` mode nothing changes.
- **Tracked changes in `yjs` mode:** `POST /api/tracked-changes/submission/:id` bodies add `"diffAgainstOldValue": true`. The server then diffs the change against the `oldValue` it was sent with (the merged document just before this user's edit) instead of the latest saved proposed version, which may be another user's concurrent save. Without the flag, behavior is unchanged.
