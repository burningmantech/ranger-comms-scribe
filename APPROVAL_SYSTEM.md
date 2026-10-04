# Approval System

This document describes the content submission approval workflow and tracked changes system in Comms Scribe, including how they relate to each other.

## Overview

There are two related but currently independent systems:

1. **Submission Approval** — A multi-role sign-off workflow that gates whether a submission can be sent as an announcement.
2. **Tracked Changes** — A per-edit review system that lets reviewers propose, approve, and reject individual content edits.

> **Known gap**: These two systems do not enforce any dependencies on each other. A submission can be approved while tracked changes are still pending. See [System Interaction & Known Gaps](#system-interaction--known-gaps) for details.

---

## Submission Lifecycle

```
draft → submitted → in_review → approved → sent
                              ↘ rejected
```

| Status | Description |
|--------|-------------|
| `draft` | Initial state, not yet submitted |
| `submitted` | User has submitted the content for review |
| `in_review` | Under active review by approvers |
| `approved` | All required approvals have been obtained |
| `rejected` | Rejected by a reviewer |
| `sent` | Announcement email has been sent |

---

## Submission Approval

### Three Approval Gates

For a submission to reach `approved`, **all three** conditions must be met:

1. **All required approvers** (specified per-submission by email) have approved
2. **At least one Council Manager** has approved
3. **At least one Comms Cadre member** has approved

This logic lives in `recomputeApprovalStatus()` in `backend/src/handlers/contentSubmission.ts`. It runs automatically after each approval is posted.

### How `recomputeApprovalStatus()` Works

1. **Deduplicates approvals by email** — Uses a `Map<email, approval>` keyed on lowercased, trimmed email. If someone has multiple approvals, only the latest (by `updatedAt`/`createdAt`) is kept.
2. **Checks required approvers** — Every email in the submission's `requiredApprovers` list must have a corresponding approval with `status = 'approved'`.
3. **Checks Comms Cadre approval** — Loads the active Comms Cadre member list from cache and checks for at least one matching approval.
4. **Checks Council Manager approval** — Loads council managers across all roles and checks for at least one matching approval.
5. **Final decision** — If all three checks pass, sets `status = 'approved'` and records `finalApprovalDate`.

### Flexible Approver Identification

An approver is recognized as Council Manager or Comms Cadre through any of:

- Their `approverType` field (e.g., `UserType.CommsCadre`)
- Their `approverRoles` array (e.g., includes `'CouncilManager'`)
- Their email appearing in the cached membership list for that role

This allows a single user to fulfill multiple role requirements.

### Approval Override

A **Communications Manager** (specific Council role) or **Admin** can bypass the normal approval flow:

- Endpoint: `POST /api/content/submissions/:id/override-approve`
- Sets `approvalOverride = true` with the overrider's identity, reason, and timestamp
- Status becomes `approved` immediately

### Sending Announcements

Once a submission reaches `approved`, it can be sent:

- Endpoint: `POST /api/content/submissions/:id/send-email`
- Only **Comms Cadre** or **Admin** can trigger this
- Sends announcement email to `rangers-announce@burningman.org`
- Status becomes `sent`

### Decision Changes

- Approvers can change their decision (approve → reject or vice versa)
- The existing approval record is updated in place (no duplicate records)
- `recomputeApprovalStatus()` re-evaluates after every change

---

## Tracked Changes

### Purpose

Tracked changes let reviewers propose specific edits to submission content. Each edit is reviewed individually, separate from the submission-level approval.

### Tracked Change Lifecycle

```
pending → approved    (change accepted into content)
        → rejected    (change discarded)
        → pending     (via undo — reverts a previous decision)
```

### Data Model

Each tracked change (`TrackedChange`) includes:

- `submissionId` — Which submission it belongs to
- `field` — Which content field was changed
- `oldValue` / `newValue` — The before and after (plain text)
- `richTextOldValue` / `richTextNewValue` — Rich text versions
- `changedBy` / `changedByName` — Who proposed the change
- `status` — `pending`, `approved`, or `rejected`
- `approvedBy` / `rejectedBy` — Who made the decision and when
- `previousVersionId` — For incremental change chains

### Storage

- Changes stored in Cloudflare R2 at `tracked-changes/submission/{submissionId}/{changeId}`
- Proposed versions stored at `proposed_versions/{submissionId}`
- Multi-layer caching (memory + KV) for performance

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /tracked-changes/submission/:id` | Fetch all changes + proposed versions |
| `POST /tracked-changes/submission/:id` | Create a new tracked change |
| `PUT /tracked-changes/change/:id/status` | Approve or reject a change |
| `POST /tracked-changes/change/:id/comment` | Comment on a change |
| `POST /tracked-changes/:id/undo` | Revert a decision back to pending |

### Rejecting a Change

When a tracked change is rejected, it is automatically reverted in the proposed version.

---

## System Interaction & Known Gaps

### Current State: No Enforcement

The two systems **do not check each other**. Specifically:

- `recomputeApprovalStatus()` never queries tracked changes
- The tracked changes endpoints never check submission approval status
- The frontend shows both workflows on the same screen but does not connect them

### Problematic Scenarios

| Scenario | What happens today |
|----------|--------------------|
| Reviewer approves submission with pending tracked changes | Silently succeeds — unresolved edits are ignored |
| Reviewer rejects a tracked change after submission is approved | Change is rejected, but submission stays `approved` |
| All tracked changes are rejected | Nothing happens to submission status |
| Proposed version is approved but submission is not | Proposed version sits with no effect on the workflow |

### Intended Workflow vs Actual Workflow

**What a reviewer probably expects:**
1. Review tracked changes, approve/reject each one
2. Once all changes are resolved, approve the submission
3. System ensures nothing is missed

**What actually happens:**
1. Tracked changes and submission approval are independent buttons
2. Reviewer can approve the submission at any time regardless of tracked change status
3. No warning or blocking when pending changes exist

---

## Access Control

| Action | Permitted Roles |
|--------|----------------|
| Create/submit content | Any authenticated user |
| View all submissions | Admin, users with content management permissions |
| View own submissions | Submitters, required approvers, previous approvers |
| Approve/reject submission | Council Managers, Comms Cadre, required approvers, Admin |
| Override approve submission | Communications Manager, Admin |
| Send announcement email | Comms Cadre, Admin |
| Propose tracked changes | Reviewers with `canCreateSuggestions` permission |
| Approve/reject tracked changes | Reviewers with `canApproveSuggestions` permission |

---

## Key Types

Defined in `backend/src/types.ts`:

- `ContentSubmission` — Includes `approvals`, `requiredApprovers`, `commsCadreApprovals`, `councilManagerApprovals`, `approvalOverride` fields
- `ContentApproval` — Individual approval record with `approverId`, `approverEmail`, `approverType`, `approverRoles`, `status`, and `comment`
- `TrackedChange` — Individual edit with `field`, `oldValue`, `newValue`, `status`, and reviewer metadata
- `UserType` — Enum: `Public`, `Member`, `Lead`, `CommsCadre`, `CouncilManager`, `Admin`
- `CouncilRole` — Enum: `CommunicationsManager`, `IntakeManager`, `LogisticsManager`, `OperationsManager`, `PersonnelManager`, `DepartmentManager`, `DeputyDepartmentManager`
