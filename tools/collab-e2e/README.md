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
```

To run against a second stack on other ports (e.g. a second checkout running in parallel), set
`E2E_APP_URL` and `E2E_API_URL` (defaults `http://localhost:3000` and `http://localhost:8080/api`);
`CHROME` overrides the browser path. `E2E_APP` / `E2E_API` still work as aliases.

```bash
E2E_APP_URL=http://localhost:3002 E2E_API_URL=http://localhost:8082/api node review-ui.js
```
