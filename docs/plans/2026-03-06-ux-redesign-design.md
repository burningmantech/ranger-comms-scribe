# Comms Scribe UX Redesign

**Date:** 2026-03-06
**Status:** Draft

## Problem Statement

Both submitters and reviewers face friction in the current Comms Scribe interface. Submitters encounter a bureaucracy-first form flow and have poor visibility into request status. Reviewers process submissions through a long vertical page with no prioritization, no batch operations, and no workflow-aware navigation. The result: submitters feel uncertain about where their request stands, and reviewers spend more time navigating the UI than actually reviewing content.

## Design Principles

1. **Show what needs attention, not everything.** Every screen should answer "what should I do next?"
2. **Content first.** Submitters should write what they want to say before filling out metadata.
3. **Transparency over status badges.** Show *why* something is blocked, not just *that* it's blocked.
4. **Power users deserve power tools.** Keyboard shortcuts, batch actions, queue navigation for daily reviewers.
5. **No guesswork.** Every participant should understand the full state of a submission at a glance.

---

## 1. Role-Aware Dashboards

### Current State
All users land on the same flat submissions list (`MySubmissions.tsx`). Status filter checkboxes are available for reviewers. No prioritization, no "what needs my attention" view.

### Redesign

#### Reviewer Dashboard (CommsCadre / CouncilManager)

Three-column triage layout:

**Needs My Action**
- Submissions where this user is a required approver and hasn't decided
- Submissions with unresolved tracked changes this user created
- Sorted by: urgency first, then age (oldest waiting first)

**In Progress**
- Submissions currently being reviewed by others
- Shows active collaborators via existing WebSocket presence data
- Provides awareness without requiring action

**Recently Completed**
- Approved/sent/rejected in the last 7 days
- Reference only, collapses if empty

Each submission card displays:
- Title (clickable, opens review mode)
- Submitter name
- Time waiting (e.g., "3 days ago")
- Urgency badge (if marked urgent)
- Approval progress bar (e.g., "2 of 3 approvers")
- Count of pending tracked changes
- Active collaborator avatars (from WebSocket presence)

#### Submitter Dashboard

**My Requests** view with a visual status pipeline per submission:

```
Submitted ──── In Review ──── Approved ──── Sent
    ✅             🔵              ⬜          ⬜
```

Each stage shows:
- Who's involved (approver names)
- What's blocking progress (e.g., "Waiting on Council Manager approval")
- Last activity preview (e.g., "K. Jones made 3 edits 2 hours ago")

Floating action button for "New Request" remains.

### Components Affected
- `MySubmissions.tsx` — major rewrite, split into role-specific views
- `Navbar.tsx` — "Requests" link behavior changes based on role
- New component: `ReviewerDashboard.tsx`
- New component: `SubmitterDashboard.tsx`
- New component: `SubmissionCard.tsx` (shared card component)

### Backend Changes
- New endpoint: `GET /api/content/submissions/my-actions` — returns submissions requiring the authenticated user's action, with approval state pre-computed
- Extend existing `GET /api/content/submissions` to include approval progress summary per submission (approver count, pending change count)

---

## 2. Submission Form Redesign

### Current State
3-step wizard: Details (contact info, audience, approvers) → Content (description, editor, signature) → Review (read-only summary). Metadata-heavy Step 1 front-loads bureaucratic fields before the user writes anything.

### Redesign

#### Step 1: "What do you want to say?"
- Title (required)
- Description (required, textarea)
- Rich text editor (Lexical, optional)
- Suggested subject line (required)
- Signature text (required)
- Auto-saves as draft on any change

#### Step 2: "Who should see this and when?"
- **Audience selection** — redesigned from bare checkboxes to illustrated cards with descriptions:
  - Each audience option rendered as a selectable card
  - Card includes: icon, name, one-line description of reach/purpose
  - Example: "Newsletter" card → "Included in the next Ranger newsletter — reaches all active Rangers"
  - "Other" card expands to show text input when selected
- **Publish-by date** with helper text: "We need at least 7 days to process"
- **Urgent checkbox** with inline warning
- **Reply-to address** (pre-filled from profile)

