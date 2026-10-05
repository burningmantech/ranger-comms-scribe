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
RUNS=10 node caret.js     # Enter / bold / same-position / one change per user
RUNS=5 node matrix.js     # full scenario matrix
node outage.js            # offline, reconnect, fresh doc after 20 s
node remount.js           # tab switch, moving between submissions
node undo2.js             # undo only affects your own edits
node legacy.js            # COLLAB_MODE unset: old behaviour unchanged (restart the backend without COLLAB_MODE)
```
