# Fix Required Approvers: "I Don't Know" Bug & Missing UI

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the bug where empty required approvers (from "I don't know" selection) falsely satisfies the approval gate, fix the tracked changes view not passing `requiredApprovers` from the backend, and add a required approvers management UI to the tracked changes page.

**Architecture:** Three bugs in one. (1) Backend: `[].every()` returns `true` in JS, so an empty `requiredApprovers` array vacuously passes the "all required approvers approved" check in both `recomputeApprovalStatus()` and `computeApprovalGates()`. (2) Frontend data-flow: `TrackedChangesView.tsx` hardcodes `requiredApprovers: []` instead of using `data.requiredApprovers` when transforming backend data. (3) Frontend UI: The tracked changes editor (primary review page) lacks the add/remove required approvers UI that exists in `ContentSubmission.tsx`.

**Tech Stack:** TypeScript, React, Cloudflare Workers, Jest

---

### Task 1: Fix `recomputeApprovalStatus()` — empty required approvers should not satisfy the gate

**Files:**
- Modify: `backend/src/handlers/contentSubmission.ts:36-38`
- Test: `backend/test/handlers/approvalGates.test.ts`

**Step 1: Write the failing test**

Add a new test to `backend/test/handlers/approvalGates.test.ts`. We need to also test `recomputeApprovalStatus` which is currently not exported. Since it's a private helper, we'll test the behavior via `computeApprovalGates` for now (it has the same bug).

Actually, we need to test `recomputeApprovalStatus` too. First, export it from `contentSubmission.ts`:

In `backend/src/handlers/contentSubmission.ts`, change:
```typescript
async function recomputeApprovalStatus(
```
to:
```typescript
export async function recomputeApprovalStatus(
```

Then add tests to `backend/test/handlers/approvalGates.test.ts`:

```typescript
import { computeApprovalGates, recomputeApprovalStatus } from '../../src/handlers/contentSubmission';
```

Add these tests:

```typescript
describe('recomputeApprovalStatus — empty required approvers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCouncilManagersForRole.mockResolvedValue([]);
    mockGetObject.mockResolvedValue(null);
    mockGetTrackedChanges.mockResolvedValue([]);
  });

  it('should NOT mark submission as approved when requiredApprovers is empty, even with council + comms cadre approval', async () => {
    mockGetCouncilManagersForRole.mockImplementation(async (role) => {
      if (role === CouncilRole.CommunicationsManager) {
        return [{ id: 'cm-1', userId: 'u', role: CouncilRole.CommunicationsManager, email: 'council@example.com', name: 'Council', active: true, createdAt: '', updatedAt: '' }];
      }
      return [];
    });
    mockGetObject.mockResolvedValue([{ email: 'cadre@example.com', active: true }]);

    const submission = makeSubmission({
      requiredApprovers: [],
      status: 'in_review',
      approvals: [
        makeApproval({ approverEmail: 'council@example.com', approverType: UserType.CouncilManager, status: 'approved' }),
        makeApproval({ approverEmail: 'cadre@example.com', approverType: UserType.CommsCadre, status: 'approved' }),
      ],
    });

    const result = await recomputeApprovalStatus(submission, mockEnv);
    expect(result.status).toBe('in_review'); // should NOT change to 'approved'
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest test/handlers/approvalGates.test.ts --no-coverage -t "should NOT mark submission as approved when requiredApprovers is empty"`
Expected: FAIL — currently returns `approved` because `[].every()` is `true`

**Step 3: Fix `recomputeApprovalStatus()`**

In `backend/src/handlers/contentSubmission.ts`, change line 36-38:

```typescript
// OLD:
const allRequiredApproversApproved = required.every(email =>
  uniqueApprovals.some(a => (a.approverEmail || '').trim().toLowerCase() === email && a.status === 'approved')
);

// NEW:
const allRequiredApproversApproved = required.length > 0 && required.every(email =>
  uniqueApprovals.some(a => (a.approverEmail || '').trim().toLowerCase() === email && a.status === 'approved')
);
```

Also export the function (change `async function` to `export async function` on line 16).

**Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest test/handlers/approvalGates.test.ts --no-coverage -t "should NOT mark submission as approved when requiredApprovers is empty"`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/handlers/contentSubmission.ts backend/test/handlers/approvalGates.test.ts
git commit -m "fix: prevent empty requiredApprovers from satisfying approval gate in recomputeApprovalStatus"
```