#### Step 3: "Who needs to approve?"
- Approver autocomplete (existing functionality)
- Smart defaults: pre-populate Council Manager for submitter's team if known
- Show each approver's current workload: "Currently reviewing N submissions"
- Submit button with inline preview sidebar

#### Remove the Separate Review Step
Replace with a persistent summary sidebar visible on Steps 2 and 3 that updates as fields are filled. Users always see what they've entered.

#### Admin-Managed Templates
- Template selector at the top of the form (optional)
- Templates stored in D1 database, managed via Admin panel
- Each template is a JSON blob of pre-filled field values:
  ```json
  {
    "id": "event-announcement",
    "name": "Event Announcement",
    "description": "For upcoming Ranger events",
    "fields": {
      "audience": ["newsletter", "allcom"],
      "signatureText": "— The Ranger Events Team",
      "suggestedSubjectLine": "[Event] "
    }
  }
  ```
- New Admin tab: "Templates" — CRUD interface for managing templates
- Templates are optional — users can always start blank

### Components Affected
- `CommsRequest.tsx` — major rewrite, reorder steps
- New component: `AudienceCard.tsx`
- New component: `TemplatePicker.tsx`
- New component: `FormSummarySidebar.tsx`
- Admin panel: new "Templates" tab

### Backend Changes
- New endpoints: `GET/POST/PUT/DELETE /api/admin/templates` — CRUD for submission templates
- Extend user/submission data to support smart approver defaults

---

## 3. Visual Approval Tracker

### Current State
Approvals displayed as a flat list showing who approved and when. The complex multi-condition logic (Council Manager + CommsCadre + required approvers + all changes resolved) is invisible to users. Status is a single badge.

### Redesign

**Four-gate approval checklist** displayed wherever submission status matters:

```
✅ Council Manager Approval     — J. Smith approved Mar 2
⬜ CommsCadre Approval          — Waiting (no one has reviewed yet)
✅ Required Approvers (2/2)     — K. Jones ✅  L. Chen ✅
⚠️  Tracked Changes (3 pending) — 3 changes need resolution
```

#### Behavior
- Each gate is expandable — click to see details, approver info, comments, timestamps
- Pending gates are visually prominent (amber/yellow)
- Completed gates show green checkmark with approver name and date
- "Tracked Changes" gate links directly to pending changes (navigates/scrolls)
- Override approvals show clearly with reason: "⚡ Override by M. Park: 'Time-sensitive, approved per director'"

#### Compact Version
For dashboard cards and the review mode top bar:
- Four small icons/dots showing gate status (green/amber/gray)
- Tooltip on hover shows detail
- Progress fraction: "3/4 conditions met"

#### Submitter Version
Simplified progress ring or segmented bar on their dashboard card. No internal logic exposed — just forward momentum indication.

### Components Affected
- New component: `ApprovalTracker.tsx` (full version)
- New component: `ApprovalTrackerCompact.tsx` (card/toolbar version)
- `ContentSubmission.tsx` — replace flat approval list
- `TrackedChangesEditor.tsx` — embed tracker in header
- `SubmissionCard.tsx` — embed compact tracker

### Backend Changes
- Extend `GET /api/content/submissions/:id` response to include structured approval gate status:
  ```json
  {
    "approvalGates": {
      "councilManager": { "met": true, "approver": "J. Smith", "date": "..." },
      "commsCadre": { "met": false },
      "requiredApprovers": { "met": true, "approved": 2, "total": 2, "details": [...] },
      "trackedChanges": { "met": false, "pending": 3 }
    }
  }
  ```

---

## 4. Tracked Changes: Batch Actions, Grouping, and Keyboard Shortcuts

### Current State
Changes are listed individually below the editor. Each change has its own approve/reject buttons. Content highlights (insertions in green, deletions with strikethrough) exist in the editor. Tabs for Proposed/Comparison/Original exist and remain.

### Redesign

#### Batch Operations
- **"Accept All" / "Reject All"** buttons at top of changes list
- **Multi-select checkboxes** on each change — select several, then batch approve/reject
- **"Accept All from [Author]"** — approve all changes by a specific editor
- Confirmation modal for batch actions: "Approve 8 changes by L. Chen?"

