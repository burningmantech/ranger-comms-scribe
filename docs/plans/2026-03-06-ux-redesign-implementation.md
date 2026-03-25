# UX Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign Comms Scribe to provide role-aware dashboards, visual approval tracking, batch change operations, activity timelines, in-app notifications, a redesigned submission form, and a three-panel reviewer power bar.

**Architecture:** Six phases, each independently shippable. Phase 1 builds foundation components (ApprovalTracker, ActivityTimeline) used by later phases. Phase 2 builds role-aware dashboards. Phase 3 adds batch tracked change operations. Phase 4 redesigns the submission form with admin-managed templates. Phase 5 adds in-app notifications with a new D1 table and WebSocket delivery. Phase 6 restructures the review mode into a three-panel layout with queue navigation.

**Tech Stack:** React 18, TypeScript, Lexical editor, plain CSS with CSS variables, Cloudflare Workers (itty-router), D1 (SQLite), R2 storage, Durable Objects (WebSocket), Jest for backend tests.

**Design Document:** `docs/plans/2026-03-06-ux-redesign-design.md`

---

## Phase 1: Approval Tracker & Activity Timeline (Foundation)

These components are used everywhere in later phases. Build them first.

---

### Task 1.1: Backend — Approval Gates Endpoint

Add a structured approval gates response to the submission GET endpoint so the frontend can render the four-gate approval tracker without duplicating business logic.

**Files:**
- Modify: `backend/src/handlers/contentSubmission.ts` (extend GET /:id response)
- Modify: `backend/src/types.ts` (add ApprovalGates type)
- Test: `backend/test/handlers/contentSubmission.test.ts` (create if needed)

**Step 1: Add ApprovalGates type to backend types**

In `backend/src/types.ts`, add after the `ContentApproval` interface (line 207):

```typescript
export interface ApprovalGateDetail {
  met: boolean;
  approver?: string;
  approverName?: string;
  date?: string;
  comment?: string;
}

export interface ApprovalGates {
  councilManager: ApprovalGateDetail;
  commsCadre: ApprovalGateDetail;
  requiredApprovers: {
    met: boolean;
    approved: number;
    total: number;
    details: Array<{
      email: string;
      name?: string;
      status: 'approved' | 'rejected' | 'pending';
      date?: string;
    }>;
  };
  trackedChanges: {
    met: boolean;
    pending: number;
    total: number;
  };
}
```

**Step 2: Create computeApprovalGates helper function**

In `backend/src/handlers/contentSubmission.ts`, add a new function after `recomputeApprovalStatus()` (after line 81). This function extracts the same logic but returns structured gate data instead of a status string:

```typescript
async function computeApprovalGates(
  submission: ContentSubmission,
  env: any
): Promise<ApprovalGates> {
  // Deduplicate approvals by latest per approver (same logic as recomputeApprovalStatus lines 18-30)
  const latestApprovals = new Map<string, ContentApproval>();
  for (const approval of submission.approvals) {
    const key = approval.approverEmail || approval.approverId;
    const existing = latestApprovals.get(key);
    if (!existing || new Date(approval.updatedAt) > new Date(existing.updatedAt)) {
      latestApprovals.set(key, approval);
    }
  }

  // Check required approvers
  const requiredApprovers = submission.requiredApprovers || [];
  const requiredDetails = requiredApprovers.map(email => {
    const approval = latestApprovals.get(email);
    return {
      email,
      name: approval?.approverName,
      status: approval ? (approval.status as 'approved' | 'rejected') : 'pending' as const,
      date: approval?.updatedAt,
    };
  });
  const allRequiredApproved = requiredDetails.length > 0 &&
    requiredDetails.every(d => d.status === 'approved');

  // Check council manager approval (same logic as recomputeApprovalStatus lines 44-60)
  const councilManagerEmails = new Set<string>();
  // Load all council roles
  for (const role of Object.values(CouncilRole)) {
    const managers = await getCouncilManagersForRole(role, env);
    managers.forEach((m: CouncilMember) => councilManagerEmails.add(m.email));
  }
  let councilGate: ApprovalGateDetail = { met: false };
  for (const [, approval] of latestApprovals) {
    if (approval.status === 'approved' &&
        (approval.approverType === UserType.CouncilManager ||
         councilManagerEmails.has(approval.approverEmail))) {
      councilGate = {
        met: true,
        approver: approval.approverEmail,
        approverName: approval.approverName,
        date: approval.updatedAt,
        comment: approval.comment,
      };
      break;
    }
  }

  // Check comms cadre approval (same logic as recomputeApprovalStatus lines 40-42, 62-66)
  const commsCadreList = await getObject<any[]>('comms_cadre:active', env) || [];
  const commsCadreEmails = new Set(commsCadreList.map((m: any) => m.email));
  let commsGate: ApprovalGateDetail = { met: false };
  for (const [, approval] of latestApprovals) {
    if (approval.status === 'approved' &&
        (approval.approverType === UserType.CommsCadre ||
         commsCadreEmails.has(approval.approverEmail))) {
      commsGate = {
        met: true,
        approver: approval.approverEmail,
        approverName: approval.approverName,
        date: approval.updatedAt,
        comment: approval.comment,
      };
      break;
    }
  }

  // Check tracked changes (same logic as recomputeApprovalStatus lines 69-74)
  const changesData = await listObjects(`tracked-changes/submission/${submission.id}/`, env);
  let pendingChanges = 0;
  let totalChanges = 0;
  if (changesData) {
    for (const change of changesData) {
      totalChanges++;
      if (change.status === 'pending') pendingChanges++;
    }
  }

  return {
    councilManager: councilGate,
    commsCadre: commsGate,
    requiredApprovers: {
      met: allRequiredApproved,
      approved: requiredDetails.filter(d => d.status === 'approved').length,
      total: requiredDetails.length,
      details: requiredDetails,
    },
    trackedChanges: {
      met: pendingChanges === 0,
      pending: pendingChanges,
      total: totalChanges,
    },
  };
}
```

**Step 3: Include approval gates in GET /:id response**

In the GET `/:id` handler (around line 169-222), before returning the response, call `computeApprovalGates()` and include it:

```typescript
const approvalGates = await computeApprovalGates(submission, env);
return json({ ...submission, approvalGates });
```

**Step 4: Write test for computeApprovalGates**

Create `backend/test/handlers/approvalGates.test.ts`:

