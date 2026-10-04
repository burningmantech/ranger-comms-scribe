# PRD: Moving Comms Scribe to AWS

**Status:** Draft · **Date:** 2026-10-04 · **Owner:** Alex Young · **Branch:** `feature/aws-migration`

## 1. Summary

Move Comms Scribe off Cloudflare (Workers, R2, D1, Durable Objects, Workers Sites) and onto the AWS services the Ranger tech team already runs: ECS Fargate, ECR, S3, CloudFront, SES and GitHub Actions with `ranger-deploy`.

The stack is set up **from scratch, with empty data**, in Alex's own AWS account first, for further development and validation. Later the same infrastructure code sets up a fresh copy in the Ranger tech team's account. No data is copied between environments.

Estimated effort for one developer: **about 2½–3½ weeks** of focused work to reach a validated deployment in Alex's account (Phases 0–4).

## 2. Background

### 2.1 Current architecture (Cloudflare)

| Concern | Today | Notes |
|---|---|---|
| API | Cloudflare Worker (itty-router v5), route `scrivenly.com/api/*` | `backend/src/index.ts`. `export default router`; `ctx` is unused. |
| Primary data | **R2**, bucket `vox-quietus-r2` | About 30 key-prefix collections of JSON: users, sessions, tokens, submissions, tracked changes, blog, gallery and more. 57 direct `env.R2.*` calls in 13 files, plus about 200 calls through `backend/src/services/cacheService.ts`. |
| Cache | **D1**, one table `object_cache` | A read-through cache only. Nothing in it needs migrating. |
| KV | Not used | Declared in the `Env` type but not bound. |
| Real-time | Durable Object `SubmissionWebSocketServer` | See §2.2. |
| Frontend | Create React App build served by Workers Sites (`frontend/worker/index.js`) | It's Workers Sites, not Cloudflare Pages. It provides the SPA fallback and the HSTS header. |
| Email | **AWS SES v2** through `aws4fetch` | `backend/src/utils/email.ts`. Already on AWS. |
| Bot protection | Cloudflare Turnstile | `frontend/src/components/Login.tsx`, `backend/src/utils/turnstile.ts`. It's a plain HTTPS API and works from anywhere. |
| CI/CD | None; developers run `wrangler deploy` by hand | |

### 2.2 How real-time editing works today

- A browser on `/tracked-changes/:submissionId` opens a WebSocket to `/api/ws/submissions/<id>?sessionId=…`. Everyone on the same submission shares one Durable Object, called the room.
- The Durable Object is a **plain relay**. It adds the sender's identity and a per-room `seq` number, forwards the message to everyone else, and answers ping/heartbeat itself. All state is in memory; it never uses `ctx.storage`.
- **Typing:** `TrackedChangesEditor` sends a `realtime_content_update` at most every 150 ms (`frontend/src/components/TrackedChangesEditor.tsx:2110,2174`). It contains the **full Lexical document as JSON**. Other browsers replace their content with it, so whichever update arrives last wins. There's no operational transform or CRDT: `yjs` and `utils/operationalTransforms.ts` are present but unused.
- **Presence and cursors:** `cursor_position`, `user_joined`/`user_left` and typing indicators.
- **Tracked changes:** `transaction_settled`/`undone`/`redone` and `change_status_updated` are just signals. Other clients respond by reloading the tracked changes over REST.
- **Saving** goes through REST. After REST actions such as approvals, comments and status changes, the server also broadcasts to the room (13 call sites).
- The UI only uses submission rooms (`useSubmissionWebSocket={true}`). Document rooms exist but aren't used in practice.

### 2.3 How the Ranger tech team runs AWS (from `ranger-clubhouse-api` and `ranger-deploy`)

- **Compute:** a Docker image in ECR, running on ECS Fargate in the `rangers` cluster. The scheduler and queue worker run inside the container.
- **Storage and services:** MariaDB, S3, SES with SNS bounce and complaint handling, and Rekognition.
- **CI/CD:** GitHub Actions. Pushes to the main branch deploy to **staging** automatically. A manual `workflow_dispatch` promotes to **production**, limited to a list of approved users.
- **`ranger-deploy` (`deploy_aws_ecs`)** creates no infrastructure. It:
  - pushes the local image to ECR, tagged with the short commit ID;
  - copies the staging service's current task definition, swaps in the new image, and registers it as a new revision;
  - promotes production by copying staging's image;
  - requires **exactly one container per task definition**;
  - refuses to run unless `CI=true`.
