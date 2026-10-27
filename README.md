# Comms Scribe

Comms Scribe is where Ranger teams ask the Comms Cadre to send a message. A request is written, reviewed, edited and
approved in the app; approved messages go out to Ranger mailing lists or in the Black Rock Ranger News newsletter.

## What it does

- **Requests**: anyone signed in fills in the Comms request form (subject, body, audiences, Publish By, approvers) and
  follows their requests on the Requests page.
- **Review**: reviewers edit the message together in real time (Lexical with Yjs). Every edit is a tracked change that
  is accepted or rejected, with comment threads, history and an activity timeline.
- **Approval**: a request is approved when every gate is met:
  - the Council members on its approvers list approve (at least one must be listed);
  - every other listed approver approves;
  - a Comms Cadre member approves;
  - no edit is pending.

  Reviewers and the submitter can send reminders. A daily digest emails everyone with requests still waiting on them.
- **Sending**: the Comms Cadre (or an Admin) send approved requests to the mailing lists they manage. Ranger Announce is
  built in.
- **Newsletter**: requests for the newsletter become items in an edition. Editions are built, approved by the
  Communications Manager and sent from the app, with a public archive at `/newsletter`.
- **Comms Calendar**: replaces the Comms spreadsheet. It tracks each year's communications and what is due again,
  nudges team contacts, and imports the old sheet and its Google Docs.
- **Annual dates**: dates that recur every year, often relative to Labor Day. The app finds dates written in a request
  and links them to these, so the text can be updated when a date moves.
- **Notifications**: email through Amazon SES, plus an in-app notification bell.
- **Feedback**: when an Admin switches it on, a tab on every page sends a message, a screenshot and diagnostics to the
  Admins.

### Who can do what

Access is stored on each person's record and set by Admins on Admin → People:

- **Anyone signed in** submits requests and follows their own.
- **Comms Cadre** review requests, send announcements, and build and send the newsletter.
- **Council** (one council role each) approve requests; the Communications Manager also approves newsletter editions
  and can override approvals.
- **Admins** can do everything, including the People and Feedback admin pages.

Sign-in is with Google, or with an email address and password. See `docs/plans/2026-10-06-people-and-roles.md`.

## Repository layout

```
backend/     Node 24 + TypeScript API server (REST, WebSocket rooms, Yjs collaboration)
frontend/    React 18 + TypeScript single-page app (Create React App)
infra/       AWS CDK app: CloudFront, S3, ALB, ECS Fargate
bin/         Deploy scripts (dev-deploy, dev-up, dev-down, deploy, publish-frontend)
tools/       collab-e2e: two-browser regression scripts for the collaborative editor
docs/plans/  Design documents and plans
.github/     CI and deploys (GitHub Actions)
```

### Backend

One Node 24 process serves the REST API under `/api/*`, the WebSocket rooms under `/api/ws/*`, and `GET /healthz`.
There is no database: everything is a JSON or binary object in S3 (MinIO locally), with an in-memory cache in front.
Room state is held in memory too, so the service runs as a single task.

```
backend/src/
├── server.ts          # Entry point: config, startup work, HTTP server, shutdown
├── httpServer.ts      # REST adapter and WebSocket upgrades
├── index.ts           # Router and route mounting
├── config/env.ts      # Environment variables
├── handlers/          # Route handlers (auth, content submissions, tracked changes, newsletter, comms calendar, ...)
├── services/          # Business logic (access checks, cache, users, notifications, newsletter, ...)
├── realtime/          # rooms.ts (JSON relay rooms) and yjsRooms.ts (Yjs collaboration)
├── storage/           # ObjectStore interface with S3 and in-memory implementations
├── migrations/        # One-time startup migrations
├── utils/             # Email (SES), sessions, Google token check, Turnstile, ...
├── authWrappers.ts    # withAuth / withAdminCheck middleware
└── types.ts
```

See `backend/README.md` for configuration, the real-time protocols and Docker.

### Frontend

