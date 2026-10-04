# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Comms Scribe is a collaborative content management platform hosted at scrivenly.com. It enables Ranger teams to submit content and helps the Comms Cadre and other reviewers process submissions through an advanced workflow system with real-time collaboration features.

## Architecture

This is a monorepo with two main components:

### Backend (Cloudflare Worker)
- **Runtime**: Cloudflare Workers with TypeScript
- **Router**: itty-router for HTTP routing
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2 for media files
- **Real-time**: Durable Objects for WebSocket connections
- **Authentication**: Google OAuth with session management
- **Location**: `backend/` directory

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
npm run dev           # Start local dev server on port 8787
npm run build         # Compile TypeScript
npm test              # Run Jest tests
npm run deploy        # Deploy to Cloudflare Workers
```

### Frontend
```bash
cd frontend
npm install                    # Install dependencies
npm run start                  # Start dev server (uses production API)
npm run start:local-backend    # Start dev server with local backend
npm run build                  # Build for production
npm test                       # Run tests
npm run deploy                 # Deploy to Cloudflare Pages
```

### Running Full Stack Locally
```bash
# Terminal 1 - Backend
cd backend && npm run dev

# Terminal 2 - Frontend
cd frontend && npm run start:local-backend
```

Frontend will be available at http://localhost:3000

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
   - Sessions stored in Cloudflare KV
   - Session ID passed via `Authorization: Bearer <token>` header
   - Auth wrappers in `backend/src/authWrappers.ts` provide middleware

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
   - Stored in R2 for versioning
   - Changes can be accepted/rejected
   - Tracked changes service in `backend/src/services/trackedChangesService.ts`

### Real-time Collaboration

WebSocket-based collaboration is implemented using Cloudflare Durable Objects:

1. **WebSocket Server** (`backend/src/services/websocketService.ts`):
   - `SubmissionWebSocketServer` is a Durable Object
   - Manages rooms for each submission
   - Tracks connected users and their cursors
   - Broadcasts updates to all room participants

2. **WebSocket Client** (`frontend/src/services/websocketService.ts`):
   - Connects to submission rooms
   - Sends/receives real-time updates
   - Handles cursor positions and user presence

3. **Message Types**:
   - `user_joined`, `user_left`: User presence
   - `cursor_position`: Real-time cursor tracking
   - `text_operation`: Collaborative text operations
   - `content_updated`: Content changes
   - `comment_added`, `approval_added`: Workflow updates
   - `heartbeat`/`heartbeat_response`: Connection health

### Data Caching

The system uses a multi-layer caching strategy (`backend/src/services/cacheService.ts`):

1. **Memory Cache**: In-worker memory with TTL
2. **KV Cache**: Cloudflare KV for distributed caching
3. **R2 Storage**: Long-term storage for large objects

Cache keys follow pattern: `{entity}:{id}` (e.g., `submission:abc123`)

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
Defined in `backend/wrangler.toml`:
- `PUBLIC_URL`: API base URL
- `FRONTEND_URL`: Frontend base URL
- `SESKey`: AWS SES key for emails

### Backend Bindings (Cloudflare)
- `D1`: Database binding
- `R2`: Storage binding
- `SUBMISSION_WEBSOCKET`: Durable Object binding

### Frontend Configuration
- `REACT_APP_API_URL`: Backend API URL (default: production, override for local dev)

## Database

Cloudflare D1 (SQLite) database stores:
- Users, groups, roles
- Content submissions, comments, approvals
- Blog posts, pages
- Council managers, comms cadre members

Migrations are TypeScript functions in `backend/src/migrations/` that run on application startup.

## Media Handling

Media files (`backend/src/services/mediaService.ts`):
- Uploaded to Cloudflare R2
- Automatic image resizing (thumbnail, medium, full)
- Supports images, videos, documents
- Access control via `isPublic` flag and `groupId`

## Notifications

Email notifications (`backend/src/services/notificationService.ts`):
- Sends via AWS SES
- User notification preferences stored per user
- Notification types: replies, group content, approvals

## Common Gotchas

1. **Sessions**: Session IDs must be passed in `Authorization` header, not cookies
2. **CORS**: Frontend and backend have explicit CORS configuration - both must allow the origin
3. **WebSocket Rooms**: Each submission has its own room identified by submission ID
4. **Approval Logic**: Complex logic deduplicates approvals by email - see `recomputeApprovalStatus()`
5. **Cloudflare Workers**: No file system access - use R2 for storage
6. **Durable Objects**: Stateful objects for WebSockets - have their own isolated state
7. **Cache Invalidation**: Always invalidate cache when updating entities

## Deployment

- **Backend**: Deployed to Cloudflare Workers via `wrangler deploy`
- **Frontend**: Static assets deployed to Cloudflare Pages
- **Production URL**: https://scrivenly.com
- **API URL**: https://scrivenly.com/api

Both deployments are managed via Wrangler CLI.
