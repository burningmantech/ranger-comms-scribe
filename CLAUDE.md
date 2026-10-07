# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Comms Scribe is a collaborative content management platform hosted at scrivenly.com. It enables Ranger teams to submit content and helps the Comms Cadre and other reviewers process submissions through an advanced workflow system with real-time collaboration features.

## Architecture

This is a monorepo with two main components:

### Backend (Node server)
- **Runtime**: Node 24, TypeScript, one process (`src/server.ts`) on `PORT` (default 8080)
- **Router**: itty-router v5, served through `@whatwg-node/server` (`src/httpServer.ts`)
- **Storage**: S3 through the `ObjectStore` interface (`env.STORE`, `src/storage/`); MinIO locally, or an in-memory store
- **Cache**: in-memory TTL map in front of the store (`src/services/cacheService.ts`)
- **Real-time**: `ws` WebSocket rooms in the same process (`src/realtime/rooms.ts`)
- **Email**: SES v2 with the default AWS credential chain (`src/utils/email.ts`)
- **Authentication**: Google sign-in and email/password, sessions stored in the object store
- **Container**: `backend/Dockerfile` (node:24-alpine), runs `node dist/server.js`
- **Location**: `backend/` directory

The service is being moved from Cloudflare to AWS (ECS Fargate behind CloudFront and an ALB).
See `docs/plans/2026-10-04-aws-migration-prd.md` and `docs/plans/2026-10-04-aws-migration-contracts.md`.

### Frontend (React SPA)
- **Framework**: React 18 with TypeScript
- **Editor**: Lexical rich text editor
- **Routing**: React Router v6
- **UI**: React Bootstrap
- **Real-time**: WebSocket client for collaboration
- **Forms**: React Hook Form with Zod validation
- **Location**: `frontend/` directory

## Development Commands

### Backend
```bash
cd backend
npm install           # Install dependencies
npm run dev           # tsx watch src/server.ts (needs env vars, see below)
npm run build         # esbuild bundle -> dist/server.js
npm start             # node dist/server.js
npm run typecheck     # tsc --noEmit
npm test              # Run Jest tests
```

Quick local run without S3 (data is lost on restart):
```bash
cd backend
STORE_DRIVER=memory DEV_BYPASS_AUTH=true PUBLIC_URL=http://localhost:8080/api \
  FRONTEND_URL=http://localhost:3000 GOOGLE_CLIENT_ID=x TURNSTILESECRET=x npm run dev
```

### Frontend
```bash
cd frontend
npm install                    # Install dependencies
npm run start                  # Start dev server (uses production API)
npm run start:local-backend    # Start dev server against http://localhost:8080/api
npm run build                  # Build for production
npm test                       # Run tests
# Deploys: ../bin/dev-deploy (Alex's dev account) or GitHub Actions (Rangers); see infra/README.md
```

### Running Full Stack Locally
```bash
# Terminal 1 - MinIO + backend in Docker (API on http://localhost:8080/api)
docker compose up -d --build          # add DEV_BYPASS_AUTH=true for fake dev users
# or: run MinIO from compose and the backend with `npm run dev` (S3_ENDPOINT=http://localhost:9000,
#     DATA_BUCKET=scribe-local, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY=minioadmin)

# Terminal 2 - Frontend
cd frontend && npm run start:local-backend
```

Frontend will be available at http://localhost:3000. `docker compose down -v` stops everything and deletes the MinIO data.

## Key Architecture Patterns

### Authentication & Authorization

Access is one model, stored on each person's record (`user/<email>`); see
`docs/plans/2026-10-06-people-and-roles.md`:

1. **Access fields** (`User` in `backend/src/types.ts`), independent of each other. Anyone signed in can submit
   requests and follow their own; there is no approval step:
   - `isAdmin`: the admin pages, overrides, everything
   - `commsCadre`: reviews requests, sends announcements, builds and sends the newsletter
   - `councilRole`: one of CommunicationsManager, IntakeManager, LogisticsManager, OperationsManager,
     PersonnelManager, DepartmentManager, DeputyDepartmentManager, or null (a person holds at most one). Any council
     role satisfies a request's Council gate; the Communications Manager also approves newsletter editions and can
     override approvals. Older records' `councilRoles` list is read as its first role and dropped on save
   - `userType` and `roles` are **derived** from these on every `saveUser` (never set them directly); one person can
     be Comms Cadre and Communications Manager