```typescript
import { computeApprovalGates } from '../../src/handlers/contentSubmission';
// Test that:
// 1. All gates start as unmet with empty approvals
// 2. Council manager approval sets councilManager.met = true
// 3. CommsCadre approval sets commsCadre.met = true
// 4. Required approver progress is tracked correctly
// 5. Tracked changes pending count is accurate
// 6. Override approvals are reflected
```

**Step 5: Run tests**

```bash
cd backend && npm test
```

**Step 6: Commit**

```bash
git add backend/src/types.ts backend/src/handlers/contentSubmission.ts backend/test/handlers/approvalGates.test.ts
git commit -m "feat: add approval gates structured response to submission endpoint"
```

---

### Task 1.2: Backend — Activity Timeline Endpoint

Create a new endpoint that merges all submission events into a chronological timeline.

**Files:**
- Create: `backend/src/handlers/timeline.ts`
- Modify: `backend/src/index.ts` (register route)
- Modify: `backend/src/types.ts` (add TimelineEvent type)
- Test: `backend/test/handlers/timeline.test.ts`

**Step 1: Add TimelineEvent type**

In `backend/src/types.ts`, add:

```typescript
export type TimelineEventType =
  | 'submission_created'
  | 'status_changed'
  | 'approval_decision'
  | 'tracked_changes_made'
  | 'tracked_change_reviewed'
  | 'comment_added'
  | 'approver_added'
  | 'approver_removed'
  | 'override_approval';

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  timestamp: string;
  actorId: string;
  actorName: string;
  actorEmail: string;
  summary: string;
  details?: Record<string, any>;
  groupKey?: string; // For grouping related events (e.g., same author within 2 min)
}
```

**Step 2: Create timeline handler**

Create `backend/src/handlers/timeline.ts`:

```typescript
import { AutoRouter } from 'itty-router';
import { getObject, listObjects } from '../services/cacheService';
import { ContentSubmission, ContentApproval, ContentComment, TimelineEvent } from '../types';

const router = AutoRouter({ base: '/api/timeline' });

router.get('/submission/:submissionId', async (request: any, env: any) => {
  const { submissionId } = request.params;
  const user = request.user;

  // Load submission
  const submission = await getObject<ContentSubmission>(
    `content_submissions/${submissionId}`, env
  );
  if (!submission) return new Response('Not found', { status: 404 });

  const events: TimelineEvent[] = [];

  // 1. Submission created event
  events.push({
    id: `created-${submission.id}`,
    type: 'submission_created',
    timestamp: submission.submittedAt,
    actorId: submission.submittedBy,
    actorName: submission.submittedBy,
    actorEmail: submission.submittedBy,
    summary: `Submitted for review`,
    details: {
      requiredApprovers: submission.requiredApprovers,
    },
  });

  // 2. Approval events
  for (const approval of (submission.approvals || [])) {
    events.push({
      id: `approval-${approval.id}`,
      type: 'approval_decision',
      timestamp: approval.updatedAt || approval.createdAt,
      actorId: approval.approverId,
      actorName: approval.approverName,
      actorEmail: approval.approverEmail,
      summary: `${approval.status === 'approved' ? 'Approved' : 'Rejected'} (${approval.approverType})`,
      details: {
        status: approval.status,
        approverType: approval.approverType,
        comment: approval.comment,
      },
    });
  }

  // 3. Comment events
  for (const comment of (submission.comments || [])) {
    events.push({
      id: `comment-${comment.id}`,
      type: 'comment_added',
      timestamp: comment.createdAt,
      actorId: comment.authorId,
      actorName: comment.authorName,
      actorEmail: comment.authorId,
      summary: `Commented`,
      details: {
        content: comment.content?.substring(0, 150),
        isSuggestion: comment.isSuggestion,
        resolved: comment.resolved,
      },
    });
  }

  // 4. Tracked changes events
  const changesData = await listObjects(
    `tracked-changes/submission/${submissionId}/`, env
  );
  if (changesData) {
    for (const change of changesData) {
      events.push({
        id: `change-${change.id}`,
        type: 'tracked_changes_made',
        timestamp: change.timestamp || change.changedAt,
        actorId: change.changedBy,
        actorName: change.changedByName || change.changedBy,
        actorEmail: change.changedBy,
        summary: `Edited ${change.field}`,
        details: {
          field: change.field,
          status: change.status,
        },
        groupKey: `${change.changedBy}-${Math.floor(new Date(change.timestamp || change.changedAt).getTime() / 120000)}`,
      });

      // Change review events
      if (change.status === 'approved' && change.approvedBy) {
        events.push({
          id: `change-review-${change.id}`,
          type: 'tracked_change_reviewed',
          timestamp: change.approvedAt,
          actorId: change.approvedBy,
          actorName: change.approvedByName || change.approvedBy,
          actorEmail: change.approvedBy,
          summary: `Approved change to ${change.field}`,
          details: { field: change.field, decision: 'approved' },
        });
      }
      if (change.status === 'rejected' && change.rejectedBy) {
        events.push({
          id: `change-review-${change.id}`,
          type: 'tracked_change_reviewed',
          timestamp: change.rejectedAt,
          actorId: change.rejectedBy,
          actorName: change.rejectedByName || change.rejectedBy,
          actorEmail: change.rejectedBy,
          summary: `Rejected change to ${change.field}`,
          details: { field: change.field, decision: 'rejected' },
        });
      }
    }
  }

  // 5. Override approval event
  if (submission.approvalOverride) {
    events.push({
      id: `override-${submission.id}`,
      type: 'override_approval',
      timestamp: submission.approvalOverrideAt || submission.submittedAt,
      actorId: submission.approvalOverrideBy || 'unknown',
      actorName: submission.approvalOverrideBy || 'Unknown',
      actorEmail: submission.approvalOverrideBy || '',
      summary: `Override approval`,
      details: { reason: submission.approvalOverrideReason },
    });
  }

  // Sort by timestamp descending (newest first)
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Group related events by groupKey (e.g., same author edits within 2 minutes)
  // Frontend will handle visual grouping using the groupKey field

  return Response.json(events);
});

export { router as timelineRouter };
```

**Step 3: Register the timeline router**

In `backend/src/index.ts`, add import and route registration alongside existing routes (around line 149-181):

```typescript
import { timelineRouter } from './handlers/timeline';
// Add route:
router.all('/api/timeline/*', withValidSession, timelineRouter.fetch);
```

**Step 4: Write test**

Create `backend/test/handlers/timeline.test.ts` with tests for:
- Returns events sorted by timestamp descending
- Includes submission_created event
- Includes approval events
- Includes comment events
- Includes tracked change events
- Groups events by author within 2-minute window via groupKey
- Returns 404 for non-existent submission

**Step 5: Run tests**

