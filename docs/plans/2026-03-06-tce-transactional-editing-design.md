# TCE Transactional Editing Design

## Overview

Redesign the Tracked Changes Editor (TCE) to work on a transactional basis. Each edit is a discrete, reversible unit. Users can undo their own changes or reviewers can reject changes, with the editor smoothly reverting as if that change never happened. Autosave is transparent and background. Layout never shifts due to tracked-change decorations.

## Transaction Model

### Transaction Lifecycle

A transaction is a unit of editing work bounded by natural pauses. It captures everything the user changes between starting to type and pausing for ~2-3 seconds.

**States:** `active` → `settled` → `saved`

- **Active**: User is currently typing. Keystrokes are tracked, decorations render in real time (additions highlighted, deletions shown as strikethrough). Ctrl+Z works at the keystroke level within the active transaction.
- **Settled**: User paused for ~2-3 seconds. The transaction is "closed" — its diff is finalized and it becomes a discrete unit in the session's undo stack. Background autosave picks it up.
- **Saved**: The transaction has been persisted to the server. Visually identical to settled — no change in appearance. The subtle cloud icon briefly animates to confirm.

### Per-Transaction Data

- Snapshot of affected text regions before the transaction started
- The Lexical JSON state before and after
- Field identifier (content, title, audience, etc.)
- User ID and timestamp
- Region map: character ranges this transaction touched (for cascade rejection)

### Session Undo Stack

An ordered list of the current user's settled/saved transactions in this session. Ctrl+Z pops the most recent, fully reversing it (deleting the tracked change if already saved).

## Visual Stability & Decoration Rendering

### Core Principle

The document's physical layout never shifts due to tracked-change decorations. What the user sees while editing is exactly what they see after save.

### Additions

- Rendered via CSS Custom Highlight API (current approach) — zero DOM impact
- Highlighted in the author's assigned color in real time as they type
- No change on save — the highlight was already there

### Deletions

- Text is struck through in place using the author's color, but remains in the document flow
- Paragraph breaks between deleted paragraphs stay visually intact — the lines are struck through but whitespace is preserved
- `DeletedTextNode` continues to render with `getTextContent() = ''` so it doesn't affect word count or search
- Decorations are applied incrementally — only new changes get new decorations, existing ones are left untouched. No strip-and-rebuild cycle.

### On Acceptance

- Deleted text and its decorations are removed from the DOM
- Whitespace collapses to a single empty line between adjacent paragraphs
- Smooth CSS transition (opacity fade-out, then height collapse) so the user sees a gentle visual change rather than a sudden jump

### On Rejection (Cascade-Aware)

- The rejected change's additions are removed and its deletions are restored
- Any subsequent transactions that overlap the same text region are also reversed
- Those dependent transactions are deleted entirely (no history trace)
- The document returns to the state before the earliest change in the cascade chain

## Autosave & Persistence

### Background Save Flow

When a transaction settles (user pauses ~2-3 seconds), autosave kicks in silently:

1. Transaction moves from `active` → `settled`
2. Autosave serializes the transaction and sends it to the backend via the existing `POST /tracked-changes/submission/{id}` endpoint
3. On success: transaction moves to `saved`, cloud icon briefly animates
4. On failure: retry once after 2 seconds. If still failing, cloud icon shows warning state. Transaction stays in `settled` and retries on next opportunity.
5. No visual change to the document at any point during this flow

### Save-on-Close Flow

When the user navigates away or closes the tab with unsettled/unsaved transactions:

1. `beforeunload` event fires
2. If an active transaction exists, settle it immediately
3. If any settled-but-unsaved transactions exist:
   - Show a minimal modal: "Saving your work..." with a spinner
   - Fire save requests for all pending transactions
   - On success: allow navigation
   - On failure: persist to localStorage/IndexedDB, allow navigation
4. On return to editor: check localStorage for orphaned transactions, push them to server, then clean up local storage

### Cloud Icon States

- **Static cloud**: all saved
- **Animated cloud** (brief pulse): save in progress
- **Cloud with checkmark** (fades after 2s): just saved
- **Cloud with warning dot**: save failed, will retry

No countdown timer, no "Saving..." text, no status bar. Just the icon.

## Undo System (Ctrl+Z Across Transactions)

### Session Transaction Stack

Each user's session maintains an ordered stack of their own transactions (settled and saved). This is separate from Lexical's built-in `HistoryPlugin`.

### Behavior

- **While a transaction is active** (user is typing): Ctrl+Z is keystroke-level, handled by Lexical's native history. Normal undo behavior.
- **When no transaction is active** (user is idle): Ctrl+Z pops the most recent transaction from the session stack and fully reverses it:
  - Editor state reverts to the pre-transaction snapshot
  - If the transaction was already saved to the server, a delete request fires to remove the tracked change from the backend
  - Decorations for that transaction disappear
  - Ctrl+Y (redo) pushes it back — re-applies the transaction and re-saves it
  - WebSocket event broadcast so all connected users see the reversal immediately