2. **Checks**: always through `backend/src/services/access.ts` (`isAdmin`, `isCommsCadre`, `isCouncil`,
   `hasCouncilRole`, `isCommsManager`, `isReviewer`) and its frontend mirror `frontend/src/utils/access.ts`. Never
   compare `userType` or `roles` in a handler or component. Lists of who holds a role come from people records
   (`services/peopleService.ts`); `GET /council/members` and `GET /comms-cadre` are read-only views of them
3. **Changing access**: only `PUT /api/admin/people/:id/access` (Admin → People). It refuses removing your own Admin
   or the last Admin. A one-time startup migration (`migrations/peopleAccess.ts`, marker
   `migrations/people-access-v1`) moved access from the old type, roles, council lists and Comms Cadre list

4. **Authentication Flow**:
   - Google OAuth handled in `backend/src/handlers/auth.ts`
   - Sessions stored in the object store (`session/<id>`)
   - Session ID passed via `Authorization: Bearer <token>` header
   - Auth wrappers in `backend/src/authWrappers.ts` provide middleware (`withAuth`, `withAdminCheck`)
   - **First admin**: users whose email is in `BOOTSTRAP_ADMIN_EMAILS` become verified Admins on
     register/login (`applyBootstrapAdmin()` in `userService.ts`); a verified bootstrap address is always Admin.
     There is no hardcoded admin
   - The frontend stores `/auth/me`'s record (no password hash) as the signed-in user (`utils/userActions.ts`)

5. **Route Protection**:
   - Backend: `withAuth` or `withAdminCheck`, then `access.ts` checks
   - Frontend: `ProtectedRoute` in `App.tsx` (`allow={...}` with an `access.ts` predicate)

### Content Submission Workflow

Content submissions go through a multi-stage approval process:

1. **Submission Creation** (`backend/src/handlers/contentSubmission.ts`)
   - User creates submission with title, content, media
   - Submission gets assigned required approvers
   - Status starts as `draft` or `submitted`