---

### Task 2: Fix `computeApprovalGates()` — empty required approvers should show as "not met"

**Files:**
- Modify: `backend/src/handlers/contentSubmission.ts:169`
- Test: `backend/test/handlers/approvalGates.test.ts`

**Step 1: Update the existing test**

The existing test at line 87-114 (`should return all gates unmet when there are no approvals and no required approvers`) currently asserts `gates.requiredApprovers.met` is `true`. Update it to expect `false`:

```typescript
// OLD (line 105):
expect(gates.requiredApprovers.met).toBe(true);

// NEW:
expect(gates.requiredApprovers.met).toBe(false);
```

Also update the test at line 594-605 (`should handle submission with undefined approvals array gracefully`):

```typescript
// OLD (line 603):
expect(gates.requiredApprovers.met).toBe(true);

// NEW:
expect(gates.requiredApprovers.met).toBe(false);
```

**Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest test/handlers/approvalGates.test.ts --no-coverage`
Expected: 2 test failures

**Step 3: Fix `computeApprovalGates()`**

In `backend/src/handlers/contentSubmission.ts`, change line 169:

```typescript
// OLD:
met: required.length === 0 || approvedCount === required.length,

// NEW:
met: required.length > 0 && approvedCount === required.length,
```

**Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest test/handlers/approvalGates.test.ts --no-coverage`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add backend/src/handlers/contentSubmission.ts backend/test/handlers/approvalGates.test.ts
git commit -m "fix: computeApprovalGates treats empty requiredApprovers as unmet"
```

---

### Task 3: Update ApprovalTracker frontend display for empty required approvers

**Files:**
- Modify: `frontend/src/components/ApprovalTracker.tsx:262-265`

**Step 1: Update the status text**

In `frontend/src/components/ApprovalTracker.tsx`, change line 262-265:

```typescript
// OLD:
const raStatusText =
  gates.requiredApprovers.total === 0
    ? 'None required'
    : `${gates.requiredApprovers.approved} of ${gates.requiredApprovers.total}`;

// NEW:
const raStatusText =
  gates.requiredApprovers.total === 0
    ? 'Needs assignment'
    : `${gates.requiredApprovers.approved} of ${gates.requiredApprovers.total}`;
```

**Step 2: Commit**

```bash
git add frontend/src/components/ApprovalTracker.tsx
git commit -m "fix: show 'Needs assignment' instead of 'None required' for empty approvers"
```

---

### Task 4: Fix `TrackedChangesView.tsx` — pass actual `requiredApprovers` from backend

**Files:**
- Modify: `frontend/src/pages/TrackedChangesView.tsx:169,413,565`

**Step 1: Fix all three transform locations**

There are three places in `TrackedChangesView.tsx` where the transformed submission hardcodes `requiredApprovers: []`. Change all three to use `data.requiredApprovers || []`.

Line 169 (in `fetchSubmission`):
```typescript
// OLD:
requiredApprovers: [],

// NEW:
requiredApprovers: data.requiredApprovers || [],
```

Line 413 (in `handleComment`):
```typescript
// OLD:
requiredApprovers: [],

// NEW:
requiredApprovers: data.requiredApprovers || [],
```

Line 565 (in `handleSuggestion`):
```typescript
// OLD:
requiredApprovers: [],

// NEW:
requiredApprovers: data.requiredApprovers || [],
```

**Step 2: Commit**

```bash
git add frontend/src/pages/TrackedChangesView.tsx
git commit -m "fix: pass actual requiredApprovers from backend in TrackedChangesView"
```

---

### Task 5: Add required approvers management UI to TrackedChangesEditor

**Files:**
- Modify: `frontend/src/components/TrackedChangesEditor.tsx`

This adds an "Approvers" section to the sidebar (alongside Changes, Timeline, Comments tabs) or as an expandable section within the existing sidebar content. Given the sidebar already has tabs, the most natural approach is to add a small "Required Approvers" panel below the approval tracker in the sidebar's "Changes" tab content area.

**Step 1: Add state and handlers for required approvers management**

Inside the `TrackedChangesEditor` component function (after the existing state declarations around line ~430), add:

```typescript
const [newApproverEmail, setNewApproverEmail] = useState('');