```
frontend/src/
├── App.tsx                 # Routes
├── pages/                  # Requests (MySubmissions), review page (TrackedChangesView), Comms Calendar,
│                           # newsletter editor and editions, public newsletter, request settings
├── components/
│   ├── CommsRequest.tsx    # The request form
│   ├── review/             # Review page panels: comments, history, send preview
│   ├── editor/             # Lexical editor, plugins, nodes; collab/ is the Yjs integration
│   ├── newsletter/         # Newsletter item and edition editing
│   ├── commsCalendar/      # Comms Calendar and annual dates modals
│   ├── dates/              # Date detection panel and bubbles
│   └── ...                 # Admin, People, Feedback, notifications, navigation
├── services/               # API and WebSocket clients (websocketService, yjsProvider, newsletterService, ...)
├── utils/                  # access.ts (permission checks), date detection, diagnostics, ...
└── types/
```

## Running it locally

You need Node 24 and Docker.

```bash
# Install
cd backend && npm install
cd ../frontend && npm install
cd ..

# Terminal 1: MinIO and the backend in Docker (API on http://localhost:8080/api)
DEV_BYPASS_AUTH=true docker compose up -d --build

# Terminal 2: the frontend against that backend (http://localhost:3000)
cd frontend && npm run start:local-backend
```

- **`DEV_BYPASS_AUTH=true`** makes the API treat any request as one of four fake dev users (local only). There's no
  dev sign-in screen, so to use one in the browser, run this in the console on `http://localhost:3000`, then reload:

  ```js
  // dev-admin-session (Admin), dev-user2-session (Comms Cadre), dev-council-session, dev-member-session
  const s = 'dev-admin-session';
  fetch('http://localhost:8080/api/auth/me', { headers: { Authorization: `Bearer ${s}` } }).then((r) => r.json())
    .then(({ user }) => { localStorage.setItem('sessionId', s); localStorage.setItem('user', JSON.stringify(user)); });
  ```

  The Admin pages don't accept these dev sessions.
- **A real account:** start the backend with `BOOTSTRAP_ADMIN_EMAILS=you@example.com`. That address becomes an Admin
  once it is proven, by Google sign-in or email verification.
- **Editing mode:** Docker runs the backend's default `legacy` editing mode. Dev, staging and production use Yjs; to
  match them, run the backend from source with `COLLAB_MODE=yjs` (see `backend/README.md`).
- **`docker compose down`** stops everything; `down -v` also deletes the local MinIO data.
- **Without Docker:** `STORE_DRIVER=memory` runs the backend from source with an in-memory store. See
  `backend/README.md` for that and for running against the compose MinIO.
- **Don't use plain `npm start`** in the frontend. On localhost it points at `https://scrivenly.com/api`, which is
  offline (see Deployment).

### Tests

```bash
cd backend && npm run typecheck && npm test
cd frontend && npm test
cd infra && npx tsc --noEmit && npx jest
```

After editor changes, also run the two-browser scripts in `tools/collab-e2e/`.

## Deployment

The service moved from Cloudflare to AWS. The Cloudflare deployment was deleted on 2026-10-05, so `scrivenly.com` is
offline until production is pointed at CloudFront.

| Environment | URL | Where | Deploys |
|---|---|---|---|
| Dev | https://app.scrivenly.com | Alex's AWS account (low-cost `dev` profile, can sleep) | `bin/dev-deploy` |
| Rangers staging | `staging.scrivenly.com` (placeholder) | Ranger tech team's account (`standard` profile) | GitHub Actions `cicd.yml` |
| Rangers production | `scrivenly.com` (placeholder) | Ranger tech team's account (`standard` profile) | GitHub Actions `deploy.yml` |

The Rangers environments are configured in `infra/config/` but not deployed yet. Every environment has the same shape:

- CloudFront serves the SPA from S3 and sends `/api/*` (including WebSockets) to an Application Load Balancer.
- The ALB fronts one Node container on ECS Fargate.

Setup, deploy, wake/sleep and cost notes are in `infra/README.md`. The plan and interfaces are in
`docs/plans/2026-10-04-aws-migration-prd.md` and `docs/plans/2026-10-04-aws-migration-contracts.md`.

## More documentation

- `CLAUDE.md`: architecture reference (workflow rules, access model, caching, real-time, configuration)
- `backend/README.md`: backend configuration and protocols
- `infra/README.md`: infrastructure and deploys
- `docs/plans/`: design documents (newsletter, annual dates, people and roles, AWS migration)

## Contributing

Open an issue or a pull request against `master`.