### Scope Boundaries

- Only the current user's transactions from the current session are on the stack
- Other users' changes and changes from prior sessions are never affected by Ctrl+Z
- If another user has edited the same region since your transaction, Ctrl+Z uses the same cascade logic as rejection — it reverses your change and any dependent changes on that region. The other user's change is deleted from the backend as well.

### Stack Management

- Starting a new transaction clears the redo stack (same as any standard undo system)
- The stack is ephemeral — cleared when the session ends
- Maximum stack depth of ~50 transactions to bound memory usage

## Cascade Rejection & Region Tracking

### Region Map

Each transaction records the character ranges it touched within each field. For example: `{ field: "content", ranges: [{start: 142, end: 189}] }`. These ranges are stored alongside the tracked change on the backend.

### Rejection Flow

When a reviewer rejects a change (or editor undoes via Ctrl+Z):

1. Identify the rejected transaction's affected regions
2. Query all subsequent pending transactions for overlapping regions
3. Build a dependency chain — all transactions that touched any part of the same text
4. Reverse the entire chain in reverse chronological order:
   - Each transaction in the chain is deleted (no history trace)
   - Editor state is restored to pre-chain state for those regions
   - Delete requests sent to backend for each removed transaction
   - WebSocket events broadcast so all users see the reversals immediately
5. Non-overlapping transactions from other regions are untouched

### Edge Cases

- **Partial overlap** (a later transaction touches some of the same text plus new text): the entire later transaction is included in the cascade. No partial reversals — keeps things predictable.
- **Accepted changes are immutable** — they've already been applied to the canonical document. Rejection cascade stops at any accepted change in the chain.
- **Cross-user cascade**: if the cascade would affect another user's transactions, those are also removed. The other user sees the reversal via WebSocket and their local undo stack is updated accordingly.
- **Region tracking updates**: when a transaction is reversed, all subsequent transactions' region maps are recalculated to account for shifted character positions (similar to OT index transformation).

## Integration with Existing Systems

### WebSocket Events (New)

Three new message types added to the existing WebSocket protocol:

- `transaction_settled` — Broadcast when a user's transaction settles. Contains the tracked change data so other users' editors render the decorations immediately.
- `transaction_undone` — Broadcast when a transaction is reversed (Ctrl+Z or reviewer rejection). Contains the IDs of all transactions removed (including cascade). Other users strip those decorations and update their local state.
- `transaction_redone` — Broadcast when a Ctrl+Y re-applies a previously undone transaction.

### Backend Changes

- New endpoint: `DELETE /tracked-changes/change/{changeId}` — Permanently removes a tracked change (for undo/cascade). Currently only `undoChange()` exists which resets status to pending.
- Extend tracked change data model with `regionMap` field storing affected character ranges.
- New endpoint: `GET /tracked-changes/submission/{submissionId}/cascade/{changeId}` — Returns the dependency chain for a given change, so the frontend knows what will be affected before executing a rejection.
- New endpoint: `POST /tracked-changes/submission/{submissionId}/batch` — Accepts multiple transactions at once for recovering orphaned local saves.

### Frontend Changes

- Replace `HistoryPlugin` with a custom `TransactionHistoryPlugin` that intercepts Ctrl+Z/Y and delegates to the transaction stack when no active transaction exists.
- Refactor `TrackedChangesPlugin.applyDecorations()` to work incrementally instead of strip-and-rebuild.
- New `TransactionManager` service to manage the session stack, pause detection, and autosave coordination.
- New `SaveIndicator` component (cloud icon) replacing the current countdown/status UI.

## Migration & Backward Compatibility

### Existing Tracked Changes

- Current tracked changes stored in R2 continue to work as-is. They lack `regionMap` data, so cascade rejection won't apply to them — they'll be handled with the existing revert logic (richTextOldValue snapshot fallback).
- New transactions created after the update will have full region tracking.
- No data migration needed. Old and new formats coexist.

### Rollout Approach

- The pause-detection and transaction model replace the 15-second consolidation window. No feature flag needed — it's a direct behavioral upgrade.
- The `TransactionHistoryPlugin` replaces `HistoryPlugin` — Ctrl+Z behavior changes but is strictly better (keystroke-level within active transactions, transaction-level when idle).
- The save-on-close modal and localStorage fallback are additive — no existing behavior removed.
- The cloud icon replaces the countdown timer and status text.

### What Gets Removed

- Auto-save countdown timer UI
- "Saving..."/"Saved"/"Error" status text
- The 15-second consolidation window logic
- The strip-and-rebuild decoration cycle in `TrackedChangesPlugin`

### What Stays Unchanged

- WebSocket infrastructure (extended, not replaced)
- R2 storage model for tracked changes
- Reviewer approve/reject UI (cascade logic added behind the scenes)
- CSS Highlight API for additions
- `DeletedTextNode` for deletions (rendering refined, not replaced)
- All existing API endpoints (new ones added alongside)