2. **Approval Process** (gates in `computeApprovalGates()`; `recomputeApprovalStatus()` approves when all are met):
   - **Approvers list** (`requiredApprovers`, one list): the submitter fills it on the form (or ticks "I don't know");
     afterwards only Admins, the Comms Cadre and Council change it, through `PUT /submissions/:id/approvers` (the
     general PUT ignores it). People added are asked by email (via `COMMS_EMAIL_OVERRIDE` on dev) and in the app, and
     an approved request whose new approvers haven't approved goes back to `in_review` (an override still holds)
   - **Council**: the council members on the list. At least one must be listed (the Comms Cadre pick one when the
     submitter didn't, or "Add all of Council" for a message from all of Council) and every one of them must approve.
     A council member who isn't listed doesn't count. Council membership is the stored record's, else the role on
     their approval
   - **Other approvers**: everyone else on the list must approve (met when there are none)
   - **Comms Cadre**: any Comms Cadre approval (a listed council member who is also Comms Cadre meets both)
   - **Edits resolved**: no pending tracked change
   - Status transitions: `submitted`/`in_review` → `approved` → `sent`
   - **Status follows the tracked changes** (`syncSubmissionStatus()` in `contentSubmission.ts`, called last
     by every tracked-change handler: create, batch create, accept/reject incl. cascade, batch status, undo,
     delete). The submission becomes `approved` once all gates are met, including when the last pending change
     is resolved after the approvals. An `approved` submission with a pending change (a new edit, or an undo)
     drops back to `in_review` (approved content changed; `finalApprovalDate` and an override approval are
     cleared). `sent` never changes. Only a pending change demotes (a changed vote does not). After every such
     operation the room gets `status_changed` (status changed) or `approval_state`, both with `approvalGates`;
     `approval_added` carries them too. The review page applies these live (`frontend/src/utils/reviewState.ts`)

3. **Change Tracking** (`backend/src/handlers/trackedChanges.ts`):
   - All content changes are tracked as revisions
   - Stored in the object store for versioning
   - Changes can be accepted/rejected
   - Tracked changes service in `backend/src/services/trackedChangesService.ts`

4. **Comments**:
   - Comment threads can be resolved and reopened (`POST /content/submissions/:id/comments/:commentId/resolve`
     with `{resolved}`; any user who can view the submission; stores `resolvedBy`/`resolvedByName`/`resolvedAt`,
     broadcasts `comment_resolved`). The review sidebar moves resolved threads to History, with Reopen
   - `PUT /content/submissions/:id` ignores `comments` and `approvals` (their own endpoints own them)

### Newsletter ("Black Rock Ranger News")

See `docs/plans/2026-10-06-newsletter-design.md`.

- Requests with the `newsletter` audience carry a newsletter item (`newsletter`), `keyDates` and `writingHelp`;
  read audiences through `audienceKeys()` (`backend/src/utils/audiences.ts`), which also understands the older
  label strings in `formFields.audience`. PUT `/submissions/:id` ignores these fields; use
  `PATCH /submissions/:id/newsletter`
- Editions (`newsletter_editions/<id>`) are built, approved and sent through `/api/newsletter`
  (`services/newsletterService.ts`); the email, preview and web page all come from `services/newsletterEmail.ts`
- Every save bumps the edition's `version`; approvals only count for the version they were given on, and a save
  must name the version it edited (409 otherwise)
- Public pages (no session) are under `/api/public` and the SPA routes `/newsletter`, `/newsletter/:n`, `/news/:slug`
- A newsletter-only request can't be sent on its own (`send-email` returns 409): it goes out in an edition
- In the frontend, use `components/newsletter/RichTextField.tsx` for a Lexical editor bound to a form value

### Real-time Collaboration

WebSocket rooms (JSON relay and Yjs) run in the same Node process as the REST API:

1. **Rooms** (`backend/src/realtime/rooms.ts`, replaces the old Durable Object):
   - Upgrades on `/api/ws/submissions/:id` and `/api/ws/documents/:id` (`?sessionId=`) are handled in
     `src/httpServer.ts`; `authorizeRoomConnection()` in `handlers/websocket.ts` checks the session and access
   - A plain relay: stamps the sender identity (`userId` = email, `userName`, `userEmail`) and a per-room `seq`
     on every relayed message; answers ping/heartbeat itself; sends a server `ping` every 30 s
   - Room keys are `submission:<id>` and `document:<id>`
   - REST handlers call `broadcastToSubmissionRoom()` / `broadcastToDocumentRoom()` directly
   - All state is in memory, so the service runs as a single task

2. **Yjs collaboration rooms** (`backend/src/realtime/yjsRooms.ts`, contracts §9):
   - Upgrades on `/api/ws/yjs/submissions/:id` (`?sessionId=`), routed in `src/httpServer.ts` and authorized
     with the same `authorizeRoomConnection()`; a separate path from the JSON rooms above
   - Standard y-websocket binary protocol (sync 0, awareness 1, query awareness 3) via `y-protocols`, so the
     stock `y-websocket` `WebsocketProvider` (verified with 3.1.0) is the client
   - One in-memory `Y.Doc` per submission; updates are applied and relayed, awareness is relayed (echoed to
     the sender too) and removed on disconnect; the room is destroyed 30 s after the last client leaves
   - **Seeding rule:** while the doc is empty only the first client (seeder) gets its sync step 1 answered;
     others are held (no doc state in or out) until the seed lands, then get step 2 with the full state.
     If the seeder leaves before seeding, the next held client is promoted. This keeps Lexical's
     `CollaborationPlugin` from bootstrapping saved content twice
   - Keepalive uses WebSocket protocol pings (never JSON frames on this socket)

3. **WebSocket Client** (`frontend/src/services/websocketService.ts`):
   - Connects to submission rooms
   - Sends/receives real-time updates
   - Handles cursor positions and user presence

4. **Message Types** (JSON rooms):
   - `connected`, `room_state`, `user_joined`, `user_left`: User presence
   - `cursor_position`: Real-time cursor tracking
   - `realtime_content_update`: full Lexical state while typing (last write wins)
   - `content_updated`, `comment_added`, `comment_resolved`, `approval_added`, `status_changed`, `approval_state`:
     Workflow updates
   - `ping`/`pong`, `heartbeat`/`heartbeat_response`: Connection health

### Data Caching

`backend/src/services/cacheService.ts` keeps a module-level in-memory TTL map in front of `env.STORE`.
Listings (`__list__:<prefix>`) are cached in memory only; everything written with `putObject` also goes
to the store. Always invalidate when updating entities. A store read that a write or invalidation of the
same key overtakes is returned but not cached. Never `putObject` a copy derived from reads (e.g. a
`change:` shadow or an array of all changes): a copy built from a read that raced a write keeps the old
value in the store and hides the write. Tracked changes are read straight from their own keys.

### Service Layer Pattern

Backend follows a service-oriented architecture:

- **Handlers** (`backend/src/handlers/`): HTTP route handlers
- **Services** (`backend/src/services/`): Business logic layer
- **Utils** (`backend/src/utils/`): Shared utilities

Services are stateless and accept `env` parameter for accessing bindings.

## Testing

### Backend Tests
- Test files in `backend/test/` directory
- Run with `npm test` in backend directory
- Uses Jest with ts-jest
- Tests are named `*.test.ts`

### Frontend Tests
- Uses React Testing Library
- Run with `npm test` in frontend directory

## Important Types

Key TypeScript types are defined in:
- `backend/src/types.ts`: Shared backend types
- `frontend/src/types.ts`: Frontend-specific types

Core entities:
- `User`: User account with roles and groups
- `ContentSubmission`: Content submissions with approval workflow
- `ContentApproval`: Approval decisions
- `ContentComment`: Comments on submissions
- `ContentChange`: Tracked changes/revisions
- `Page`: Static pages
- `BlogPost`: Blog posts
- `MediaItem`: Uploaded media files
- `Group`: User groups for access control

## Lexical Editor

The frontend uses Lexical editor framework (`frontend/src/components/editor/`):

- Rich text editing with tables, images, formatting
- Custom plugins for tracked changes
- Collaborative editing support
- Export to HTML

When working with the editor:
- Editor state is immutable - use update commands
- Custom nodes extend base Lexical nodes
- Plugins handle specific features
- See `CollaborativeEditor.tsx` and `TrackedChangesEditor.tsx`

## Environment & Configuration

### Backend Environment Variables
Read once at boot by `backend/src/config/env.ts` (full list in the contracts doc, section 3):
- `PORT` (default 8080), `PUBLIC_URL`, `FRONTEND_URL`, `CORS_ORIGINS` (CSV)
- `DATA_BUCKET`, `S3_ENDPOINT` (MinIO), `AWS_REGION`
- `SES_REGION`, `EMAIL_FROM`, `EMAIL_BCC` (CSV)
- `ANNOUNCE_EMAIL_TO` (unset disables announcements), `NUDGE_EMAIL_OVERRIDE` (dev/staging: every Comms Calendar nudge goes here)
- `COMMS_EMAIL_OVERRIDE` (dev/staging): announcement sends to mailing lists and approval reminders go only here, with
  `[for <real recipients>] ` before the subject (`commsRecipients()` in `utils/email.ts`); sign-in emails are unaffected
- `BOOTSTRAP_ADMIN_EMAILS` (CSV), `GOOGLE_CLIENT_ID`, `TURNSTILESECRET`
- `DEV_BYPASS_AUTH=true` for fake dev users (local only)
- `STORE_DRIVER=memory` to skip S3 (tests, quick local runs); `STORE_LATENCY_MS=<n>` adds random S3-like delays

AWS credentials come from the default credential chain (task role on ECS; a profile or the MinIO keys locally).

### Frontend Configuration
- `REACT_APP_API_URL`: Backend API URL (default: production, override for local dev)

## Data Storage

There is no database. Everything (users, groups, sessions, submissions, comments, approvals, tracked
changes, blog posts, pages, media) is JSON or binary objects in the object store, keyed by prefix
(e.g. `user/<email>`, `content_submissions/<id>`, `gallery/<file>`).

## Media Handling

Media files (`backend/src/services/mediaService.ts`):
- Uploaded to the object store (`gallery/`, `gallery/thumbnails/`, `gallery/medium/`)
- URLs are stored relative to the site origin (`/api/gallery/<file>`); in local dev `frontend/src/setupProxy.js`
  forwards them from the CRA dev server to the backend
- Automatic image resizing (thumbnail, medium, full)
- Supports images, videos, documents
- Access control via `isPublic` flag and `groupId`

## Comms Calendar

Replaces the Comms "Announce Messages and Comms Queue" spreadsheet (`/comms-calendar`,
`backend/src/handlers/commsCalendar.ts`, `services/commsCalendarService.ts`):
- One `CommsCalendarEntry` per communication at `comms_calendar/<id>`; cycles run Sep→Aug and are labelled by
  the event they lead up to (`cycleLabel`: the cycle starting Sep 2026 is the "2027 event"). Next year's
  version of an entry is a new entry whose `carriedFromId` points at last year's
- **Coming up** lists this cycle's planned entries due within a window and not sent yet (`kind: 'planned'`), and
  last year's items due again that no entry continues yet and that aren't `notRepeating` (`kind: 'anniversary'`);
  **Nudge** emails the team contacts (Reply-To the sender) and is logged on the entry
- A sent announcement (send-email, or PUT to `sent`) or a sent newsletter edition (`sendEdition`, each
  section's request) creates/updates entry `sub-<submissionId>` from the request's approved subject, Publish By,
  audiences and Owner, with `newsletterSentIn` for editions; the date sent is the first time it went out. The
  sync never fails the send
- Comms Cadre, Admins and the Council Communications Manager edit; other Council members read only
- CSV import is parsed in the browser (`frontend/src/utils/commsCalendarImport.ts`); same subject + cycle is
  skipped as a duplicate
- **Import messages** (`DocsImportModal.tsx`): each sheet row's Google Doc becomes a sent Scribe request
  (`importedFrom`: the doc; Subject and Body of the Comms request form, formatting kept, images copied to the
  gallery) via `POST /api/comms-calendar/:id/message`. It goes on the entry for the cycle it went out in ("Date to
  publish"): this entry, or last year's, which this one continues (made when missing); re-importing updates the
  same request. Google won't let Scribe read the docs, so Scribe opens the sheet ("htmlview") in a tab of the same
  browser and a helper script there (`sheetHelperScript`) posts the docs, images inlined as data: URLs, back to
  the Scribe tab. The HTML becomes Lexical in an off-screen request editor (the paste path)
- An entry's subject opens its Scribe request, or last year's (tagged "Last year's"); "Doc" is the Google Doc
- **New request** (Coming up, All entries for this year's entries, and "New request from this" on a sent request's
  page) opens `/comms-request?from=<request>&entry=<entry>&publishBy=<date>`: the form starts from that message
  (subject, body with images, newsletter item, key dates, linked dates, details) without touching the saved draft.
  The created request records `copiedFrom`; `linkCopyToCalendar` puts it on this year's entry (the one asked for,
  else the one continuing the message's entry, else a new entry continuing it), so its send updates that entry

## Mailing lists, reminders and admin screens

- **Mailing lists** (`MailingList` at `mailing_lists/<id>`, `services/mailingListService.ts`, `/api/mailing-lists`)
  are where approved announcements are sent. Ranger Announce (id `announce`, address from `ANNOUNCE_EMAIL_TO`) is
  built in; the rest (e.g. `ranger-<x>-cadre@burningman.org`) are managed by the Comms Cadre and Admins on
  Requests → Lists & templates (`/requests/settings`, which also has the request templates). Each list names the
  audiences it serves; `suggestedListIds()` ticks those in the Send view (else Announce), the sender can change
  the choice, and `send-email` records `submission.sentTo`
- **Reminders**: `POST /api/content/submissions/:id/remind {target}` (a lowercased approver email, `council` or
  `commsCadre`) from the Remind buttons in the approval conditions popover. Reviewers and the submitter, while
  `submitted`/`in_review`; once per target per 20 hours; email plus an in-app notification, not to the sender;
  logged in `submission.reminders`
- **Admin** is People (`PeopleManagement.tsx`: access, each person's feedback tab, plus Add people
  (`/admin/bulk-create-users`, then the access PUT for a role)) and Feedback (`FeedbackAdmin.tsx`, below). The old
  Groups, Bulk add, Reminders and Templates tabs are gone. Admin routes don't take the `DEV_BYPASS_AUTH` sessions

## Annual dates

Things that happen every year, so requests can follow them (`docs/plans/2026-10-06-annual-dates-design.md`):
- One `AnnualDate` per entry at `annual_dates/<id>` (`/api/annual-dates`). Its rule is a fixed date, or
  `offsetDays` from Labor Day (first Monday of September; the Burn is Labor Day - 2). It also has times
  (`HH:mm`), `durationDays`, and per-year `overrides`.
- Pure logic is in `backend/src/utils/annualDates.ts`, mirrored in `frontend/src/utils/annualDates.ts`.
- The occurrence year is the calendar year, never the Comms Calendar cycle.
- `frontend/src/utils/dateDetection.ts` (chrono-node, strict, and a month name or numeric date must be written)
  finds dates in the body and blurb text (`blockTextFromLexical`, a line break per block and list item).
- `components/dates/DatesPanel.tsx` (on the request form and the review page) groups mentions of the same date
  (`dateGroups.ts`), shows the words around each, and tracks, links and updates every mention at once.
- On the review page `DateBubbles.tsx` overlays the editor: each date is underlined in its status color with a
  bubble in the margin that opens its row; clicking a mention in the panel scrolls to it. Outside the document,
  so tracked changes and Yjs never see it
- A new annual date defaults to a Labor Day rule. **Track all** adds and links every unlinked date at once
  (`TrackAllModal.tsx`). On the Comms Calendar, entries from a Scribe request have a **Dates** button
  (`RequestDatesModal.tsx`; Coming up compares against the date it's due again); text updates there link to the
  review page. An entry can also hold its message's text (`documentText`, pasted in the entry form or imported
  from its Google Doc) with its own `dateLinks`, so Dates works for messages that never went through Scribe
- A request's `dateLinks` are saved by `PUT /content/submissions/:id/date-links` (the request's editors or Comms
  Calendar editors); PUT `/submissions/:id` ignores them. A key date's `annualDateId` goes through the newsletter PATCH.
- Links never change text by themselves. **Update text** rewrites the date in its written style: a
  tracked change in the body, or an unsaved blurb edit.
- Anyone signed in adds entries. Comms Calendar editors (and the entry's creator) change and delete them.
  The table is the Annual dates tab on `/comms-calendar`.

## Feedback tab

A tab on the right edge of every page (`components/FeedbackCarrot.tsx`) opens a small panel to say what happened:
- **Who sees it**: the person's `feedbackEnabled` (true/false) if set, else the global switch at `settings/feedback`
  (off by default). `GET /api/feedback/config` answers for the signed-in person; the tab re-reads it on focus.
  Admins set the global switch on Admin → Feedback (`PUT /api/admin/feedback/settings`) and a person's on People
  (`PUT /api/admin/people/:id/feedback {enabled: true|false|null}`; not access, so not the access PUT)
- **What's sent**: the message, a JPEG of the window (`utils/screenshot.ts`, html2canvas-pro, loaded on open; the
  tab is `data-feedback-ignore`), and `collectDiagnostics()` from `utils/diagnostics.ts`, installed in `index.tsx`
  before render: ring buffers of fetch/XHR calls (status, timing, the calling stack, failed response bodies),
  console, uncaught errors and rejections with stacks, navigation and clicks (never typed text), WebSockets,
  slow/failed resources, browser and page. Session IDs are stripped from URLs and scrubbed from the result; no
  request headers or bodies. Send with `rawFetch` so the send isn't logged
- `POST /api/feedback` (`services/feedbackService.ts`): 403 when off for the person, 20 per hour, stores
  `feedback/<id>` and `feedback_screenshots/<id>.jpg`, then emails every Admin (Reply-To the sender, screenshot
  inline, diagnostics JSON attached). An email failure is recorded on the report, never fails the send
- Admin → Feedback (`/admin?tab=feedback&id=<id>`, linked from the email) lists reports, shows one with its
  screenshot, network, errors and steps, and marks it handled with notes

## Notifications

Email notifications (`backend/src/services/notificationService.ts`):
- Sends via AWS SES v2 (`EMAIL_FROM`, `EMAIL_BCC`, `SES_REGION`)
- User notification preferences stored per user
- Notification types: replies, group content, approvals

## Common Gotchas

1. **Sessions**: Session IDs must be passed in `Authorization` header, not cookies
2. **CORS**: In AWS the SPA and API share one origin; locally the backend allows `CORS_ORIGINS`
   (default `FRONTEND_URL` plus `http://localhost:3000`)
3. **WebSocket Rooms**: Each submission has its own room, keyed `submission:<id>`
4. **Approval Logic**: Complex logic deduplicates approvals by email - see `recomputeApprovalStatus()`
5. **Storage**: Code never imports a concrete store; use `env.STORE` (or the cacheService helpers)
6. **In-memory state**: Rooms and the cache live in process memory. One task only; a restart drops
   connections (clients reconnect) and empties the cache (data is in S3)
7. **Cache Invalidation**: Always invalidate cache when updating entities
8. **Startup work** (`initializeApp`) runs once at boot in `server.ts`, never per request
9. **Client IP**: use `getClientIp()` (CloudFront-Viewer-Address, then X-Forwarded-For)

## Deployment

- **Backend**: container image from `backend/Dockerfile`, run on ECS Fargate behind CloudFront and an ALB
  (infrastructure and CI are added in Phase 3 of the migration)
- **Health check**: `GET /healthz` returns `{"ok":true}`
- **Frontend**: static build, served from the same origin as the API
- **Production URL**: https://scrivenly.com
- **API URL**: https://scrivenly.com/api