#### Change Grouping
- Related changes (same author, within 2-minute window) collapsed into a group
- Group header: "K. Jones made 5 edits — Mar 4, 2:15 PM" with expand/collapse
- Groups can be approved/rejected as a unit or expanded for individual review

#### Inline Change Markers
- Clickable margin indicators next to each change in the editor
- Click to expand a floating mini-panel showing:
  - Old value → new value
  - Author and timestamp
  - Approve / Reject buttons
  - Comment input
- Closes on click-away or Escape

#### Keyboard Shortcuts (Review Mode)
| Key | Action |
|-----|--------|
| `j` | Next change |
| `k` | Previous change |
| `a` | Approve current change |
| `r` | Reject current change |
| `e` | Expand/collapse current group |
| `?` | Show keyboard shortcut help |

#### Existing Features Preserved
- Proposed / Comparison / Original tabs — unchanged
- Inline green highlights for insertions, red strikethrough for deletions — unchanged
- Per-change commenting — unchanged

### Components Affected
- `TrackedChangesEditor.tsx` — add batch controls, grouping logic
- New component: `ChangeGroup.tsx`
- New component: `InlineChangeMarker.tsx`
- New component: `BatchActionBar.tsx`
- New component: `KeyboardShortcutHelp.tsx`

### Backend Changes
- New endpoint: `PUT /api/tracked-changes/batch` — accepts array of change IDs + status, applies in single operation
- Extend change response to include `groupId` or return changes pre-grouped by author+time window

---

## 5. Unified Activity Timeline

### Current State
Comments, approvals, tracked changes, and status transitions live in separate sections of the page. No chronological view of submission history. Submitters returning after days must scan multiple areas to understand what happened.

### Redesign

**Single chronological feed** interleaving all submission events:

```
Mar 5, 3:12 PM — K. Jones approved (Council Manager)
    "Looks good, minor edits needed on paragraph 2"

Mar 5, 2:45 PM — L. Chen made 5 edits
    Changed: title, paragraph 2 wording (3), signature

Mar 4, 10:00 AM — J. Smith commented
    "Can we soften the language in the second paragraph?"

Mar 3, 4:30 PM — A. Young submitted for review
    Required approvers: K. Jones, L. Chen, M. Park
```

#### Design
- Each entry: single scannable line with expandable detail
- Edits grouped by author + session (aligns with change grouping in section 4)
- Lives in a **collapsible right sidebar** in the tracked changes / review view
- Available as its own tab in the right panel of review mode
- On the submitter dashboard card: shows latest 1-2 events as preview

#### Event Types
- Submission created / submitted / status changed
- Approval / rejection decisions (with comments)
- Tracked changes made (grouped by author)
- Tracked changes approved / rejected
- Comments added
- Approvers added / removed
- Override approvals (with reason)

### Components Affected
- New component: `ActivityTimeline.tsx`
- New component: `TimelineEvent.tsx`
- `SubmissionCard.tsx` — embed latest activity preview

### Backend Changes
- New endpoint: `GET /api/content/submissions/:id/timeline` — returns merged, chronologically sorted list of all events for a submission
- Aggregates from: approvals, comments, tracked changes, status transitions
- Supports pagination (older events)

---

## 6. In-App Notifications

### Current State
Email-only notifications via AWS SES. Only covers replies and group content. No notification for approvals, tracked changes, or stale submissions. Users must remember to check the app.

### Redesign

#### Notification Bell
- Navbar icon with unread count badge
- Click reveals dropdown with recent notifications grouped by submission
- "Mark all read" and per-notification "mark read" on click
- Links directly to relevant submission/section

#### Notification Triggers

| Event | In-App | Email |
|-------|--------|-------|
| Your submission gets an approval/rejection | Yes | Always |
| You're added as a required approver | Yes | Always |
| Tracked changes made to submission you're assigned to | Yes | Always |
| Submission waiting for your action > 48 hours | Yes | Always |
| All conditions met — ready to send | Yes | Always |
| Someone comments on a change you made | Yes | Always |
| Someone replies to your comment | Yes | Always |

Email is always sent for all notification types. In-app is additive, not a replacement.

#### Real-Time Delivery
- Leverage existing WebSocket infrastructure to push notifications to connected users instantly
- No polling needed — piggyback on the submission room WebSocket or add a user-level notification channel