```bash
cd backend && npm test
```

**Step 6: Commit**

```bash
git add backend/src/types.ts backend/src/handlers/timeline.ts backend/src/index.ts backend/test/handlers/timeline.test.ts
git commit -m "feat: add activity timeline endpoint for submissions"
```

---

### Task 1.3: Frontend — ApprovalTracker Component

Build the visual four-gate approval tracker component.

**Files:**
- Create: `frontend/src/components/ApprovalTracker.tsx`
- Create: `frontend/src/components/ApprovalTracker.css`
- Modify: `frontend/src/types/content.ts` (add ApprovalGates type)

**Step 1: Add ApprovalGates type to frontend types**

In `frontend/src/types/content.ts`, add after the `Change` interface (line 134):

```typescript
export interface ApprovalGateDetail {
  met: boolean;
  approver?: string;
  approverName?: string;
  date?: string;
  comment?: string;
}

export interface ApprovalGates {
  councilManager: ApprovalGateDetail;
  commsCadre: ApprovalGateDetail;
  requiredApprovers: {
    met: boolean;
    approved: number;
    total: number;
    details: Array<{
      email: string;
      name?: string;
      status: 'approved' | 'rejected' | 'pending';
      date?: string;
    }>;
  };
  trackedChanges: {
    met: boolean;
    pending: number;
    total: number;
  };
}
```

**Step 2: Create ApprovalTracker component**

Create `frontend/src/components/ApprovalTracker.tsx`:

Two variants:
- **Full version** (`variant="full"`): shows all four gates with expandable details, used in submission detail and review mode
- **Compact version** (`variant="compact"`): shows four colored dots with tooltip, used in dashboard cards and top bars

Props:
```typescript
interface ApprovalTrackerProps {
  gates: ApprovalGates;
  variant: 'full' | 'compact';
  onNavigateToChanges?: () => void; // Click handler for pending changes gate
  showOverride?: boolean;
  overrideInfo?: {
    by: string;
    reason: string;
    at: string;
  };
}
```

Full variant renders:
- Four rows, each with icon (checkmark/warning/circle), gate label, status text
- Expandable detail on click (approver name, date, comment)
- "Tracked Changes" row links to pending changes via `onNavigateToChanges`

Compact variant renders:
- Four small dots in a row (green = met, amber = warning, gray = not started)
- Fraction text: "3/4 conditions met"
- Tooltip on hover showing gate names

**Step 3: Create ApprovalTracker.css**

Style using existing CSS variable patterns from `styles/common.css`:
- Use `var(--accent-teal)` for met gates
- Use `var(--accent-gold)` for pending/warning gates
- Use `#ccc` for not-started gates
- Use `var(--danger)` for rejected states
- Expandable sections with smooth transitions
- Responsive: stack vertically on mobile

**Step 4: Commit**

```bash
git add frontend/src/components/ApprovalTracker.tsx frontend/src/components/ApprovalTracker.css frontend/src/types/content.ts
git commit -m "feat: add ApprovalTracker component with full and compact variants"
```

---

### Task 1.4: Frontend — ActivityTimeline Component

Build the unified activity timeline component.

**Files:**
- Create: `frontend/src/components/ActivityTimeline.tsx`
- Create: `frontend/src/components/ActivityTimeline.css`
- Modify: `frontend/src/types/content.ts` (add TimelineEvent type)

**Step 1: Add TimelineEvent type to frontend types**

In `frontend/src/types/content.ts`, add:

```typescript
export type TimelineEventType =
  | 'submission_created'
  | 'status_changed'
  | 'approval_decision'
  | 'tracked_changes_made'
  | 'tracked_change_reviewed'
  | 'comment_added'
  | 'approver_added'
  | 'approver_removed'
  | 'override_approval';

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  timestamp: string;
  actorId: string;
  actorName: string;
  actorEmail: string;
  summary: string;
  details?: Record<string, any>;
  groupKey?: string;
}
```

**Step 2: Create ActivityTimeline component**

Create `frontend/src/components/ActivityTimeline.tsx`:

Props:
```typescript
interface ActivityTimelineProps {
  submissionId: string;
  events?: TimelineEvent[]; // Can pass events directly or let component fetch
  maxItems?: number; // For preview mode on dashboard cards
  showGroupedEdits?: boolean; // Collapse related edits
}
```

Features:
- Fetches from `GET /api/timeline/submission/:submissionId` if events not passed as prop
- Groups events with same `groupKey` into collapsible groups
- Each event renders: relative timestamp, actor name, event icon, summary line
- Expandable details on click (comment text, approval comment, change details)
- Loading skeleton while fetching
- Empty state: "No activity yet"
- `maxItems` prop truncates with "View all activity" link

Event icons (using Font Awesome, already in project):
- `submission_created`: `fa-paper-plane`
- `approval_decision`: `fa-check-circle` (approved) or `fa-times-circle` (rejected)
- `comment_added`: `fa-comment`
- `tracked_changes_made`: `fa-pencil-alt`
- `tracked_change_reviewed`: `fa-clipboard-check`
- `override_approval`: `fa-bolt`

**Step 3: Create ActivityTimeline.css**

- Vertical timeline line on left (2px, `var(--accent-gold)`)
- Event dots on the timeline line
- Content to the right of the line
- Grouped events indented with lighter connector
- Expandable details with smooth height transition
- Responsive: full width on mobile

**Step 4: Commit**

```bash
git add frontend/src/components/ActivityTimeline.tsx frontend/src/components/ActivityTimeline.css frontend/src/types/content.ts
git commit -m "feat: add ActivityTimeline component with event grouping"
```

---

### Task 1.5: Integrate ApprovalTracker into Existing Views

Wire the new ApprovalTracker into the existing `ContentSubmission.tsx` and `TrackedChangesEditor.tsx`.

**Files:**
- Modify: `frontend/src/components/ContentSubmission.tsx` (replace flat approval list)
- Modify: `frontend/src/components/TrackedChangesEditor.tsx` (add to toolbar area)

**Step 1: Update ContentSubmission.tsx**

In `ContentSubmission.tsx`, after the submission header section (around line 507):
- Fetch approval gates from the submission response (the backend now includes `approvalGates`)
- Replace the existing approval list rendering with `<ApprovalTracker variant="full" gates={submission.approvalGates} />`
- Keep existing approve/reject buttons below the tracker

**Step 2: Update TrackedChangesEditor.tsx**

In `TrackedChangesEditor.tsx`, in the editor toolbar area (around line 2068-2099):
- Add `<ApprovalTracker variant="compact" gates={approvalGates} />` to the sticky toolbar
- Pass `onNavigateToChanges` to scroll to the changes section