- **Clubhouse is an OAuth2/OIDC provider.** That's a possible future login option for Scribe; see Non-goals.

## 3. Goals

1. Run Comms Scribe entirely on AWS, using the same services, deploy tooling and CI patterns as other Ranger services.
2. Make the whole stack **repeatable**: one set of infrastructure code that sets up a working, empty environment in any AWS account from per-environment config.
3. Validate fully in Alex's account, then hand the same code to the tech team for a fresh setup in their account.
4. Keep the current app behavior, including login, workflow, tracked changes and real-time collaboration, without a large rewrite.

## 4. Non-goals

- **Copying data.** Each account starts empty. Content on the current Cloudflare deployment isn't carried over.
- **Moving to a relational database.** Data stays as JSON objects by key prefix, now in S3. RDS/MariaDB is a later project.
- **Changing login.** Google ID-token login and email/password stay. Clubhouse OIDC is a later project.
- **Scaling past one ECS task.** Rooms and the cache live in process memory. Scaling out would need Redis pub/sub and is out of scope.
- **Real merging of simultaneous edits** (OT or CRDT). The current last-write-wins relay stays.
- **Replacing Turnstile.** It keeps working from AWS. AWS WAF CAPTCHA can be decided later.

## 5. Decisions

| Decision | Choice | Why |
|---|---|---|
| Compute | **ECS Fargate, one Node 20 container** | Matches the Ranger norm and `ranger-deploy`. Lambda's 6 MB payload and 29 s timeout limits break uploads, image serving and batch email. A long-running process replaces the in-memory Durable Object directly. |
| Real-time | **`ws` on the Node server behind an ALB** | API Gateway WebSockets cap frames at 32 KB and messages at 128 KB, and full-document updates can exceed that. The ALB supports WebSockets natively. |
| Data | **S3**, keeping the key-prefix model | Smallest change from R2's object model. |
| Cache | **In-process TTL map** | D1 only cached S3/R2 reads, and with one task an in-process cache stays consistent. |
| Infrastructure as code | **AWS CDK (TypeScript)** in `infra/` | Same language as the repo, with per-environment config. *Confirm with the tech team (§11).* |
| Deploys | **`ranger-deploy` through GitHub Actions** | Same deploy path as Clubhouse and IMS, so handoff only needs secrets set. |
| Login | Unchanged | See Non-goals. |

## 6. Target architecture (identical in every account)

```
DNS ──► CloudFront (ACM cert in us-east-1, HSTS response-headers policy)
         ├─ default        → S3 bucket (SPA, OAC; 403/404 → /index.html)
         ├─ /api/gallery/* → ALB (cached, honours 1-yr Cache-Control)
         └─ /api/*         → ALB (no cache; WebSocket upgrade for /api/ws/*)
ALB ──► ECS Fargate service, desiredCount = 1, one Node 20 container
        (two services per account: scribe-staging and scribe-production)
          ├─ S3 data bucket (task role)       ← replaces R2
          ├─ SES v2 (task role)               ← replaces static SES keys
          └─ Secrets Manager: TURNSTILESECRET
ECR repo for the image · CloudWatch Logs
```

