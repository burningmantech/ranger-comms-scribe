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
npm run deploy                 # Deploy to Cloudflare Pages
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

The system uses a multi-tier role-based access control:

1. **User Types** (in `backend/src/types.ts`):
   - `Public`: Unauthenticated users
   - `Member`: Authenticated users
   - `Lead`: Team leads
   - `CommsCadre`: Communications cadre reviewers
   - `CouncilManager`: Council managers with specific roles
   - `Admin`: Full system access

2. **Council Roles** (in `backend/src/types.ts`):
   - CommunicationsManager
   - IntakeManager
   - LogisticsManager
   - OperationsManager
   - PersonnelManager
   - DepartmentManager
   - DeputyDepartmentManager

3. **Authentication Flow**:
   - Google OAuth handled in `backend/src/handlers/auth.ts`
   - Sessions stored in the object store (`session/<id>`)
   - Session ID passed via `Authorization: Bearer <token>` header
   - Auth wrappers in `backend/src/authWrappers.ts` provide middleware
   - **First admin**: users whose email is in `BOOTSTRAP_ADMIN_EMAILS` become approved, verified Admins on
     register/login (`applyBootstrapAdmin()` in `userService.ts`). There is no hardcoded admin.

4. **Route Protection**:
   - Backend: Use `withAuth` or `withAdminAuth` wrappers
   - Frontend: Use `ProtectedRoute` component in `App.tsx`

### Content Submission Workflow

Content submissions go through a multi-stage approval process:

1. **Submission Creation** (`backend/src/handlers/contentSubmission.ts`)
   - User creates submission with title, content, media
   - Submission gets assigned required approvers
   - Status starts as `pending`

2. **Approval Process**:
   - Council Manager approval required
   - Comms Cadre approval required
   - All required approvers must approve
   - Status transitions: `pending` → `approved` → `published`
   - Approval logic in `recomputeApprovalStatus()` function

3. **Change Tracking** (`backend/src/handlers/trackedChanges.ts`):
   - All content changes are tracked as revisions
   - Stored in the object store for versioning
   - Changes can be accepted/rejected
   - Tracked changes service in `backend/src/services/trackedChangesService.ts`

### Real-time Collaboration

WebSocket rooms run in the same Node process as the REST API:

1. **Rooms** (`backend/src/realtime/rooms.ts`, replaces the old Durable Object):
   - Upgrades on `/api/ws/submissions/:id` and `/api/ws/documents/:id` (`?sessionId=`) are handled in
     `src/httpServer.ts`; `authorizeRoomConnection()` in `handlers/websocket.ts` checks the session and access
   - A plain relay: stamps the sender identity (`userId` = email, `userName`, `userEmail`) and a per-room `seq`
     on every relayed message; answers ping/heartbeat itself; sends a server `ping` every 30 s
   - Room keys are `submission:<id>` and `document:<id>`
   - REST handlers call `broadcastToSubmissionRoom()` / `broadcastToDocumentRoom()` directly
   - All state is in memory, so the service runs as a single task

2. **WebSocket Client** (`frontend/src/services/websocketService.ts`):
   - Connects to submission rooms
   - Sends/receives real-time updates
   - Handles cursor positions and user presence

3. **Message Types**:
   - `connected`, `room_state`, `user_joined`, `user_left`: User presence
   - `cursor_position`: Real-time cursor tracking
   - `realtime_content_update`: full Lexical state while typing (last write wins)
   - `content_updated`, `comment_added`, `approval_added`, `status_changed`: Workflow updates
   - `ping`/`pong`, `heartbeat`/`heartbeat_response`: Connection health

### Data Caching

`backend/src/services/cacheService.ts` keeps a module-level in-memory TTL map in front of `env.STORE`.
Listings (`__list__:<prefix>`) are cached in memory only; everything written with `putObject` also goes
to the store. Always invalidate when updating entities.

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
- `BOOTSTRAP_ADMIN_EMAILS` (CSV), `GOOGLE_CLIENT_ID`, `TURNSTILESECRET`
- `DEV_BYPASS_AUTH=true` for fake dev users (local only)
- `STORE_DRIVER=memory` to skip S3 (tests, quick local runs)

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
