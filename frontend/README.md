# Comms Scribe - Frontend

The Comms Scribe single-page app: React 18 and TypeScript, built with Create React App. It talks to the backend at
`<origin>/api` (REST) and `<origin>/api/ws/*` (WebSockets). See the top-level `README.md` for what the app does.

## Running it

```bash
npm install
npm run start:local-backend   # dev server on http://localhost:3000, API at http://localhost:8080/api
npm test                      # Jest + React Testing Library (add --watchman=false if watchman complains)
npm run build                 # production build in build/
```

- **Start the backend first:** `docker compose up -d --build` from the repository root (see the top-level README).
- **API address:** `src/config.ts` resolves it in this order:
  1. `REACT_APP_API_URL`, which `start:local-backend` sets;
  2. on localhost without it, `https://scrivenly.com/api`, which is offline until the production cutover, so plain
     `npm start` doesn't work right now;
  3. otherwise the page's own origin plus `/api`, the deployed setup where the SPA and API share an origin.
- **Gallery images:** `src/setupProxy.js` forwards `/api/gallery/*` from the dev server to the backend, so relative
  image URLs load locally.
- **Builds:** CRA fails a build with `CI=true` on any lint warning, so the CI and deploy scripts build with `CI=false`.

## Pages

| Route | Page | Who |
|---|---|---|
| `/requests` | Requests list (`pages/MySubmissions.tsx`) | anyone signed in |
| `/comms-request` | The request form (`components/CommsRequest.tsx`) | anyone signed in |
| `/tracked-changes/:submissionId` | Review page (`pages/TrackedChangesView.tsx`) | the request's submitter, approvers and reviewers |
| `/requests/settings` | Mailing lists and request templates (`pages/RequestSettings.tsx`) | Comms Cadre, Admins |
| `/comms-calendar` | Comms Calendar and Annual dates (`pages/CommsCalendar.tsx`) | Comms Cadre, Council, Admins |
| `/newsletter/editions`, `/newsletter/editions/:id` | Newsletter editions and editor | Comms Cadre, Communications Manager, Admins |
| `/admin` | People and Feedback (`components/Admin.tsx`) | Admins |
| `/newsletter`, `/newsletter/:number`, `/news/:slug` | Public newsletter archive and pages (`pages/PublicNewsletter.tsx`) | anyone |
| `/login`, `/verify-email`, `/reset-password` | Sign-in (Google or email and password) | anyone |

`ProtectedRoute` in `App.tsx` guards pages with an `allow={...}` predicate from `utils/access.ts`, the mirror of the
backend's `services/access.ts`. Check access through those predicates, never by comparing `userType` or `roles`. The
backend authorizes every request regardless.

## Layout

```
src/
├── App.tsx, index.tsx       # Routes; index.tsx installs diagnostics before rendering
├── config.ts                # API URL, Google client ID
├── pages/                   # One file per route (table above)
├── components/
│   ├── CommsRequest.tsx     # Request form
│   ├── TrackedChangesEditor.tsx, CollaborativeEditor.tsx
│   │                        # Review editor: tracked changes over a collaborative Lexical editor
│   ├── review/              # Review page panels: cards, comment threads, history, send preview
│   ├── editor/              # Lexical editor, nodes and plugins
│   │   └── collab/          # Yjs integration (YjsCollaboration.tsx, caret preservation, provenance, ...)
│   ├── newsletter/          # Newsletter item and edition editing (RichTextField.tsx binds Lexical to a form value)
│   ├── commsCalendar/       # Comms Calendar modals, including the Google Docs import
│   ├── dates/               # Date detection panel, date bubbles, Track all
│   ├── PeopleManagement.tsx, FeedbackAdmin.tsx, MailingListsManager.tsx, TemplateManagement.tsx
│   └── FeedbackCarrot.tsx, NotificationBell.tsx, Navbar.tsx, ...
├── services/                # websocketService (JSON rooms), yjsProvider and collabConfig (Yjs), newsletterService,
│                            # commsCalendarService, annualDatesService, trackedChangesService, userDirectory
├── contexts/ContentContext.tsx  # Submissions state and API calls
├── utils/                   # access.ts, reviewState.ts (live status/gates), dateDetection.ts, annualDates.ts,
│                            # diagnostics.ts and screenshot.ts (feedback), commsCalendarImport.ts, ...
└── types/
```

## Real-time editing

The review page edits the request together with everyone else on it. The mode comes from the backend's
`GET /api/config` (`COLLAB_MODE`, read by `services/collabConfig.ts`):

- **`yjs`**: merged editing through Lexical's `CollaborationPlugin` and the Yjs socket `/api/ws/yjs/submissions/:id`.
  Dev, staging and production use this mode.
- **`legacy`**: whole-document sync over the JSON room. This is the backend's default, locally too.
  To test Yjs locally, start the backend with `COLLAB_MODE=yjs docker compose up -d --build`.

Workflow updates (status, approval gates, comments, approvers) arrive over the JSON room
(`/api/ws/submissions/:id`, `services/websocketService.ts`) in either mode, and `utils/reviewState.ts` applies them.

Tests for the editor:

- **Yjs integration test:** `src/__integration__/yjsCollab.integration.test.ts` runs against a running backend and is
  skipped unless `YJS_E2E_API_URL` is set; its header has the commands.
- **Two-browser regression scripts:** `tools/collab-e2e/` at the repository root. Run them after editor changes.

## Technology

React 18, React Router v6, React Bootstrap, Lexical with `@lexical/yjs`, Yjs with `y-websocket`, React Hook Form
with Zod, and chrono-node for date detection. html2canvas-pro takes the feedback screenshot. Draft.js is only used to
import old Draft.js content.