**Step 3: Test manually**

```bash
cd frontend && npm run start:local-backend
```

Verify:
- Full tracker shows in submission detail view
- Compact tracker shows in tracked changes toolbar
- Gates reflect actual approval state
- Clicking pending changes gate scrolls to changes

**Step 4: Commit**

```bash
git add frontend/src/components/ContentSubmission.tsx frontend/src/components/TrackedChangesEditor.tsx
git commit -m "feat: integrate ApprovalTracker into submission detail and editor views"
```

---

### Task 1.6: Integrate ActivityTimeline into TrackedChangesEditor

Add the timeline as a tab in the tracked changes sidebar.

**Files:**
- Modify: `frontend/src/components/TrackedChangesEditor.tsx`

**Step 1: Add Timeline tab**

In `TrackedChangesEditor.tsx`, in the sidebar section (around line 2964+):
- Add a "Timeline" tab alongside existing sidebar content
- Render `<ActivityTimeline submissionId={submissionId} />` when tab is active
- Default to showing the Changes tab (existing behavior preserved)

**Step 2: Test manually**

Verify timeline loads, events are chronological, groups collapse/expand.

**Step 3: Commit**

```bash
git add frontend/src/components/TrackedChangesEditor.tsx
git commit -m "feat: add activity timeline tab to tracked changes sidebar"
```

---

## Phase 2: Role-Aware Dashboards

---

### Task 2.1: Backend — My Actions Endpoint

Create an endpoint that returns submissions needing the current user's action.

**Files:**
- Modify: `backend/src/handlers/contentSubmission.ts` (add new route)
- Test: `backend/test/handlers/myActions.test.ts`

**Step 1: Add my-actions endpoint**

In `backend/src/handlers/contentSubmission.ts`, add a new route:

```typescript
router.get('/my-actions', async (request: any, env: any) => {
  const user = request.user;

  // Get all submissions
  const allSubmissions = await listObjects('content_submissions/', env) || [];

  const needsAction: any[] = [];
  const inProgress: any[] = [];

  for (const submission of allSubmissions) {
    if (['sent', 'rejected', 'draft'].includes(submission.status)) continue;

    const isRequiredApprover = (submission.requiredApprovers || []).includes(user.email);
    const hasApproved = (submission.approvals || []).some(
      (a: any) => (a.approverEmail === user.email || a.approverId === user.id)
    );

    // Check if user is CommsCadre or CouncilManager who hasn't acted
    const isReviewer = user.userType === 'CommsCadre' || user.userType === 'CouncilManager' || user.isAdmin;

    const gates = await computeApprovalGates(submission, env);

    if (isRequiredApprover && !hasApproved) {
      needsAction.push({ ...submission, approvalGates: gates });
    } else if (isReviewer && !hasApproved) {
      // Check if their role's gate is unmet
      if ((user.userType === 'CouncilManager' && !gates.councilManager.met) ||
          (user.userType === 'CommsCadre' && !gates.commsCadre.met)) {
        needsAction.push({ ...submission, approvalGates: gates });
      } else {
        inProgress.push({ ...submission, approvalGates: gates });
      }
    } else {
      inProgress.push({ ...submission, approvalGates: gates });
    }
  }

  // Sort: urgent first, then oldest first
  const sortByUrgencyThenAge = (a: any, b: any) => {
    const aUrgent = a.formFields?.some((f: any) => f.name === 'urgent' && f.value === 'true');
    const bUrgent = b.formFields?.some((f: any) => f.name === 'urgent' && f.value === 'true');
    if (aUrgent && !bUrgent) return -1;
    if (!aUrgent && bUrgent) return 1;
    return new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
  };

  needsAction.sort(sortByUrgencyThenAge);
  inProgress.sort(sortByUrgencyThenAge);

  return Response.json({ needsAction, inProgress });
});
```

**Step 2: Write test, run, commit**

```bash
cd backend && npm test
git add backend/src/handlers/contentSubmission.ts backend/test/handlers/myActions.test.ts
git commit -m "feat: add my-actions endpoint for reviewer dashboard"
```

---

### Task 2.2: Frontend — Reviewer Dashboard

Create the three-column triage dashboard for CommsCadre/CouncilManager users.

**Files:**
- Create: `frontend/src/components/ReviewerDashboard.tsx`
- Create: `frontend/src/components/ReviewerDashboard.css`
- Create: `frontend/src/components/SubmissionCard.tsx`
- Create: `frontend/src/components/SubmissionCard.css`

**Step 1: Create SubmissionCard component**

A reusable card for displaying a submission summary. Used by both dashboards.

Props:
```typescript
interface SubmissionCardProps {
  submission: ContentSubmission & { approvalGates?: ApprovalGates };
  onClick: () => void;
  showApprovalTracker?: boolean;
  showLatestActivity?: boolean;
}
```

