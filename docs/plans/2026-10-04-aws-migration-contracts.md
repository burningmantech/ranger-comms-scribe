# AWS migration: implementation contracts

Companion to `2026-10-04-aws-migration-prd.md`. These are the interfaces that the Phase 1, 2 and 3 work share. Change them only on purpose, and update this file when you do.

## 1. Storage: `ObjectStore`

R2 is replaced by an injected object store. **Code never imports a concrete store.** It reads `env.STORE`.

- **Interface:** `backend/src/storage/objectStore.ts`
- **Implementations** (all in `backend/src/storage/`):
  - `s3ObjectStore.ts` (`@aws-sdk/client-s3`, endpoint configurable for MinIO)
  - `memoryObjectStore.ts` (in-process, for tests and quick local runs)

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
- **R2 → ObjectStore mapping:**
  - `httpMetadata.contentType` → `contentType`
  - `customMetadata` → `metadata`
  - R2 `list({prefix}).objects[].key` → `list(prefix).objects[].key`
- **`env.STORE: ObjectStore`** replaces `env.R2` in the `Env` interface, which stays in `backend/src/utils/sessionManager.ts` for now.

## 2. Cache

`backend/src/services/cacheService.ts` keeps its exported function names and signatures (`getObject`, `putObject`, `deleteObject`, `listObjects`, `removeFromCache`, and the rest) so its roughly 200 call sites don't change.

- Internally it uses `env.STORE` and an **in-memory TTL map** (module-level `Map`) instead of D1.
- `initCache` and `cleanupExpiredCache` become trivial.
- The `__list__:<prefix>` cache entries remain in memory only.
- Keys such as `__meta__:`, `__exists__:`, `change:`, `change_comments:` and `tracked_changes:` are **durable data**. `putObject` must keep writing them to the store, as it does today.

## 3. Runtime configuration (environment variables)

| Name | Required | Format / default |
|---|---|---|
| `PORT` | no | default `8080` |
| `PUBLIC_URL` | yes | e.g. `https://aws-dev.scrivenly.com/api` |
| `FRONTEND_URL` | yes | e.g. `https://aws-dev.scrivenly.com` |
| `CORS_ORIGINS` | no | comma-separated origins; default: `FRONTEND_URL` plus `http://localhost:3000` |
| `DATA_BUCKET` | yes | S3 bucket name |
| `S3_ENDPOINT` | no | e.g. `http://localhost:9000` for MinIO (forces path-style) |
| `AWS_REGION` | no | default `us-east-1` (S3 client) |
| `SES_REGION` | no | default `us-east-1` |
| `EMAIL_FROM` | no | default `Comms Scribe <alex@scrivenly.com>` |
| `EMAIL_BCC` | no | comma-separated; default empty (no BCC) |
| `BOOTSTRAP_ADMIN_EMAILS` | no | comma-separated, case-insensitive |
| `GOOGLE_CLIENT_ID` | yes | the frontend's OAuth client ID |
| `TURNSTILESECRET` | yes | secret, injected through the ECS task definition's `secrets` |
| `DEV_BYPASS_AUTH` | no | `"true"` enables fake users (local only) |

AWS credentials come from the default credential chain: the task role on ECS, and a profile or MinIO keys locally. No static keys appear in code or config.

## 4. Container

- **Image:** `backend/Dockerfile`, build context `backend/`, multi-stage, Node 20 Alpine. Runs `node dist/server.js`.
- **Process:** one process on `PORT` serving REST under `/api/*` and WebSocket upgrades under `/api/ws/*`.
- **Health:** `GET /healthz` returns `200 {"ok":true}` (outside `/api`, used by the ALB target group).
- **Image name:** ECR repository `comms-scribe`. The dev tag is `:dev`; the standard profile uses commit-ID tags (from `ranger-deploy`).

## 5. WebSocket protocol (unchanged)

The frontend client (`frontend/src/services/websocketService.ts`) must work **without changes**:

- **Paths:** `/api/ws/submissions/:submissionId?sessionId=<id>` and `/api/ws/documents/:documentId?sessionId=<id>`.
- **Message types and shapes:** identical to today's Durable Object (`backend/src/services/websocketService.ts`):
  - server stamps the sender's identity (`userId`, `userName`, `userEmail`) and a per-room `seq` number on relayed messages;
  - `connected`, `room_state`, `user_joined` and `user_left` work as now;
  - ping→pong and heartbeat→heartbeat_response replies work as now.
- **Server-side broadcasts:** `broadcastToSubmissionRoom(...)` and `broadcastToDocumentRoom(...)` keep their signatures, so the 13 call sites in `contentSubmission.ts` and `document.ts` don't change.
- **Room keys:** one scheme for both connecting and broadcasting, `submission:<id>` and `document:<id>`. This fixes the old `document-` prefix mismatch.

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
2. on `localhost` without it, `https://scrivenly.com/api` (keeps today's `npm start` behavior);
3. otherwise `window.location.origin + '/api'`.

## 8. Guardrails for all implementers

- **No deploys or pushes:** no `cdk deploy` or `cdk bootstrap`, no `wrangler deploy`, no AWS commands that change anything, no pushes.
- **Commit** on your own branch in your worktree, and report the branch name and tip SHA.
- **Baseline:** `backend` `npx jest` had 2 failing `pageService` tests ("should handle R2 errors gracefully") before this work. Report them as existing rather than chasing them, or fix them if the mock rewrite makes that natural.
