# Two-browser collaboration tests

Puppeteer scripts that drive two isolated Chrome sessions (as the dev-bypass users `dev-admin` and
`dev-user2`) against a **local** stack, to check real-time editing: convergence, cursor placement,
attribution, outages, remounts and undo. They found and verified the Phase 5 fixes
(`docs/plans/2026-10-04-aws-migration-prd.md` §14).

They need `DEV_BYPASS_AUTH=true`, so they only work locally, never against a deployed site.

```bash
# Terminal 1: backend in collaborative mode, in-memory store
cd backend && PORT=8080 STORE_DRIVER=memory DEV_BYPASS_AUTH=true COLLAB_MODE=yjs \
  GOOGLE_CLIENT_ID=x TURNSTILESECRET=x PUBLIC_URL=http://localhost:8080/api \
  FRONTEND_URL=http://localhost:3000 npm run dev

# Terminal 2: frontend
cd frontend && npm run start:local-backend

# Terminal 3: tests (uses your installed Google Chrome; see CHROME in lib.js)
cd tools/collab-e2e && npm install
RUNS=10 node caret.js     # Enter (both directions, inside typed text) / bold / same position / different
                          # paragraphs / single user: placement, plus attribution checked against the
                          # server-stored changes (LCS diff of oldValue -> newValue)
RUNS=5 node matrix.js     # full scenario matrix
node outage.js            # offline, reconnect, fresh doc after 20 s
node remount.js           # tab switch, moving between submissions
node undo2.js             # undo only affects your own edits
node legacy.js            # COLLAB_MODE unset: old behaviour unchanged (restart the backend without COLLAB_MODE)
node review-topbar.js     # review header: Finish review menu, conditions popover, view switch, Send, save
                          # status (incl. error + Retry), saving on unmount / page hide, queue pager, author
                          # view; works in both modes. STRICT=1 adds a reload after the Yjs room is dropped
node review-ui.js         # review sidebar: one "Moved" card for a cut + paste, reject (live for both users),
                          # Undo from the toast, accept, History, clicking a card scrolls to its text
node member.js            # a Member (dev-member): /requests loads with no redirect loop, New Request form
                          # (no early step errors, approver picked from the suggestions, no /api/admin/
                          # calls), types on its request and it saves, no Finish review menu; dev-user2
                          # rejects the edit and the member's card goes live. Fails on any console error.
                          # Needs the backend started as below (it seeds an approver as a bootstrap admin)
```

`member.js` stores an approved approver through the admin API, which needs a real admin session, so it
registers and verifies a bootstrap admin first. Start the backend for it with Cloudflare's always-pass
Turnstile test secret, the bootstrap address, and AWS keys that can't send email (the backend then
returns the verification and reset tokens instead of mailing them); it needs network access to
challenges.cloudflare.com:

```bash
cd backend && env -u AWS_PROFILE PORT=8080 STORE_DRIVER=memory DEV_BYPASS_AUTH=true COLLAB_MODE=yjs \
  GOOGLE_CLIENT_ID=x TURNSTILESECRET=1x0000000000000000000000000000000AA \
  BOOTSTRAP_ADMIN_EMAILS=e2e-admin@example.com AWS_ACCESS_KEY_ID=AKIAINVALIDLOCALE2E \
  AWS_SECRET_ACCESS_KEY=invalid AWS_EC2_METADATA_DISABLED=true PUBLIC_URL=http://localhost:8080/api \
  FRONTEND_URL=http://localhost:3000 npm run dev
```

The dev-bypass users (`backend/src/utils/devUsers.ts`) are picked by the session ID: `dev-admin-session`
(or any other) is `dev-admin` (Admin), `dev-user2-session` is `dev-user2` (CommsCadre) and
`dev-member-session` is `dev-member` (`member@localhost`, Member). `X-Dev-User: user2|member` (REST) and
`testUser=user2|member` (WebSocket) do the same. Names on review cards come from `/user/directory`, which
only lists stored users, so the dev users show as their ids.

To run against a second stack on other ports (e.g. a second checkout running in parallel), set
`E2E_APP_URL` and `E2E_API_URL` (defaults `http://localhost:3000` and `http://localhost:8080/api`);
`CHROME` overrides the browser path. `E2E_APP` / `E2E_API` still work as aliases.

```bash
E2E_APP_URL=http://localhost:3002 E2E_API_URL=http://localhost:8082/api node review-ui.js
```
