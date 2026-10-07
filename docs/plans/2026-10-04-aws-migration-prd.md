# PRD: Moving Comms Scribe to AWS

**Status:** Phases 0–5 implemented and deployed to Alex's account (app.scrivenly.com, `COLLAB_MODE=yjs`) · **Date:** 2026-10-04 · **Owner:** Alex Young · **Branch:** `feature/aws-migration`

## 1. Summary

Move Comms Scribe off Cloudflare (Workers, R2, D1, Durable Objects, Workers Sites) and onto the AWS services the Ranger tech team already runs: ECS Fargate, ECR, S3, CloudFront, SES and GitHub Actions with `ranger-deploy`.

The stack is set up **from scratch, with empty data**, in two places, both from the same infrastructure code:

- **Alex's own AWS account first.** This is a **low-cost development environment**: one Spot task, and it can be put to sleep when not in use. Expect about **$5–15 a month** (§7.7).
- **The Ranger tech team's account later,** using the **standard** profile: always-on staging and production services and the tech team's usual development flow, where changes go to staging first and are then promoted to production.

No data is copied between environments.

Estimated effort for one developer: **about 2½–4 weeks** of focused work to reach a validated development environment in Alex's account (Phases 0–4).

## 1a. Implementation status (2026-10-04)

| Phase | Status |
|---|---|
| 0: Security fixes | Done and deployed to the live Cloudflare site (PR #3). SES key rotated, Turnstile secret set, SES domain verified. |
| 1: Storage layer on S3 | Done: `backend/src/storage/` and the in-memory cache. |
| 2: Node server, rooms, bootstrap | Done: `src/server.ts`, `src/realtime/rooms.ts`, Dockerfile, docker-compose. Cloudflare pieces removed. |
| 3: Infrastructure and CI | Done: `infra/` (dev and standard profiles), `bin/`, `.github/workflows/`. |
| 4: Fresh setup in Alex's account | **Deployed 2026-10-04** to account 821327748249 at `https://app.scrivenly.com` (CLI profile `mybestday`). Persistent and compute stacks are up, and the first deploy went through `ranger-deploy`. The bootstrap admin signed in with Google. Acceptance checks run in the browser on 2026-10-04:
  - **Passed:**
    - submission created and opened;
    - WebSocket upgrade through CloudFront and the ALB (`room_state`, `connected`, `pong`);
    - 6.29 MB upload, with the full-size, thumbnail and medium images served as `image/jpeg`;
    - gallery responses show `x-cache: Hit from cloudfront`;
    - SPA deep links, HSTS, API 404 stays a 404;
    - the ALB is unreachable directly;
    - no errors in the container logs.
  - **Passed, two-user collaboration** (two Chrome profiles: Alex as Admin, HelpDesk as Comms Cadre): each user's presence avatar and labelled remote cursor appear in the other window, and typing from either side shows up live as that user's tracked change.
  - **Fixed along the way:** a fresh login showed "Please log in to view requests" until a page reload, because `ContentContext` ignored `USER_LOGIN_EVENT` (pre-existing; also on the live site).
  - **Still manual:** forgot-password, which needs a human to pass Turnstile and also proves SES from the task role. |
| 5: Real-time merging with Yjs (§14) | Server and editor implemented behind `COLLAB_MODE=yjs` (on in `alex-dev` only); see §14.5. Not yet deployed or tested on the dev site. |

**Changes made during implementation, beyond the requirements above:**
- `POST /auth/register` returns 409 for any existing email. Registering the email of a Google-only or admin-created user used to return a session for that account, which was an account takeover.
- Reset and verification debug tokens are only returned when `DEV_BYPASS_AUTH=true`.
- The hardcoded admin email in `getUser`/`initializeFirstAdmin` was removed; `BOOTSTRAP_ADMIN_EMAILS` replaces it.
- The dead reminders feature (`handlers/reminders.ts`, `scheduled()`) was deleted.
- The announcement recipient is now `ANNOUNCE_EMAIL_TO`. Unset disables sending; only `rangers-production` sets the real list.
- Gallery thumbnail and medium URLs now serve image bytes. Before, they always returned 404.
- WebSocket rooms close a connection after about 70 s of silence. The Durable Object runtime used to detect dead connections itself.
- The 2 long-failing pageService tests were fixed (they tested the wrong call).
- The local `docker-compose.yml` uses the community MinIO build `pgsty/minio`, because the official `minio/minio` image couldn't be pulled.

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
- **No existing Ranger WebSocket server to reuse.**
  - Clubhouse has no browser push at all. Its "Broadcast" code (`app/Lib/RBS.php`) is the Ranger Broadcasting Service, which sends SMS and email.
  - IMS pushes incident updates with Server-Sent Events, keeping the list of listeners in memory inside its own app process (`src/ims/application/_eventsource.py`).

  So Scribe will build its own real-time server (§8, R2.2), and IMS's in-process listener list is the precedent for that design.

## 3. Goals

1. Run Comms Scribe entirely on AWS, using the same services, deploy tooling and CI patterns as other Ranger services.
2. Make the whole stack **repeatable**: one set of infrastructure code that sets up a working, empty environment in any AWS account from per-environment config.
3. Validate fully in Alex's account, then hand the same code to the tech team for a fresh setup in their account.
4. Keep the current app behavior, including login, workflow, tracked changes and real-time collaboration, without a large rewrite.
5. **Keep Alex's development account cheap.** Use Spot capacity, allow the environment to be put to sleep when not in use, use no NAT Gateway, and avoid paid features. The target is under $15 a month for typical part-time use.

## 4. Non-goals

- **Copying data.** Each account starts empty. Content on the current Cloudflare deployment isn't carried over.
- **Moving to a relational database.** Data stays as JSON objects by key prefix, now in S3. RDS/MariaDB is a later project.
- **Changing login.** Google ID-token login and email/password stay. Clubhouse OIDC is a later project.
- **Scaling past one ECS task.** Rooms and the cache live in process memory. Scaling out would need Redis pub/sub and is out of scope.
- ~~Real merging of simultaneous edits~~: **now in scope** (decided 2026-10-05). See §14, Phase 5.
- **Replacing Turnstile.** It keeps working from AWS. AWS WAF CAPTCHA can be decided later.

## 5. Decisions

| Decision | Choice | Why |
|---|---|---|
| Compute | **ECS Fargate, one Node 24 container** | Matches the Ranger norm and `ranger-deploy`. Lambda's 6 MB payload and 29 s timeout limits break uploads, image serving and batch email. A long-running process replaces the in-memory Durable Object directly. |
| Real-time | **`ws` on the Node server behind an ALB** | API Gateway WebSockets cap frames at 32 KB and messages at 128 KB, and full-document updates can exceed that. The ALB supports WebSockets natively. |
| Data | **S3**, keeping the key-prefix model | Smallest change from R2's object model. |
| Cache | **In-process TTL map** | D1 only cached S3/R2 reads, and with one task an in-process cache stays consistent. |
| Infrastructure as code | **AWS CDK (TypeScript)** in `infra/` | Same language as the repo, with per-environment config. *Confirm with the tech team (§11).* |
| Deploys | **`ranger-deploy`**. Standard profile: through GitHub Actions. Dev: `bin/dev-deploy` from Alex's laptop | Same deploy tool as Clubhouse and IMS. In dev, running from the laptop keeps personal AWS keys out of the `burningmantech` repo's secrets, and avoids failed automatic deploys while dev is asleep. |
| Environment profiles | **`dev`** (Alex's account) and **`standard`** (Rangers account) | Same app and the same infrastructure code. Only capacity type, the sleep option and the number of environments differ (§7.6). |
| Login | Unchanged | See Non-goals. |

## 6. Target architecture (same shape in every account)

```
DNS ──► CloudFront (ACM cert in us-east-1, HSTS response-headers policy)
         ├─ default        → S3 bucket (SPA, OAC; CloudFront Function: extensionless paths → /index.html)
         ├─ /api/gallery/* → ALB (cached, honours 1-yr Cache-Control)
         └─ /api/*         → ALB (no cache; WebSocket upgrade for /api/ws/*)
ALB ──► ECS Fargate service, desiredCount = 1
        ┌─ one Node 24 container (one process, one port) ─────────────┐
        │  HTTP API      itty-router handlers (REST)                  │
        │  WebSocket     `ws` rooms on /api/ws/* (replaces the DO)    │
        │  Cache         in-memory TTL map (replaces D1)              │
        └──────────────────────────────────────────────────────────────┘
          ├─ S3 data bucket (task role; S3 gateway endpoint)  ← replaces R2
          ├─ SES v2 (task role)                               ← replaces static SES keys
          └─ TURNSTILESECRET (Secrets Manager, or SSM Parameter Store in dev)
ECR repo for the image · CloudWatch Logs
```

- **One process serves both REST and WebSockets.** The REST handlers broadcast to rooms directly, and rooms and the cache share memory. `ranger-deploy` allows only one container per task, which also rules out a separate WebSocket sidecar.
- **Profiles** (§7.6):
  - **standard:** two services, `scribe-staging` and `scribe-production`, on on-demand Fargate.
  - **dev:** one service on Fargate Spot. The ALB and service exist only while dev is awake.
- The SPA and API stay on **one origin** (`<host>/` and `<host>/api/...`). Login uses `Authorization: Bearer`, so no cookies or extra CORS setup are needed in production.
- CloudFront must forward the `Authorization` header and all query strings (WebSockets use `?sessionId=`). In the standard profile it must also forward the viewer `Host` header, which the shared ALB's host rules need.
- **SPA fallback uses a CloudFront Function, not custom error responses.** Custom error responses apply to the whole distribution. An API 403 or 404 would be replaced by `index.html` with status 200, which breaks access-denied and not-found handling in the frontend.
- **Network** (when the stack creates its own VPC, which is the dev profile):
  - Public subnets only, with `natGateways: 0`.
  - An S3 gateway endpoint, which is free.
  - The task gets a public IP for outbound traffic: ECR pulls, SES, SSM or Secrets Manager, Google tokeninfo, Turnstile siteverify, and the Google Docs image proxy. Its security group accepts inbound traffic only from the ALB.
  - In the standard profile, the stack uses whatever network the tech team provides.

## 7. Repeatability across accounts

### 7.1 Per-environment config

`infra/config/{alex-dev,rangers-staging,rangers-production}.ts` hold:

- `profile: 'dev' | 'standard'` (§7.6)
- account and region
- hostname, plus the hosted zone or certificate ARN
- bucket names
- backend environment variables (§7.4)
- `useExisting: { vpcId, clusterName }`. By default the stack creates its own VPC and cluster; in the tech team's account it can import `rangers`.

### 7.2 Working with `ranger-deploy`

- **One container per task definition.** No sidecars; logs go through the `awslogs` driver.
- **Standard profile: two ECS services**, `scribe-staging` and `scribe-production`, on one cluster and one ECR repo. Each has its own data bucket, SPA bucket and CloudFront distribution. They share one ALB using host-header rules.
- **Dev profile: one ECS service.** `ranger-deploy`'s `staging` command targets it. Promotion to production is first tested on Rangers staging (§9).
- **Who owns what in the task definition:**
  - **CDK owns the structure and the environment variables.** `ranger-deploy` only swaps the image. Don't use `deploy_aws_ecs environment` for this service.
  - **Standard:** every `cdk deploy` must be given the currently deployed image tag, either as a context value or by reading it from the live service. Otherwise CloudFormation rolls the image back.
  - **Dev:** use a fixed tag, `AWS_ECR_IMAGE_NAME=<repo>:dev`. `ranger-deploy` only adds the commit-ID tag when the name has no `:`. CDK and the deploy script then always agree on the image, and waking dev runs the latest `:dev` image.
- **Deployment settings:** minimum healthy 0% and maximum 100%. Two tasks never run at once with split rooms or diverging caches. The cost is a few seconds of downtime per deploy, which the client's WebSocket reconnect handles.
- `NOTIFY_SMTP_*` (deploy notification emails) can use SES SMTP credentials.

### 7.3 CI/CD (copies Clubhouse)

- `.github/workflows/cicd.yml` runs on pushes to `master`: backend and frontend tests, Docker build, then `bin/deploy staging`.
- `.github/workflows/deploy.yml` is a manual `workflow_dispatch` that runs `bin/deploy production`, limited to a list of approved users.
- `bin/deploy` copies Clubhouse's wrapper, which downloads and runs `deploy_aws_ecs`.
- **Frontend:** each workflow builds it, runs `aws s3 sync frontend/build` to that environment's SPA bucket, and invalidates its CloudFront distribution. Production syncs the same commit's build.
- **One GitHub Environment, `rangers`,** holds the `AWS_*`, `AWS_ECS_SERVICE_*`, `AWS_ECR_IMAGE_NAME` and `NOTIFY_*` secrets. The repo is already at `burningmantech/ranger-comms-scribe`, so handoff means the tech team filling in that environment. Until then, the deploy steps in the workflows are skipped and only tests and the Docker build run.
- **Dev deploys don't use GitHub Actions.** `bin/dev-deploy` builds the image and runs `deploy_aws_ecs staging` with `CI=true` and Alex's local AWS profile. It then syncs the frontend and invalidates CloudFront. No personal AWS keys go into the org repo's secrets.

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
| `TURNSTILESECRET` | Through the task definition's `secrets` field. Standard: Secrets Manager. Dev: SSM Parameter Store SecureString, which is free |

### 7.5 Hostnames

A hostname can be attached to only one CloudFront distribution in all of AWS.

- **Alex's account** uses `app.scrivenly.com`, in a Route 53 hosted zone for `app.scrivenly.com` delegated from the Cloudflare zone by NS records (about $0.50/month). That zone also holds:
  - `origin.app.scrivenly.com`, the stable name CloudFront uses for the API origin (§7.6);
  - automated ACM DNS validation.
- **The tech team's account** keeps bare `scrivenly.com`, or whatever final names they choose.

### 7.6 Environment profiles

| | `dev` (Alex's account) | `standard` (Rangers account) |
|---|---|---|
| Environments | One (`alex-dev`) | Staging and production |
| Capacity | Fargate Spot only, 0.25 vCPU / 0.5 GB | On-demand Fargate, sized by the tech team |
| Availability | **Wakes and sleeps on demand.** The ALB and ECS service exist only while dev is awake | Always on |
| Network | Stack-created VPC: public subnets, no NAT, S3 gateway endpoint | Tech team's existing VPC and cluster (or stack-created) |
| ALB | Own ALB, created on wake | Shared ALB with host rules (possibly the tech team's existing one) |
| Deploys | `bin/dev-deploy` from a laptop, `:dev` image tag | GitHub Actions: pushes to `master` deploy staging, then manual promotion to production |
| Secrets | SSM Parameter Store | Secrets Manager |
| Cost guardrail | AWS Budgets alert at $15/month | Tech team's normal monitoring |

**How the dev profile sleeps and wakes.** The CDK app has two stacks:

- **`scribe-dev-persistent`:** buckets, ECR, CloudFront, certificates, the Route 53 zone, the cluster, IAM roles, SES identity, SSM parameters and log groups. It stays deployed, and costs about $1–3 a month at rest.
- **`scribe-dev-compute`:** the ALB, listener, target group, ECS service and the `origin.app.scrivenly.com` alias record pointing at the ALB.
  - `bin/dev-up` deploys this stack. It takes about 5 minutes: creating the ALB and starting the task.
  - `bin/dev-down` destroys it.
  - CloudFront is never changed when dev wakes or sleeps, because its API origin is the stable `origin.` name. The ALB's regional ACM certificate covers both `origin.app.scrivenly.com` and `app.scrivenly.com`.
  - While asleep, the SPA still loads, and `/api/*` fails until `bin/dev-up` runs.
- **Data persists while dev is asleep.** Everything stateful lives in S3.

**Spot interruptions.** The ECS cluster enables the Fargate capacity providers. The dev service's capacity strategy uses only `FARGATE_SPOT`. If AWS reclaims the task, ECS starts a replacement, and clients reconnect their WebSockets.

### 7.7 Estimated monthly cost

These are estimates from us-east-1 list prices, not a quote. Check them in the AWS Pricing Calculator before relying on them.

**Dev profile (Alex's account)**

| Item | While awake | While asleep |
|---|---|---|
| ALB (base plus minimal LCU) | ~$0.03/h | $0 (deleted) |
| Public IPv4: 2 on the ALB, 1 on the task | ~$0.015/h | $0 |
| Fargate Spot task, 0.25 vCPU / 0.5 GB | ~$0.003–0.005/h | $0 |
| Route 53 zone, S3, ECR (lifecycle-limited), CloudWatch Logs (7-day retention), SSM, CloudFront (free allowance), ACM, Budgets | n/a | ~$1–3/month |

| Usage pattern | Estimated monthly total |
|---|---|
| Awake ~20 h/week | **~$5–7** |
| Awake ~40 h/week | **~$10–12** |
| Left awake all month by mistake | ~$38–40 (the $15 Budgets alert catches this early) |

**Do public IPs need to be paid for at all?** Only while dev is awake.

- **Inbound:** an internet-facing ALB needs public IPs.
- **Outbound:** the task needs internet access for ECR, SES, SSM, Google and Turnstile. A task public IP is the cheapest way to get it. A NAT Gateway costs about $33 per AZ per month. A NAT instance needs its own public IP. Interface endpoints cost about $7 each per AZ per month and still don't reach Google or Turnstile.
- **IPv6-only networking** might remove the IPv4 charges. Whether every dependency supports it is unverified, so it's not part of this plan.

**Standard profile (Rangers account):**

- **Running alone,** two always-on services with their own ALB and network: ~$55–60/month.
- **Sharing the tech team's existing cluster, VPC and ALB:** probably ~$15–25/month on top of what they already pay.

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
- R2.8: Add a multi-stage `backend/Dockerfile` (node:24-alpine) and a `/healthz` route.
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

### Phase 3: Infrastructure and CI (≈3½–6 days)

**Requirements**
- R3.1: CDK stacks in `infra/` covering §6, driven by `profile`:
  - SPA bucket with OAC.
  - CloudFront with three behaviors, an HSTS headers policy, and a **CloudFront Function** on the default behavior that rewrites extensionless paths to `/index.html`. No custom error responses. It forwards `Authorization` and query strings, plus `Host` in the standard profile.
  - Data bucket:
    - versioning;
    - lifecycle expiry on `session/`, `verification-token/` and `reset-token/`;
    - noncurrent object versions expire after 30 days.
  - ALB with idle timeout ≥ 120 s. Host rules in the standard profile.
  - ECS Fargate service or services with deployment settings from §7.2. Capacity strategy: `FARGATE_SPOT` only in dev, `FARGATE` in standard.
  - ECR with a lifecycle rule that expires untagged images and keeps the last 10 tagged ones.
  - Task role (data bucket and `ses:SendEmail`).
  - Secrets: SSM Parameter Store in dev, Secrets Manager in standard.
  - CloudWatch Logs with 7-day retention in dev and 30-day retention in standard.
  - SES domain identity, with the DKIM records as outputs.
  - Network when the stack creates the VPC: public subnets only, `natGateways: 0`, an S3 gateway endpoint, the task gets a public IP, and the task security group accepts traffic only from the ALB.
- R3.2: Dev sleep and wake (§7.6):
  - split the CDK app into `scribe-dev-persistent` and `scribe-dev-compute`;
  - Route 53 zone for `app.scrivenly.com` with the stable `origin.` alias;
  - `bin/dev-up`, `bin/dev-down` and `bin/dev-deploy`;
  - an AWS Budgets alert at $15/month.
- R3.3: Add `.github/workflows/cicd.yml`, `.github/workflows/deploy.yml` and `bin/deploy` as described in §7.3. Deploy steps are skipped until the `rangers` environment is configured.
- R3.4: Remove the frontend's Cloudflare pieces: the `wrangler deploy` script, `frontend/worker/`, `frontend/wrangler.toml` and `@cloudflare/kv-asset-handler`.
- R3.5: Write `infra/README.md` covering the profiles, the wake and sleep commands, image-tag rules (§7.2) and expected costs (§7.7).

**Acceptance criteria**
- `cdk synth` succeeds for every config file.
- The synthesized dev template contains no NAT Gateway.
- The CI workflow passes on a pull request.

### Phase 4: Fresh setup and validation in Alex's development account (≈2–3 days)

**Steps**
1. Run `cdk bootstrap`, then deploy `scribe-dev-persistent` with the `alex-dev` config.
2. In the Cloudflare zone, add NS records delegating `app.scrivenly.com` to the new Route 53 zone, plus the SES DKIM records.
3. Add `app.scrivenly.com` to the Google OAuth client's authorized JavaScript origins and to the Turnstile widget's allowed domains.
4. Run `bin/dev-up`, then `bin/dev-deploy`. Confirm the deploy goes through `ranger-deploy` (`deploy_aws_ecs staging`, `:dev` tag).
5. Register with a `BOOTSTRAP_ADMIN_EMAILS` address, then create users, groups and council and cadre roles through the UI.

SES sandbox mode is acceptable here.

**Acceptance criteria** (on `app.scrivenly.com`)
- Refreshing a deep link loads the SPA, and the HSTS header is present.
- An API 403 and an API 404 through CloudFront return JSON with the correct status, not `index.html`.
- An authenticated API call works through CloudFront, so `Authorization` is forwarded.
- A WebSocket with `?sessionId=` connects through CloudFront and the ALB, and two-browser collaboration works.
- An upload above 6 MB succeeds.
- Gallery images show `x-cache: Hit from cloudfront`.
- A password-reset email arrives through SES using the task role, with no static keys.
- Turnstile and Google login work.
- The S3 lifecycle rule exists on `session/`.
- The task runs on `FARGATE_SPOT`, and the account has no NAT Gateway.
- **Sleep and wake:**
  - after `bin/dev-down`, no ALB, ECS task or public IPv4 address remains in the account;
  - after `bin/dev-up`, the app works again within about 10 minutes, with all data intact and no CloudFront change.
- Destroying both dev stacks and redeploying sets up a working, empty environment.
- The AWS Budgets alert exists.

The GitHub Actions deploy path and `bin/deploy production` promotion are first tested on Rangers staging (§9).

## 9. Later: fresh setup in the Ranger tech team's account

This uses the **standard** profile: the tech team's regular production setup, with development going to staging first and then promoted.

- Deploy with the `rangers-staging` and `rangers-production` configs: on-demand Fargate, always on, importing the existing VPC, cluster and ALB if the tech team prefers.
- Configure the `rangers` GitHub Environment. From then on:
  - pushes to `master` run tests and `bin/deploy staging`;
  - promotion is the manual `deploy.yml` workflow (`bin/deploy production`).
- Request SES production access in their account, and set `EMAIL_BCC` to empty.
- Point the final hostname, for example `scrivenly.com`, at the production CloudFront distribution.
- Retire the Cloudflare deployment whenever Alex chooses. Its content isn't migrated.

**Acceptance criteria**, in addition to Phase 4's app checks on the staging hostname:
- A push to `master` deploys to staging through GitHub Actions.
- `bin/deploy production` promotes staging's image to production.
- Production stays up through a staging deploy.

## 10. Risks

| Risk | Mitigation |
|---|---|
| `cdk deploy` rolls back an image that `ranger-deploy` deployed | Standard: always pass the current image tag to CDK. Dev: the fixed `:dev` tag (§7.2). Documented in `infra/README.md`. |
| Dev left awake and costs creep up | AWS Budgets alert at $15/month. Asleep, dev costs about $1–3 a month. |
| Spot interruption in dev drops sessions briefly | ECS starts a replacement task automatically, and clients reconnect their WebSockets. Dev only; standard uses on-demand. |
| SPA fallback hides API errors | A CloudFront Function rewrite instead of distribution-wide custom error responses (§6), checked in Phase 4. |
| A CDK-created VPC adds NAT Gateways by default (~$65/month) | `natGateways: 0`, checked in Phase 3 acceptance. |
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
- **Document routes aren't mounted.** `handlers/document.ts` isn't mounted in `index.ts`, so its endpoints, and the `broadcastToDocumentRoom` calls inside them, can't be reached. The UI uses only submission rooms today.
- **Private gallery files are publicly readable by URL.** `GET /api/gallery/:filename` serves any object under `gallery/` with no access check and a one-year public `Cache-Control`, so anyone who learns a private file's name can fetch it.
  - A simple `Authorization` check won't work, because images load through plain `<img>` tags, which can't send the Bearer token.
  - Options: short-lived signed URLs (CloudFront or S3 presigned) for non-public media, or a signed query token checked by the route.
  - Not in migration scope. CloudFront caching doesn't widen the exposure, because private responses would also need `private`/`no-store` once fixed.

Found in the AWS migration review and not fixed yet:

- ~~**Collaborator identity mismatch.**~~ Fixed 2026-10-05: sockets now use `user.id || user.email`, matching REST broadcasts and the frontend.
- ~~**`seq` gap for the sender.**~~ Fixed 2026-10-05: `seq` is counted per connection. This was the main cause of a lone typist losing keystrokes (see §14).
- **Presence flicker with two tabs.** When a user with two tabs open closes one, the room broadcasts `user_left` for them although their other socket is still connected. Announce `user_left` only when the user's last socket in the room closes (`room_state` already deduplicates by `userId`).
- **Long API calls time out at CloudFront.** The API origin's `readTimeout` is 60 s (`infra/lib/shared.ts`), so `/api` requests that run longer return 504. 60 s is CloudFront's default maximum (more needs a quota increase, up to 180 s), so prefer making slow endpoints asynchronous.
- **Standard stacks each create their own network.** Without `useExisting`, staging and production each create a VPC, cluster and ALB (§7.7's ~$55–60/month case). Share them by creating them once (a small shared stack, or one stack importing the other's), or use the tech team's existing ones.
- **Account pre-hijack by registration.** Anyone can register a victim's (non-bootstrap) email with their own password, and keeps that password once the victim clicks the verification link. On `/auth/verify-email`, clear the password of an account that was created by email registration and has never logged in, or require the password to be set from the emailed link.
- **Unpinned MinIO image.** The local `docker-compose.yml` uses the community image `pgsty/minio` because the official images couldn't be pulled. Pin it by digest (`pgsty/minio@sha256:…`).
- **Production deployer allow-list.** The "Check user" step in `.github/workflows/deploy.yml` allows `alexyoung`, but the maintainer's GitHub login is `alexanderyoung`. Left for the maintainer to change.

## 14. Real-time editing: findings and Phase 5 (Yjs)

### 14.1 Fixed on 2026-10-05, from two-browser editing tests

All of these predate the migration; the live Cloudflare site has them too.

1. **A lone typist lost recent keystrokes.**
   - Per-room `seq` made each sender see a gap, so the client fired `sync_needed`.
   - `refreshWithRemoteGuard` then froze change tracking for 5 s and reloaded stale server content.
   - Fixed by counting `seq` per connection.
2. **Idle editors echoed content they had just received.** A timer-based "remote" flag expired before Lexical's async onChange ran. Remote applies are now tagged `remote-sync`, and that tag is skipped deterministically.
3. **Another user's save overwrote in-progress typing.** It caused a refetch plus a full editor re-initialization from `initialContent`. Both now wait until the local edit is saved.
4. **Typing `[` or `]` jumped to another submission** (`QueueNavigator`).
5. **With pending changes, typing `j`/`k` was swallowed and `a`/`r` approved or rejected the selected change** (sidebar shortcuts in `TrackedChangesEditor`).
6. **Users were listed twice in presence** (identity mismatch).

Verified with real keystrokes in two visible windows: text, Enter and bold, one typist at a time, in both directions. Both editors matched, and a reload returned the same content.

### 14.2 Remaining limit, and the decision

The editor syncs by sending the whole document, and the last write wins. When two people type at the same time, one person's edit can be overwritten. That can't be tuned away. **Decision (2026-10-05): implement real merging with Yjs.**

### 14.3 Phase 5 design

- **Client:** `@lexical/react` `CollaborationPlugin` with `@lexical/yjs` (0.30.0, already installed), using a small custom provider.
- **Transport:** a dedicated socket `/api/ws/yjs/submissions/:id`, authorized by the existing `authorizeRoomConnection`, separate from `rooms.ts`. The existing relay keeps handling presence, cursors and workflow events.
- **Server:**
  - one in-memory `Y.Doc` per submission (single task, as already constrained);
  - each client update is applied to it and relayed to the others;
  - a joiner receives the current state;
  - awareness uses `y-protocols`.
- **Exactly one bootstrap.** The server picks the seeder for an empty document:
  - the first joiner seeds it from the saved content;
  - other joiners wait for the seed;
  - the seeder role passes on if that client disconnects.
  
  A server test covers two clients joining an empty room at once.
- **No whole-document writes after the initial load.** In collaborative mode, initial-content re-initialization, `applyRemote*`, and content refreshes are off. Refreshes update the changes sidebar only.
- **Tracked changes stay attributed to the right user.** Updates tagged `collaboration` never feed `TransactionManager`. A remote update arriving during a local edit settles that edit first.
- **Deleted-text markers are not duplicated.** They're created only by the deleting user's local edit. `applyDecorations` is a no-op for change IDs already in the document.
- **One owner for undo.**
- **Feature flag.** Collaborative mode is behind a flag served by the backend. The old full-document sync is off when it's on.
- **Known limit:** if everyone leaves before their last edit settles and saves, the next session starts from the last saved content. That's the same as today.

### 14.4 Order of work and estimate (≈3–5 days)

1. Server Yjs rooms, seeding rule and tests.
2. Provider plus `CollaborationPlugin` behind the flag; two people typing at once in plain text converge.
3. Make transactions and decorations Yjs-aware.
4. Undo.
5. Test matrix in two visible windows, 5+ runs each, with one browser using scripted input and the other real keys at the same clock time:
   - different paragraphs;
   - the same paragraph;
   - the same position;
   - Enter in a paragraph while the other user types in it;
   - bold while the other user types inside the word.

   **Pass:**
   - both editors are identical;
   - each insertion appears once, in place;
   - reloading shows the same content;
   - each change is credited to the user who made it;
   - today's one-typist tests still pass.

### 14.5 Implementation (2026-10-05)

**Flag.** `GET /api/config` returns `{"collabMode": "yjs" | "legacy"}` from `COLLAB_MODE` (default `legacy`). The review page fetches it once before showing the editor. In `legacy` mode the editor is unchanged.

**Collaborative mode (`yjs`):**
- **Sync.** `CollaborationPlugin` with the stock `y-websocket` provider and a fresh `Y.Doc` per editor mount (`frontend/src/components/editor/collab/YjsCollaboration.tsx`).
  - The seed is the newest content the seeding client has (its own saves don't refetch), else the fetched content, and never the placeholder text.
  - The editor is read-only until synced, and while the socket is down.
  - After 20 s offline the next connection starts from a fresh doc, so an old Yjs history can't merge a second copy into a room that was seeded again.
- **Off:** the init/re-init effects, `applyRemote*`, `realtime_content_update`/`content_updated`, typing and cursor messages, `HistoryPlugin` and transaction-level undo. The JSON room keeps presence and workflow events.
- **Change tracking.** Every committed update is classified by its tags:
  - `collaboration` is remote;
  - `history-merge` and tracked-change bookkeeping are baseline;
  - everything else is local, including `historic`, which now only comes from Yjs's UndoManager undoing the user's own edits.

  Only local updates start or extend a transaction. Remote updates don't end it.
  - The Y.Doc keeps deleted content (`gc: false`), and the user's own Yjs edits since the transaction began are recorded (`localEditTracker.ts`).
  - At settle time, the before-state is the current document without those edits (rebuilt headlessly) and the after-state is the current document. Both include everything merged from other users, so two people typing at once get one tracked change each, containing only their own text.
  - **Authorship across moves** (`provenance.ts`). `@lexical/yjs` syncs Enter, format changes, block type changes and paragraph merges as delete-and-copy: the copies are new Yjs items authored by whoever made the edit. Every transaction that deletes text and inserts the same text records each copy's original, so a character's author is the person who typed it, not who last moved it.
  - The before-state hides the user's own characters wherever they now are, and doesn't restore text they only moved.
  - Blocks the user created are kept, since others may have typed into them, then undone structurally: a split-off block is merged back into the previous one, and a replacement block gets the old block's type.
  - So the user who presses Enter gets a change with no added text, and the user typing across the split keeps all of their characters.
- **Caret** (`caretPreservation.ts`). After every remote update, while the editor has focus:
  - the caret is restored from a Yjs position anchored to the character on its left, so two people typing at the same position produce two contiguous blocks;
  - the text around the caret (32 characters before it, 8 after) is recorded first. `@lexical/yjs` syncs a paragraph or format split as delete plus re-insert, so after one the caret moves to the closest unique match of that text, in place or across the new paragraph break;
  - characters typed while the other user's split was in flight are left at the split point by Yjs. They are moved back with the caret in a normal local update, the only content change this makes; everything else is a selection-only update.
- **Saves.** Saves send `diffAgainstOldValue: true` so the server diffs each change against the user's own before-state, not another user's interleaved save.
- **Decorations.** `applyDecorations` never writes the tree: highlights and bookkeeping only.
  - Deletion markers are created only by their author's edit; they now carry `authorId` and a per-author color.
  - Approve/reject changes the tree only on the resolving client, and that syncs.
  - Remote status and undo events update the sidebar only.
- **Undo.** A Yjs UndoManager that captures only the local user's own edits takes Ctrl+Z/Ctrl+Y. CollaborationPlugin's own manager would also undo the seed, approve/reject and marker renames.
  - Undoing a saved change's text leaves its sidebar entry, which can be rejected.
- **Reject by context** (`collab/rejectRestore.ts`, added 2026-10-05). Before this, rejecting a cut or a paste changed nothing in the shared document, though the sidebar showed it as rejected. A cut makes no deletion marker, and a multi-paragraph paste never fits in one text node.
  - Each change record holds the whole document before and after the edit. A reject applies the patch from after to before onto the live document.
  - All three documents become unit sequences: one unit per block, per character (with its format and link) and per inline node. Lists and tables are one unit each.
  - Each hunk is found in the live document through a diff of after against live. A hunk whose units are all still present and contiguous is used as is.
  - Small edits around or inside a hunk are tolerated within thresholds, judged on the context still in place and the similarity of the text. Text that was moved or rewritten fails.
  - Only the top-level blocks that differ are replaced, in one synced update. Everyone's edits elsewhere stay.
  - A change with its own deletion markers in the document still takes the marker path.
  - Rejecting both halves of a move restores the original in either order. The server can cascade from the cut to the paste (when the pasted range covers the cut point); the client then reverts the cascaded change too, newest first, and stores the document again.
  - If the change can't be located (or has no rich text), nothing changes. The reviewer sees a toast and the change stays pending. A second reject marks it rejected without touching the document.
  - A batch reject sends only the changes it reverted to `/batch-status`, with the document after all the reverts (`revertedRichText`). The server stores that document, as the single-change PUT does.

**Verified locally:**
- headless convergence tests against the real server (`frontend/src/__integration__`);
- a two-browser run (two isolated Chrome contexts on the real app, dev server and production build) of the §14.4 matrix, plus reload, attribution, reject/approve, undo, outages, re-seeding and editor remounts.

**Known limits:**
- **Caret repair needs context.** The caret is repaired only while the editor has focus, and the search needs at least 3 characters of left context in the caret's block. A caret at the very start of a block keeps the Yjs position.
- **In-flight characters** are moved back only if they were typed in the last 5 s and sit right after the moved (deleted) text.
- **Saved content.** The persisted proposed content is the last saver's full document, as before (see the §14.3 known limit).
- **Reject by context.**
  - It replaces whole top-level blocks. An edit another user makes inside such a block at that moment is lost, and their caret moves.
  - A change inside a list or table replaces the whole list or table.

### 14.6 Results on the dev site (2026-10-05)

Deployed with `COLLAB_MODE=yjs` and tested with two real Chrome profiles on app.scrivenly.com:

| Scenario | Result |
|---|---|
| Second user joins: content seeded once, no duplicate | ✅ |
| Simultaneous typing, different paragraphs | ✅ Both strings intact and in place |
| Simultaneous typing, same paragraph | ✅ Both strings intact and in place |
| Enter in a paragraph while the other user types in it | ✅ after the cursor fix (both directions); before it, the typist's characters landed at the split point |
| Bold inside the line being typed | ✅ |
| Both typing at the same position | ✅ Contiguous blocks, no interleaving |
| Converged document survives a reload | ✅ |
| Change attribution: different paragraphs, same position, bold | ✅ One change per user, only their own text |
| Change attribution: concurrent Enter | ✅ after the provenance fix: the splitter is credited with the line break only, the typist with all their characters (both directions, checked against server-stored changes) |

**Phase 5 result:** every scenario in the §14.4 matrix passes on the dev site with real browsers. Locally, every scenario passes 10 of 10 runs in the two-browser harness (`tools/collab-e2e/`), checked against server-stored changes.

## 13. Estimates

| Phase | Effort |
|---|---|
| 0: Security fixes | ≈½ day |
| 1: Storage layer on S3 | 3–4 days |
| 2: Node server, rooms, bootstrap | 3–5 days |
| 3: Infrastructure and CI, including the dev sleep/wake setup | 3½–6 days |
| 4: Fresh setup and validation (Alex's development account) | 2–3 days |
| **Total to a validated development environment** | **≈ 2½–4 weeks** |
| 5: Real-time merging with Yjs (§14) | ≈3–5 days |
| Later: Rangers account setup | 1–2 days plus coordination |