- The SPA and API stay on **one origin** (`<host>/` and `<host>/api/...`). Login uses `Authorization: Bearer`, so no cookies or extra CORS setup are needed in production.
- CloudFront must forward the `Authorization` header, all query strings (WebSockets use `?sessionId=`), and the viewer `Host` header (needed for the ALB's host rules).

## 7. Repeatability across accounts

### 7.1 Per-environment config

`infra/config/{alex-staging,alex-production,rangers-staging,rangers-production}.ts` hold:

- account and region
- hostname, plus the hosted zone or certificate ARN
- bucket names
- backend environment variables (§7.4)
- `useExisting: { vpcId, clusterName }`. By default the stack creates its own VPC and cluster; in the tech team's account it can import `rangers`.

### 7.2 Working with `ranger-deploy`

- **One container per task definition.** No sidecars; logs go through the `awslogs` driver.
- **Two ECS services per account**, `scribe-staging` and `scribe-production`, on one cluster and one ECR repo. Each has its own data bucket, SPA bucket and CloudFront distribution. They share one ALB using host-header rules.
- **Who owns what in the task definition:**
  - **CDK owns the structure and the environment variables.** `ranger-deploy` only swaps the image. Don't use `deploy_aws_ecs environment` for this service.
  - Every `cdk deploy` must be given the currently deployed image tag, either as a context value or by reading it from the live service. Otherwise CloudFormation rolls the image back.
- **Deployment settings:** minimum healthy 0% and maximum 100%. Two tasks never run at once with split rooms or diverging caches. The cost is a few seconds of downtime per deploy, which the client's WebSocket reconnect handles.
- `NOTIFY_SMTP_*` (deploy notification emails) can use SES SMTP credentials.

### 7.3 CI/CD (copies Clubhouse)

- `.github/workflows/cicd.yml` runs on pushes to `main`: backend and frontend tests, Docker build, then `bin/deploy staging`.
- `.github/workflows/deploy.yml` is a manual `workflow_dispatch` that runs `bin/deploy production`, limited to a list of approved users.
- `bin/deploy` copies Clubhouse's wrapper, which downloads and runs `deploy_aws_ecs`.
- **Frontend:** each workflow builds it, runs `aws s3 sync frontend/build` to that environment's SPA bucket, and invalidates its CloudFront distribution. Production syncs the same commit's build.
- **One GitHub Environment per account**, `alex` and `rangers`, each with its own `AWS_*`, `AWS_ECS_SERVICE_*`, `AWS_ECR_IMAGE_NAME` and `NOTIFY_*` secrets. The repo is already at `burningmantech/ranger-comms-scribe`, so handoff means the tech team filling in the `rangers` environment.

### 7.4 Configuration

**One frontend build works in every environment.** `frontend/src/config.ts` derives the API base from `window.location.origin + '/api'`. `REACT_APP_API_URL` stays as an override for local development.

**Backend environment variables** (task definition):

| Variable | Purpose |
|---|---|
| `PUBLIC_URL`, `FRONTEND_URL` | Base URLs |
| `CORS_ORIGINS` | Currently hardcoded in `backend/src/index.ts:44-72` |
| `DATA_BUCKET` | S3 data bucket |
| `S3_ENDPOINT` | Optional. Points at MinIO for local development |
| `SES_REGION`, `EMAIL_FROM`, `EMAIL_BCC` | From and BCC are currently hardcoded. `EMAIL_BCC` must be empty in Rangers environments |
| `BOOTSTRAP_ADMIN_EMAILS` | First-admin bootstrap (§8, Phase 2) |
| `TURNSTILESECRET` | Secrets Manager, through the task definition's `secrets` field |

### 7.5 Hostnames

A hostname can be attached to only one CloudFront distribution in all of AWS. Alex's account uses its own names, e.g. `aws-staging.scrivenly.com` and `aws.scrivenly.com`. Bare `scrivenly.com`, or whatever final names the tech team chooses, stays free for the tech team's account.

## 8. Requirements by phase

### Phase 0: Security fixes (≈½ day)

**Requirements**
- R0.1: Rotate the AWS access key whose ID is committed in `backend/wrangler.toml:12` (`SESKey`), because the current Cloudflare deployment still uses it.
- R0.2: `verify()` in `backend/src/handlers/auth.ts:83-90` must reject Google ID tokens whose `aud` isn't the Scribe's client ID.

**Acceptance criteria**
- The old key is deactivated in IAM.
- A Google ID token issued for a different client is rejected with 401, covered by a unit test.

### Phase 1: Storage layer on S3 (≈3–4 days)

**Requirements**
- R1.1: Add `backend/src/services/objectStore.ts`, an `ObjectStore` interface with `get`, `getJson`, `put` (content type and metadata), `head`, `delete`, and `list` with full pagination. Implement it on `@aws-sdk/client-s3`, with a configurable endpoint for MinIO.
- R1.2: The adapter maps S3's lowercased user-metadata keys back to the camelCase keys the code expects: `isPublic`, `groupId`, `userId`, `createdAt`, `takenBy`, `memberId`, `updatedAt` (see `mediaService.ts:6-30`).
- R1.3: Convert `cacheService.ts` and all 53 direct `env.R2.*` call sites to `ObjectStore`. The main files are:
  - `mediaService.ts`, `blogService.ts`, `handlers/auth.ts`, `utils/sessionManager.ts`
  - `trackedChangesService.ts`, `galleryCommentService.ts`, `handlers/{blog,gallery,page,userManagement,councilMembers}.ts`
  - `userService.ts`, `roleService.ts`
- R1.4: Delete the three backfill migrations in `backend/src/migrations/`. They only fix old R2 data.
- R1.5: Update the test mocks (`backend/test/services/cache-mock-helpers.ts`, `test-helpers.ts`) to mock `ObjectStore`.

**Acceptance criteria**
- `cd backend && npm test` passes.
- New adapter tests cover listing more than 1,000 keys and metadata round-trips.
- No `env.R2` references remain in `backend/src`.

### Phase 2: Node server, real-time rooms, fresh-install bootstrap (≈3–5 days)

**Requirements**
- R2.1: Add `backend/src/server.ts`, a Node HTTP server that runs the existing itty-router through `@whatwg-node/server` (`createServerAdapter`). It builds `env` from `process.env` plus the `ObjectStore`, so handler signatures don't change.
- R2.2: Add `backend/src/realtime/rooms.ts`, which replaces the Durable Object:
  - an in-process `Map<roomId, Set<socket>>` that keeps the current relay behavior, identity stamping, per-room `seq` counter, and ping/heartbeat (§2.2);
  - WebSocket upgrades handled with `ws` (`noServer`), reusing the session and access checks in `backend/src/handlers/websocket.ts`;
  - `broadcastToSubmissionRoom` and `broadcastToDocumentRoom` become direct calls, with signatures unchanged;
  - one room-key scheme, which fixes the document-room `document-` prefix mismatch.
- R2.3: Replace the D1 `object_cache` with an in-memory TTL map in `cacheService.ts`.
- R2.4: **First-admin bootstrap.** A user whose email is in `BOOTSTRAP_ADMIN_EMAILS` becomes `userType: Admin`, `isAdmin`, approved and verified on registration or login. Today an admin can only be created by an existing admin (`handlers/userManagement.ts:31`). Startup setup runs once at boot, never on a request; today it runs on `GET /api` (`index.ts:131-182`).
- R2.5: **Relative media URLs (recommended).** Store `/api/gallery/...` paths instead of absolute `${PUBLIC_URL}/gallery/...` URLs (`mediaService.ts:77,101,162,408`), so content survives hostname changes and the later database move. Check `frontend/src/components/editor/plugins/ImagePlugin.tsx` handles them.
- R2.6: Replace `CF-Connecting-IP` (`auth.ts:143,297,380,437`) with a helper that reads `CloudFront-Viewer-Address`, then the first entry of `X-Forwarded-For`, then the socket address.
- R2.7: Switch `utils/email.ts` to `@aws-sdk/client-sesv2` with the default credential chain, and read `EMAIL_FROM`, `EMAIL_BCC` and `SES_REGION` from config.
- R2.8: Add a multi-stage `backend/Dockerfile` (node:20-alpine) and a `/healthz` route.
- R2.9: **Local development:** `npm run dev` runs `tsx watch src/server.ts`. Add `docker-compose.yml` with MinIO and a bucket-creation step. Update `CLAUDE.md` and the READMEs.
- R2.10: Remove the Cloudflare pieces from the backend: `wrangler.toml`, the Durable Object class, `wrangler`, `@cloudflare/workers-types`, and the committed `backend/.wrangler/state` and `wrangler.log`. Declare `uuid`, which currently resolves only through `google-auth-library`, and remove the unused `node-fetch` and `google-auth-library`.

**Acceptance criteria.** All of these pass locally, with `docker compose up` (MinIO plus the server) and `cd frontend && npm run start:local-backend`:
- The bootstrap admin works.
- Create, edit and approve a submission.
- Gallery upload and view.
- Blog.
- Two browsers on one submission see each other's presence, cursors and live content updates.
- A server-side approval or comment appears in the other browser.
- Restarting the container leads to a client reconnect.
- `npm test` passes.

### Phase 3: Infrastructure and CI (≈3–5 days)

**Requirements**
- R3.1: CDK stacks in `infra/` covering §6:
  - SPA bucket with OAC
  - CloudFront with three behaviors, an HSTS headers policy, the SPA error fallback, and forwarding of `Authorization`, query strings and `Host`
  - data bucket with versioning, plus lifecycle expiry on `session/`, `verification-token/` and `reset-token/`
  - ALB with host rules and idle timeout ≥ 120 s
  - ECS Fargate services with deployment settings from §7.2
  - ECR, the task role (data bucket and `ses:SendEmail`), Secrets Manager and CloudWatch Logs
  - SES domain identity, with the DKIM records as outputs
- R3.2: Add `.github/workflows/cicd.yml`, `.github/workflows/deploy.yml` and `bin/deploy` as described in §7.3.
- R3.3: Remove the frontend's Cloudflare pieces: the `wrangler deploy` script, `frontend/worker/`, `frontend/wrangler.toml` and `@cloudflare/kv-asset-handler`.

**Acceptance criteria**
- `cdk synth` succeeds for every config file.
- The CI workflow passes on a pull request.

### Phase 4: Fresh setup and validation in Alex's account (≈2–3 days)

**Steps**
1. Run `cdk bootstrap` and `cdk deploy` with the `alex-*` configs.
2. Add DNS records for `aws-staging.scrivenly.com` (and `aws.scrivenly.com` if used) pointing at CloudFront, plus the SES DKIM records.
3. Add the hostnames to the Google OAuth client's authorized JavaScript origins and to the Turnstile widget's allowed domains.
4. Set the GitHub `alex` environment secrets, push to `main`, and confirm the staging deploy runs through `ranger-deploy`.
5. Register with a `BOOTSTRAP_ADMIN_EMAILS` address, then create users, groups and council and cadre roles through the UI.

SES sandbox mode is acceptable here.

**Acceptance criteria** (on `aws-staging.scrivenly.com`)
- Refreshing a deep link loads the SPA, and the HSTS header is present.
- An authenticated API call works through CloudFront, so `Authorization` is forwarded.
- A WebSocket with `?sessionId=` connects through CloudFront and the ALB, and two-browser collaboration works.
- An upload above 6 MB succeeds.
- Gallery images show `x-cache: Hit from cloudfront`.
- A password-reset email arrives through SES using the task role, with no static keys.
- Turnstile and Google login work.
- The S3 lifecycle rule exists on `session/`.
- `bin/deploy production` promotes staging's image to production.
- `cdk destroy` followed by `cdk deploy` on staging sets up a working, empty environment. This is the same path the Rangers account will take.

## 9. Later: fresh setup in the Ranger tech team's account

- Repeat Phase 4 with the `rangers-*` configs, importing the existing VPC and cluster if the tech team prefers.
- Request SES production access in their account, and set `EMAIL_BCC` to empty.
- Point the final hostname, for example `scrivenly.com`, at that account's CloudFront distribution.
- Retire the Cloudflare deployment whenever Alex chooses. Its content isn't migrated.

## 10. Risks

| Risk | Mitigation |
|---|---|
| `cdk deploy` rolls back an image that `ranger-deploy` deployed | Always pass the current image tag to CDK (§7.2), and document it in `infra/README.md`. |
| In-memory rooms and cache break if a second task runs | `desiredCount = 1` and minimum healthy 0%. Scaling out is a later Redis project. |
| WebSocket drops through CloudFront or the ALB | Idle timeout ≥ 120 s, plus the existing 30 s ping/heartbeat and client reconnect. Checked in Phase 4. |
| Absolute media URLs tie content to a hostname | R2.5 (relative paths). Accounts start empty anyway. |
| CloudFront hostname conflicts at handoff | Alex's account never uses the production names (§7.5). |
| Email still copied to a personal inbox after handoff | `EMAIL_BCC` comes from config and is empty in Rangers environments. |

## 11. Open questions for the tech team

1. Do you accept CDK in this repo, or would you rather use Terraform or console-built infrastructure? `ranger-deploy` works with any of them.
2. Should Scribe use the existing `rangers` cluster and VPC, or its own?
3. GitHub: who maintains the `rangers` environment secrets and the list of approved production deployers?
4. Final hostname, and who owns the `scrivenly.com` registrar and DNS zone (currently on Cloudflare)? Would you want it moved to Route 53?
5. SES: use the existing verified identity and production access in your account, or set up a new `scrivenly.com` identity?

## 12. Existing bugs found during the survey

These are outside the migration's scope except where a phase is noted.

- **Reminders never run.** `scheduled()` is a named export rather than on the default export, there's no cron trigger, and `handlers/reminders.ts` uses the unbound `env.DB` and `env.EMAIL`. Either rebuild later as an in-container scheduler (the Clubhouse pattern) or EventBridge Scheduler, or delete it.
- **Document-room broadcasts are no-ops** because of the room-key mismatch. Fixed in Phase 2 (R2.2).
- **Google `aud` not checked.** Fixed in Phase 0 (R0.2).
- **Listings silently stop at 1,000 keys.** None of the roughly 30 `list()` calls paginate. Fixed in Phase 1 (R1.1).

## 13. Estimates

| Phase | Effort |
|---|---|
| 0: Security fixes | ≈½ day |
| 1: Storage layer on S3 | 3–4 days |
| 2: Node server, rooms, bootstrap | 3–5 days |
| 3: Infrastructure and CI | 3–5 days |
| 4: Fresh setup and validation (Alex's account) | 2–3 days |
| **Total to a validated deployment** | **≈ 2½–3½ weeks** |
| Later: Rangers account setup | 1–2 days plus coordination |