#### Storage
- Notifications stored in D1 with `read/unread` flag, `userId`, `type`, `submissionId`, `createdAt`
- Auto-expire after 30 days
- No complex notification preferences UI — all notifications are on

### Components Affected
- `Navbar.tsx` — add notification bell icon + dropdown
- New component: `NotificationBell.tsx`
- New component: `NotificationDropdown.tsx`
- New component: `NotificationItem.tsx`

### Backend Changes
- New D1 table: `notifications`
- New endpoints:
  - `GET /api/notifications` — paginated list for current user
  - `PUT /api/notifications/:id/read` — mark as read
  - `PUT /api/notifications/read-all` — mark all as read
  - `GET /api/notifications/unread-count` — for badge
- New service: `notificationService.ts` — extend existing to create in-app notifications alongside emails
- WebSocket: add user-level notification channel or broadcast notification events through existing submission rooms

---

## 7. Reviewer Power Bar: Dedicated Review Mode

### Current State
The tracked changes view (`/tracked-changes/:submissionId`) is a long vertical page. Editor at top, tracked changes below, approvals below that, comments at bottom. Reviewers scroll extensively. No way to move between submissions without returning to the list.

### Redesign

#### Fixed Top Bar
- Back arrow (returns to dashboard)
- Submission title (editable inline if user has edit permission)
- Submitter name + submission date
- Urgency badge
- Compact approval tracker (4 gate dots)
- Action buttons: **Approve** | **Request Changes** | **Reject**
- Queue navigation: ← Previous | Next → (cycles through "Needs My Action" queue)

#### Three-Panel Layout

**Left Panel (60%)**
- The editor with inline change markers
- Tabs: Proposed / Comparison / Original (preserved)
- Sticky formatting toolbar

**Right Panel (40%), Tabbed**
- **Changes** — tracked changes list with batch actions, keyboard navigable, grouped
- **Timeline** — unified activity timeline
- **Comments** — all comments with threaded replies and new comment input

#### "Request Changes" Action
- New first-class action alongside Approve and Reject
- Sets status to `in_review` (or stays in review)
- Requires a comment explaining what needs to change
- Sends notification to submitter with the feedback
- Distinct from reject — communicates "this needs work" vs "this is not appropriate"

#### Submission Queue Navigation
- Previous/Next arrows in top bar
- Queue = "Needs My Action" list from dashboard
- Ordered by urgency, then age
- Shows position: "3 of 7"
- Keyboard: `[` for previous, `]` for next

### Components Affected
- `TrackedChangesEditor.tsx` — major rewrite into three-panel layout
- New component: `ReviewTopBar.tsx`
- New component: `ReviewRightPanel.tsx`
- New component: `QueueNavigator.tsx`
- Existing tab components adapted into right panel tabs

### Backend Changes
- New endpoint: `POST /api/content/submissions/:id/request-changes` — sets/keeps `in_review` status, adds comment, triggers notification
- Extend `GET /api/content/submissions/my-actions` to support queue ordering and position

---

## Implementation Priority

Recommended build order based on impact and dependency:

| Phase | Features | Rationale |
|-------|----------|-----------|
| **Phase 1** | Approval Tracker (#3), Activity Timeline (#5) | Foundation components used everywhere else |
| **Phase 2** | Reviewer Dashboard (#1), Submitter Dashboard (#1) | Highest daily impact, depends on approval tracker |
| **Phase 3** | Tracked Changes Batch Actions (#4) | Reviewer efficiency, independent of layout changes |
| **Phase 4** | Submission Form Redesign (#2), Templates | Submitter experience, can ship independently |
| **Phase 5** | In-App Notifications (#6) | New infrastructure (D1 table, WebSocket channel) |
| **Phase 6** | Review Mode Three-Panel Layout (#7) | Largest UI change, benefits from all prior work |

Each phase is independently shippable and valuable. Later phases build on earlier ones but don't block them.

---

## Non-Goals

- Mobile-native app — responsive web is sufficient
- Offline support — requires internet for collaboration
- Custom approval workflows per submission — the four-gate model covers all current needs
- Rich notification preferences UI — keep it simple, everything is on