const canEditRequiredApprovers = useMemo(() => {
  const isSubmitter = currentUser.id === submission.submittedBy || currentUser.email === submission.submittedBy;
  const isCommsCadre = currentUser.roles.includes('CommsCadre');
  const isCouncilManager = currentUser.roles.includes('CouncilManager');
  const isAdmin = currentUser.roles.includes('Admin');
  return isSubmitter || isCommsCadre || isCouncilManager || isAdmin;
}, [currentUser, submission.submittedBy]);

const handleAddRequiredApprover = useCallback(async () => {
  const email = newApproverEmail.trim();
  if (!email) return;
  const updated = {
    ...submission,
    requiredApprovers: Array.from(new Set([...(submission.requiredApprovers || []), email]))
  };
  onSave(updated);
  setNewApproverEmail('');
}, [newApproverEmail, submission, onSave]);

const handleRemoveRequiredApprover = useCallback(async (email: string) => {
  const updated = {
    ...submission,
    requiredApprovers: (submission.requiredApprovers || []).filter(e => e !== email)
  };
  onSave(updated);
}, [submission, onSave]);
```

**Step 2: Add the required approvers UI to the sidebar**

Find the desktop sidebar `changes` tab content area. Look for the section after the `ApprovalTracker` compact rendering or the batch action bar. In the desktop sidebar content for the 'changes' tab, look for the area where changes are rendered (around the `changes-list` class).

Add a "Required Approvers" panel just before the changes list. The exact insertion point should be at the top of the sidebar 'changes' tab content, before the change groups/list.

```tsx
{/* Required Approvers management */}
{sidebarTab === 'changes' && (
  <div className="required-approvers-panel" style={{
    padding: '12px 16px',
    borderBottom: '1px solid #e5e7eb',
    fontSize: '13px',
  }}>
    <div style={{ fontWeight: 600, marginBottom: '8px', color: '#374151' }}>
      Required Approvers
    </div>
    {(submission.requiredApprovers || []).length === 0 ? (
      <div style={{ color: '#9ca3af', fontSize: '12px', marginBottom: '8px' }}>
        No approvers assigned yet
      </div>
    ) : (
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 8px 0' }}>
        {(submission.requiredApprovers || []).map((email) => (
          <li key={email} style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 0',
            fontSize: '12px',
          }}>
            <span style={{ color: '#374151' }}>{email}</span>
            {canEditRequiredApprovers && (
              <button
                onClick={() => handleRemoveRequiredApprover(email)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#ef4444',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '2px 6px',
                }}
                title="Remove approver"
              >
                <i className="fas fa-times" />
              </button>
            )}
          </li>
        ))}
      </ul>
    )}
    {canEditRequiredApprovers && (
      <div style={{ display: 'flex', gap: '4px' }}>
        <input
          type="email"
          placeholder="Add approver email"
          value={newApproverEmail}
          onChange={(e) => setNewApproverEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAddRequiredApprover(); }}
          style={{
            flex: 1,
            padding: '4px 8px',
            border: '1px solid #d1d5db',
            borderRadius: '4px',
            fontSize: '12px',
          }}
        />
        <button
          onClick={handleAddRequiredApprover}
          disabled={!newApproverEmail.trim()}
          className="btn btn-primary btn-sm"
          style={{ fontSize: '11px', padding: '4px 8px' }}
        >
          Add
        </button>
      </div>
    )}
  </div>
)}
```

**Step 3: Verify the `onSave` handler in `TrackedChangesView.tsx` passes `requiredApprovers`**

Check `handleSave` in `TrackedChangesView.tsx` (line 214-316). The backend submission object is built via `...updates` spread from `updatedSubmission`, so `requiredApprovers` will be included if it's on the submission object. However, the `backendSubmission` transform (line 228-266) doesn't explicitly include `requiredApprovers`. Add it:

In `TrackedChangesView.tsx` `handleSave`, add to the `backendSubmission` object (around line 260):
```typescript
requiredApprovers: updatedSubmission.requiredApprovers,
```

**Step 4: Commit**

```bash
git add frontend/src/components/TrackedChangesEditor.tsx frontend/src/pages/TrackedChangesView.tsx
git commit -m "feat: add required approvers management UI to tracked changes editor sidebar"
```

---

### Task 6: Run all tests and verify

**Step 1: Run backend tests**

Run: `cd backend && npm test -- --no-coverage`
Expected: ALL PASS

**Step 2: Run frontend build**

Run: `cd frontend && npm run build`
Expected: Build succeeds with no TypeScript errors

**Step 3: Final commit if any fixes needed**

If any test/build issues found, fix and commit.