Renders:
- Title (clickable)
- Submitter name + relative time ("3 days ago")
- Urgency badge (if urgent)
- `<ApprovalTracker variant="compact" />` if `showApprovalTracker`
- Pending changes count badge
- Latest activity line (from submission's most recent comment/approval)

**Step 2: Create ReviewerDashboard component**

Fetches from `GET /api/content/submissions/my-actions`.

Three columns:
- **Needs My Action** — `needsAction` array, each rendered as `<SubmissionCard>`
- **In Progress** — `inProgress` array, filtered to non-completed
- **Recently Completed** — submissions with status `approved`, `sent`, or `rejected` from last 7 days

Each column has a header with count badge. Empty state per column.

Responsive: columns stack vertically on mobile (each as a collapsible section).

**Step 3: Create CSS files**

Use existing grid patterns. Three-column layout with `display: grid; grid-template-columns: 1fr 1fr 1fr;` on desktop, single column on mobile.

Cards use existing card styling from `common.css`. Add subtle left border color per column (teal for needs action, gold for in progress, gray for completed).

**Step 4: Commit**

```bash
git add frontend/src/components/ReviewerDashboard.tsx frontend/src/components/ReviewerDashboard.css frontend/src/components/SubmissionCard.tsx frontend/src/components/SubmissionCard.css
git commit -m "feat: add ReviewerDashboard with three-column triage layout"
```

---

### Task 2.3: Frontend — Submitter Dashboard

Create the status-pipeline dashboard for regular submitters.

**Files:**
- Create: `frontend/src/components/SubmitterDashboard.tsx`
- Create: `frontend/src/components/SubmitterDashboard.css`
- Create: `frontend/src/components/StatusPipeline.tsx`
- Create: `frontend/src/components/StatusPipeline.css`

**Step 1: Create StatusPipeline component**

A visual pipeline showing: `Submitted → In Review → Approved → Sent`

Props:
```typescript
interface StatusPipelineProps {
  status: SubmissionStatus;
  approvalGates?: ApprovalGates;
  blockingReason?: string;
}
```

Renders four connected circles with labels. Current stage is highlighted. Past stages show green checkmark. Blocking reason shown below current stage.

**Step 2: Create SubmitterDashboard component**

Uses the existing `submissions` from `useContent()` context, filtered to current user's submissions.

Each submission rendered as a card with:
- Title
- `<StatusPipeline status={submission.status} />`
- Blocking info: "Waiting on Council Manager approval" (derived from `approvalGates`)
- Latest activity preview from timeline
- "View Details" button

Floating action button for "New Request" (preserved from current design).

**Step 3: Create CSS files**

Pipeline uses flexbox with connecting lines between dots. Cards are full-width with pipeline integrated.

**Step 4: Commit**

```bash
git add frontend/src/components/SubmitterDashboard.tsx frontend/src/components/SubmitterDashboard.css frontend/src/components/StatusPipeline.tsx frontend/src/components/StatusPipeline.css
git commit -m "feat: add SubmitterDashboard with status pipeline visualization"
```

---

### Task 2.4: Frontend — Route to Role-Aware Dashboard

Replace `MySubmissions` with role-based dashboard routing.

**Files:**
- Modify: `frontend/src/pages/MySubmissions.tsx` (render appropriate dashboard based on role)

**Step 1: Update MySubmissions.tsx**

The page component checks user role and renders the appropriate dashboard:

```typescript
const { currentUser, userPermissions } = useContent();

const isReviewer = userPermissions?.canViewFilteredSubmissions ||
  currentUser?.roles?.some(r => ['CommsCadre', 'CouncilManager', 'Admin'].includes(r));

return isReviewer
  ? <ReviewerDashboard />
  : <SubmitterDashboard />;
```

**Step 2: Test both views**

```bash
cd frontend && npm run start:local-backend
```

Verify reviewer sees three-column triage, submitter sees pipeline view.

**Step 3: Commit**

```bash
git add frontend/src/pages/MySubmissions.tsx
git commit -m "feat: route to role-aware dashboard based on user permissions"
```

---

## Phase 3: Tracked Changes Batch Actions

---

### Task 3.1: Backend — Batch Change Status Endpoint

**Files:**
- Modify: `backend/src/handlers/trackedChanges.ts`
- Test: `backend/test/handlers/batchChanges.test.ts`

**Step 1: Add batch endpoint**

Add to `backend/src/handlers/trackedChanges.ts`:

```typescript
router.put('/batch', async (request: any, env: any) => {
  const user = request.user;
  const body = await request.json();
  const { changeIds, status, comment } = body;

  if (!Array.isArray(changeIds) || changeIds.length === 0) {
    return Response.json({ error: 'changeIds array required' }, { status: 400 });
  }
  if (!['approved', 'rejected'].includes(status)) {
    return Response.json({ error: 'Invalid status' }, { status: 400 });
  }

  // Check permissions
  if (user.userType !== UserType.Admin &&
      user.userType !== UserType.CommsCadre &&
      user.userType !== UserType.CouncilManager) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const results = [];
  for (const changeId of changeIds) {
    // Reuse existing single-change update logic
    const change = await getObject<any>(`tracked-changes/${changeId}`, env);
    if (!change) {
      results.push({ changeId, success: false, error: 'Not found' });
      continue;
    }

    const updated = {
      ...change,
      status,
      ...(status === 'approved'
        ? { approvedBy: user.email, approvedByName: user.name, approvedAt: new Date().toISOString() }
        : { rejectedBy: user.email, rejectedByName: user.name, rejectedAt: new Date().toISOString() }),
      ...(comment ? { reviewComment: comment } : {}),
    };

    await putObject(`tracked-changes/${changeId}`, updated, env);
    results.push({ changeId, success: true });
  }

  return Response.json({ results });
});
```

**Step 2: Write test, run, commit**

```bash
cd backend && npm test
git add backend/src/handlers/trackedChanges.ts backend/test/handlers/batchChanges.test.ts
git commit -m "feat: add batch change status endpoint for bulk approve/reject"
```

---

### Task 3.2: Frontend — Batch Actions UI in TrackedChangesEditor

**Files:**
- Modify: `frontend/src/components/TrackedChangesEditor.tsx`
- Create: `frontend/src/components/BatchActionBar.tsx`
- Create: `frontend/src/components/BatchActionBar.css`

**Step 1: Create BatchActionBar component**

Props:
```typescript
interface BatchActionBarProps {
  selectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onApproveSelected: () => void;
  onRejectSelected: () => void;
  onApproveAll: () => void;
  onRejectAll: () => void;
  disabled?: boolean;
}
```

Renders a sticky bar above the changes list:
- Checkbox for select all
- "N selected" count
- "Approve Selected" button (teal)
- "Reject Selected" button (danger)
- Divider
- "Accept All" button
- "Reject All" button
- Confirmation modal for bulk actions: "Approve N changes?"

**Step 2: Add selection state to TrackedChangesEditor**

In `TrackedChangesEditor.tsx`:
- Add `selectedChangeIds: Set<string>` state
- Add checkboxes to each change row in the changes list
- Render `<BatchActionBar>` above the changes list when user has approval permissions
- Wire up batch API call: `PUT /api/tracked-changes/batch`

**Step 3: Add keyboard shortcuts**

Add a `useEffect` for keydown listener (only when changes tab is focused):
- `j` → select next change
- `k` → select previous change
- `a` → approve current/selected change(s)
- `r` → reject current/selected change(s)

Show keyboard shortcut hint icon in the batch action bar that expands to show all shortcuts.

**Step 4: Commit**

```bash
git add frontend/src/components/BatchActionBar.tsx frontend/src/components/BatchActionBar.css frontend/src/components/TrackedChangesEditor.tsx
git commit -m "feat: add batch actions, multi-select, and keyboard shortcuts to tracked changes"
```

---

### Task 3.3: Frontend — Change Grouping

**Files:**
- Modify: `frontend/src/components/TrackedChangesEditor.tsx`
- Create: `frontend/src/components/ChangeGroup.tsx`
- Create: `frontend/src/components/ChangeGroup.css`

**Step 1: Create ChangeGroup component**

Groups changes by author within a 2-minute window.

Props:
```typescript
interface ChangeGroupProps {
  authorName: string;
  authorEmail: string;
  timestamp: string;
  changes: Change[];
  expanded: boolean;
  onToggle: () => void;
  onApproveGroup: () => void;
  onRejectGroup: () => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  canReview: boolean;
}
```

Renders:
- Collapsed: "K. Jones made 5 edits — Mar 4, 2:15 PM" with expand chevron + group approve/reject buttons
- Expanded: individual changes with existing per-change rendering + checkboxes

**Step 2: Group changes in TrackedChangesEditor**

Add grouping logic before rendering the changes list:

```typescript
function groupChanges(changes: Change[]): ChangeGroupData[] {
  const sorted = [...changes].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const groups: ChangeGroupData[] = [];
  for (const change of sorted) {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup &&
        lastGroup.authorEmail === change.changedBy &&
        Math.abs(new Date(change.timestamp).getTime() -
                 new Date(lastGroup.timestamp).getTime()) < 120000) {
      lastGroup.changes.push(change);
    } else {
      groups.push({
        authorName: change.changedByName || change.changedBy,
        authorEmail: change.changedBy,
        timestamp: change.timestamp,
        changes: [change],
      });
    }
  }
  return groups;
}
```

Replace flat change list rendering with grouped rendering.

**Step 3: Commit**

```bash
git add frontend/src/components/ChangeGroup.tsx frontend/src/components/ChangeGroup.css frontend/src/components/TrackedChangesEditor.tsx
git commit -m "feat: add change grouping by author and time window"
```

---

## Phase 4: Submission Form Redesign

---

### Task 4.1: Backend — Templates CRUD

**Files:**
- Create: `backend/src/handlers/templates.ts`
- Modify: `backend/src/index.ts` (register route)
- Modify: `backend/src/types.ts` (add SubmissionTemplate type)

**Step 1: Add SubmissionTemplate type**

In `backend/src/types.ts`:

```typescript
export interface SubmissionTemplate {
  id: string;
  name: string;
  description: string;
  fields: {
    audience?: string[];
    signatureText?: string;
    suggestedSubjectLine?: string;
    description?: string;
    [key: string]: any;
  };
  sortOrder: number;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

**Step 2: Create templates handler**

Create `backend/src/handlers/templates.ts` with CRUD endpoints:
- `GET /api/admin/templates` — list all templates (sorted by sortOrder)
- `POST /api/admin/templates` — create template (admin only)
- `PUT /api/admin/templates/:id` — update template (admin only)
- `DELETE /api/admin/templates/:id` — delete template (admin only)
- `GET /api/templates` — public list of active templates (for submission form)

Storage: `templates/{id}` in cache/R2.

**Step 3: Register route in index.ts**

**Step 4: Write test, run, commit**

```bash
cd backend && npm test
git add backend/src/types.ts backend/src/handlers/templates.ts backend/src/index.ts
git commit -m "feat: add submission templates CRUD endpoints"
```

---

### Task 4.2: Frontend — Admin Templates Tab

**Files:**
- Modify: `frontend/src/components/Admin.tsx` (add Templates tab)
- Create: `frontend/src/components/TemplateManagement.tsx`
- Create: `frontend/src/components/TemplateManagement.css`

**Step 1: Add Templates to AdminTab enum**

In `Admin.tsx`, add `Templates = 'templates'` to the enum and add the tab button.

**Step 2: Create TemplateManagement component**

Features:
- List of templates with name, description, and drag-to-reorder (or sort order input)
- "Add Template" button opens inline form
- Each template has Edit/Delete buttons
- Edit form: name, description, audience checkboxes, signature text, subject line prefix
- Active/inactive toggle
- Save calls `PUT /api/admin/templates/:id`

**Step 3: Commit**

```bash
git add frontend/src/components/Admin.tsx frontend/src/components/TemplateManagement.tsx frontend/src/components/TemplateManagement.css
git commit -m "feat: add Templates management tab to admin panel"
```

---

### Task 4.3: Frontend — Redesign CommsRequest Form

Reorder the 3-step wizard: Content → Audience/Timing → Approvers.

**Files:**
- Modify: `frontend/src/components/CommsRequest.tsx` (major rewrite)
- Create: `frontend/src/components/AudienceCard.tsx`
- Create: `frontend/src/components/AudienceCard.css`
- Create: `frontend/src/components/TemplatePicker.tsx`
- Create: `frontend/src/components/TemplatePicker.css`
- Create: `frontend/src/components/FormSummarySidebar.tsx`
- Create: `frontend/src/components/FormSummarySidebar.css`

**Step 1: Create AudienceCard component**

Replaces bare checkboxes with illustrated selectable cards.

Props:
```typescript
interface AudienceCardProps {
  id: string;
  label: string;
  description: string;
  icon: string; // Font Awesome class
  selected: boolean;
  onToggle: () => void;
}
```

Audience descriptions (map these in CommsRequest.tsx):
- Newsletter → "Included in the next Ranger newsletter — reaches all active Rangers"
- Singular announcement → "A standalone announcement sent directly to all Rangers"
- Allcom → "Broadcast to the full Allcom distribution list"
- Website - fix → "Fix or correction to existing website content"
- Website - update → "New or updated content for the Ranger website"
- JRS/Event Ops/Other BMP Audience → "Communication targeted at JRS, Event Ops, or other BMP teams"
- Let's plan an event → "Coordination for an upcoming Ranger event"
- Other → "Something else — describe below"

**Step 2: Create TemplatePicker component**

Fetches from `GET /api/templates`. Shows as a row of selectable cards at the top of the form. Optional — "Start blank" is always the first option.

**Step 3: Create FormSummarySidebar component**

A sticky sidebar (desktop only) that shows current form state as the user fills fields. Updates live. Shows on Steps 2 and 3. Replaces the old Step 3 review page.

**Step 4: Rewrite CommsRequest.tsx**

New step order:
1. **Step 1: Content** — Template picker (optional), title, description, rich text editor, suggested subject line, signature
2. **Step 2: Audience & Timing** — AudienceCards, publish-by date, urgent checkbox, reply-to
3. **Step 3: Approvers** — Approver autocomplete (existing logic), submit button

Remove the dedicated review step. Add `<FormSummarySidebar>` visible on Steps 2-3.

Auto-save as draft on any field change (debounced 2 seconds).

Keep existing Zod validation but adjust for new step order.

**Step 5: Commit**

```bash
git add frontend/src/components/CommsRequest.tsx frontend/src/components/AudienceCard.tsx frontend/src/components/AudienceCard.css frontend/src/components/TemplatePicker.tsx frontend/src/components/TemplatePicker.css frontend/src/components/FormSummarySidebar.tsx frontend/src/components/FormSummarySidebar.css
git commit -m "feat: redesign submission form with content-first flow and templates"
```

---

## Phase 5: In-App Notifications

---

### Task 5.1: Backend — Notifications Infrastructure

**Files:**
- Create: `backend/src/handlers/notifications.ts`
- Modify: `backend/src/index.ts` (register route)
- Modify: `backend/src/types.ts` (add Notification type)
- Modify: `backend/src/services/notificationService.ts` (extend to create in-app notifications)

**Step 1: Add Notification type**

In `backend/src/types.ts`:

```typescript
export type NotificationType =
  | 'approval_received'
  | 'rejection_received'
  | 'changes_made'
  | 'assigned_as_approver'
  | 'submission_waiting'
  | 'ready_to_send'
  | 'comment_on_change'
  | 'comment_reply';

export interface AppNotification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  submissionId?: string;
  submissionTitle?: string;
  actorName?: string;
  read: boolean;
  createdAt: string;
}
```

**Step 2: Create notifications handler**

Create `backend/src/handlers/notifications.ts`:

```typescript
// GET /api/notifications — paginated list for current user
// PUT /api/notifications/:id/read — mark as read
// PUT /api/notifications/read-all — mark all as read
// GET /api/notifications/unread-count — for badge
```

Storage: `notifications/{userId}/{id}` in cache/R2.

**Step 3: Extend notificationService.ts**

Add `createInAppNotification()` function. Call it from existing email notification functions so both email and in-app notifications are created together.

Add new notification trigger functions:
- `notifyApprovalDecision(submissionId, decision, actorName, env)` — called from approve handler
- `notifyTrackedChanges(submissionId, changerName, changeCount, env)` — called from tracked changes handler
- `notifyAssignedAsApprover(submissionId, approverEmail, env)` — called from submission update handler

Each function:
1. Creates in-app notification
2. Sends email (always)

**Step 4: Wire notification triggers into existing handlers**

In `contentSubmission.ts` approve handler (around line 358): call `notifyApprovalDecision()`.
In `trackedChanges.ts` create handler (around line 136): call `notifyTrackedChanges()`.
In `contentSubmission.ts` update handler when requiredApprovers changes: call `notifyAssignedAsApprover()`.

**Step 5: Register route, test, commit**

```bash
cd backend && npm test
git add backend/src/types.ts backend/src/handlers/notifications.ts backend/src/services/notificationService.ts backend/src/handlers/contentSubmission.ts backend/src/handlers/trackedChanges.ts backend/src/index.ts
git commit -m "feat: add in-app notification infrastructure with email always-on"
```

---

### Task 5.2: Frontend — Notification Bell

**Files:**
- Create: `frontend/src/components/NotificationBell.tsx`
- Create: `frontend/src/components/NotificationBell.css`
- Modify: `frontend/src/components/Navbar.tsx` (add bell)

**Step 1: Create NotificationBell component**

Features:
- Bell icon (`fa-bell`) with unread count badge (red circle)
- Polls `GET /api/notifications/unread-count` every 30 seconds
- Also receives real-time updates via WebSocket (piggyback on existing connection)
- Click opens dropdown with notification list
- Each notification: icon, title, relative time, click navigates to submission
- "Mark all read" link at top
- Click notification marks it read and navigates

**Step 2: Add to Navbar.tsx**

In `Navbar.tsx`, add `<NotificationBell />` to the navbar for logged-in users (around line 108-140), positioned before the user menu.

**Step 3: Commit**

```bash
git add frontend/src/components/NotificationBell.tsx frontend/src/components/NotificationBell.css frontend/src/components/Navbar.tsx
git commit -m "feat: add notification bell with dropdown to navbar"
```

---

## Phase 6: Reviewer Power Bar (Three-Panel Layout)

---

### Task 6.1: Backend — Request Changes Action

**Files:**
- Modify: `backend/src/handlers/contentSubmission.ts`

**Step 1: Add request-changes endpoint**

```typescript
router.post('/submissions/:id/request-changes', async (request: any, env: any) => {
  const user = request.user;
  const { id } = request.params;
  const { comment } = await request.json();

  if (!comment || !comment.trim()) {
    return Response.json({ error: 'Comment required when requesting changes' }, { status: 400 });
  }

  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  if (!submission) return new Response('Not found', { status: 404 });

  // Keep or set status to in_review
  submission.status = 'in_review';

  // Add comment
  const newComment: ContentComment = {
    id: crypto.randomUUID(),
    submissionId: id,
    content: comment,
    authorId: user.id || user.email,
    authorName: user.name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isSuggestion: false,
    resolved: false,
  };
  submission.comments = [...(submission.comments || []), newComment];

  await putObject(`content_submissions/${id}`, submission, env);

  // Notify submitter
  await createInAppNotification({
    userId: submission.submittedBy,
    type: 'changes_requested',
    title: 'Changes requested',
    message: `${user.name} requested changes on "${submission.title}"`,
    submissionId: id,
    submissionTitle: submission.title,
    actorName: user.name,
  }, env);

  // Broadcast via WebSocket
  await broadcastToSubmissionRoom(id, {
    type: 'status_changed',
    data: { status: 'in_review', comment: newComment },
  }, env);

  return Response.json({ success: true });
});
```

**Step 2: Test, commit**

```bash
cd backend && npm test
git add backend/src/handlers/contentSubmission.ts
git commit -m "feat: add request-changes action for reviewer workflow"
```

---

### Task 6.2: Frontend — Three-Panel Review Layout

This is the largest frontend change. Restructure `TrackedChangesEditor.tsx` into a dedicated review mode.

**Files:**
- Create: `frontend/src/components/ReviewTopBar.tsx`
- Create: `frontend/src/components/ReviewTopBar.css`
- Create: `frontend/src/components/ReviewRightPanel.tsx`
- Create: `frontend/src/components/ReviewRightPanel.css`
- Create: `frontend/src/components/QueueNavigator.tsx`
- Create: `frontend/src/components/QueueNavigator.css`
- Modify: `frontend/src/components/TrackedChangesEditor.tsx` (restructure layout)
- Modify: `frontend/src/components/TrackedChangesEditor.css` (new three-panel grid)

**Step 1: Create ReviewTopBar component**

Fixed top bar with:
- Back arrow (calls `onBack`)
- Submission title (editable inline if `canEdit`)
- Submitter name + date
- Urgency badge
- `<ApprovalTracker variant="compact" />`
- Action buttons: Approve | Request Changes | Reject
- `<QueueNavigator />` (Previous/Next)

**Step 2: Create QueueNavigator component**

Props:
```typescript
interface QueueNavigatorProps {
  currentIndex: number;
  totalCount: number;
  onPrevious: () => void;
  onNext: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
}
```

Fetches the reviewer's queue from `GET /api/content/submissions/my-actions`. Tracks current position. Shows "3 of 7". Keyboard shortcuts: `[` for previous, `]` for next.

**Step 3: Create ReviewRightPanel component**

Tabbed panel (40% width) with three tabs:
- **Changes** — existing tracked changes list with batch actions, checkboxes, grouping (from Phase 3)
- **Timeline** — `<ActivityTimeline submissionId={id} />`
- **Comments** — existing comments list with reply capability

**Step 4: Restructure TrackedChangesEditor layout**

Replace the current vertical scroll layout with CSS Grid:

```css
.review-mode {
  display: grid;
  grid-template-rows: auto 1fr;
  grid-template-columns: 6fr 4fr;
  height: 100vh;
}

.review-top-bar {
  grid-column: 1 / -1;
}

.review-left-panel {
  overflow-y: auto;
  padding: 24px;
}

.review-right-panel {
  border-left: 1px solid #e0e0e0;
  overflow-y: auto;
}

@media (max-width: 768px) {
  .review-mode {
    grid-template-columns: 1fr;
  }
  .review-right-panel {
    border-left: none;
    border-top: 1px solid #e0e0e0;
  }
}
```

The left panel contains the editor with tabs (Proposed/Comparison/Original) — preserved from current design.

The right panel contains the new `<ReviewRightPanel>`.

Move the approval section from the bottom into the top bar's action buttons.

Move the comments section from the bottom into the right panel's Comments tab.

Move the tracked changes list from the bottom into the right panel's Changes tab.

**Step 5: Add "Request Changes" button**

Wire the "Request Changes" button to a modal that requires a comment, then calls `POST /api/content/submissions/:id/request-changes`.

**Step 6: Test manually**

```bash
cd frontend && npm run start:local-backend
```

Verify:
- Three-panel layout renders correctly
- Tabs in right panel switch between Changes/Timeline/Comments
- Action buttons (Approve/Request Changes/Reject) work
- Queue navigation moves between submissions
- Keyboard shortcuts work (`[`, `]`, `j`, `k`, `a`, `r`)
- Responsive: collapses to single column on mobile
- Existing Proposed/Comparison/Original tabs still work in left panel

**Step 7: Commit**

```bash
git add frontend/src/components/ReviewTopBar.tsx frontend/src/components/ReviewTopBar.css frontend/src/components/ReviewRightPanel.tsx frontend/src/components/ReviewRightPanel.css frontend/src/components/QueueNavigator.tsx frontend/src/components/QueueNavigator.css frontend/src/components/TrackedChangesEditor.tsx frontend/src/components/TrackedChangesEditor.css
git commit -m "feat: restructure review mode into three-panel layout with queue navigation"
```

---

## Post-Implementation Checklist

After all phases are complete:

- [ ] Run full backend test suite: `cd backend && npm test`
- [ ] Run full frontend test suite: `cd frontend && npm test`
- [ ] Run frontend build to check for TypeScript errors: `cd frontend && npm run build`
- [ ] Run backend build: `cd backend && npm run build`
- [ ] Manual smoke test: create submission → review → approve → send
- [ ] Test responsive layouts on mobile viewport
- [ ] Verify WebSocket notifications deliver in real-time
- [ ] Verify email notifications still send for all trigger events
- [ ] Check accessibility: keyboard navigation, screen reader labels
- [ ] Review all new CSS for consistency with existing design system variables

---

## New Files Created (Summary)

### Backend
| File | Purpose |
|------|---------|
| `backend/src/handlers/timeline.ts` | Activity timeline endpoint |
| `backend/src/handlers/notifications.ts` | In-app notifications CRUD |
| `backend/src/handlers/templates.ts` | Submission templates CRUD |

### Frontend
| File | Purpose |
|------|---------|
| `frontend/src/components/ApprovalTracker.tsx` | Four-gate approval visualization |
| `frontend/src/components/ActivityTimeline.tsx` | Chronological event feed |
| `frontend/src/components/ReviewerDashboard.tsx` | Three-column triage dashboard |
| `frontend/src/components/SubmitterDashboard.tsx` | Status pipeline dashboard |
| `frontend/src/components/SubmissionCard.tsx` | Reusable submission card |
| `frontend/src/components/StatusPipeline.tsx` | Visual status pipeline |
| `frontend/src/components/BatchActionBar.tsx` | Batch approve/reject controls |
| `frontend/src/components/ChangeGroup.tsx` | Grouped changes by author |
| `frontend/src/components/AudienceCard.tsx` | Illustrated audience selector |
| `frontend/src/components/TemplatePicker.tsx` | Template selection for forms |
| `frontend/src/components/FormSummarySidebar.tsx` | Live form preview sidebar |
| `frontend/src/components/TemplateManagement.tsx` | Admin template management |
| `frontend/src/components/NotificationBell.tsx` | Navbar notification dropdown |
| `frontend/src/components/ReviewTopBar.tsx` | Fixed review mode toolbar |
| `frontend/src/components/ReviewRightPanel.tsx` | Tabbed right panel for review |
| `frontend/src/components/QueueNavigator.tsx` | Submission queue navigation |

### Modified Files
| File | Changes |
|------|---------|
| `backend/src/types.ts` | ApprovalGates, TimelineEvent, AppNotification, SubmissionTemplate types |
| `backend/src/index.ts` | Register timeline, notifications, templates routes |
| `backend/src/handlers/contentSubmission.ts` | Approval gates, my-actions endpoint, request-changes action |
| `backend/src/handlers/trackedChanges.ts` | Batch status endpoint |
| `backend/src/services/notificationService.ts` | In-app notification creation |
| `frontend/src/types/content.ts` | ApprovalGates, TimelineEvent types |
| `frontend/src/pages/MySubmissions.tsx` | Role-based dashboard routing |
| `frontend/src/components/Navbar.tsx` | Notification bell |
| `frontend/src/components/CommsRequest.tsx` | Reordered wizard, templates |
| `frontend/src/components/ContentSubmission.tsx` | ApprovalTracker integration |
| `frontend/src/components/TrackedChangesEditor.tsx` | Three-panel layout, batch actions, timeline tab |
| `frontend/src/components/Admin.tsx` | Templates tab |
