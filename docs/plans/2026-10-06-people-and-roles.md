# People and roles: one model

**Date:** 2026-10-06
**Status:** Built on `feat/roles` (from `feat/review-ui`)

## Problem

Who someone is lived in five places, each with its own admin screen and its own readers:

- `user.userType` (one of Public, Member, Lead, Admin, CommsCadre, CouncilManager), set by the Users tab's Role menu
- `user.roles` (rewritten by the Role menu, appended to by council flows, replaced by the frontend from `/admin/user-roles`)
- role groups (`group/<id>` named after a role) and the Roles tab's permission checkboxes, which nothing enforces
- `council_members:role:<Role>` / `council_members:<userId>:<Role>` / `council_member/<id>`, written by three different code paths
- `comms_cadre:active` (whose handler updates an unused legacy `users` array)

Permission checks read whichever they happened to use, so one person could be Comms Cadre by one check and not by
another; adding a council or cadre role cleared Admin; removing a Comms Cadre member always failed; council members
from the hard-coded org chart never counted for approvals; and the Role menu could not express "Comms Cadre and
Communications Manager".

## Model

Each person's record holds their access, and nothing else does:

| Field | Meaning |
|---|---|
| `approved` | Can sign in and submit requests ("awaiting approval" until an Admin approves) |
| `isAdmin` | Admin: the admin pages, overrides, everything |
| `commsCadre` | Comms Cadre: reviews requests, builds and sends the newsletter |
| `councilRoles` | Council roles, any number: `CommunicationsManager`, `IntakeManager`, … |

They are independent: a person can be Comms Cadre and Communications Manager. `userType` and `roles` remain on the
record for older readers but are **derived** from these fields on every save (`saveUser`), never set directly:
`userType` is the "highest" of Admin › CouncilManager › CommsCadre › Member (approved) › Public; `roles` lists
`Admin`, `CommsCadre`, `CouncilManager` as they apply.

Lead and the Public/Member distinction are gone (Leads become approved members). The Roles tab is gone: what each role
can do is fixed in code and described on the People page. The boot-time org chart is gone.

## Checks

`backend/src/services/access.ts` is the only place that answers "can this person …":
`isAdmin`, `isCommsCadre`, `isCouncil`, `hasCouncilRole(role)`, `isCommsManager`, `isReviewer` (Admin, Comms Cadre or
Council). Every handler uses it. The frontend mirror is `frontend/src/utils/access.ts`, reading the same fields from
the signed-in user (`/auth/me`).

Approval gates count an approver for a gate if they held the role when approving (the snapshot on the approval) or hold
it now (their record). As before, one person who holds both roles approves both gates.

Lists ("who is the Communications Manager", approver suggestions, newsletter notifications) are read from the people
records (`listPeople`), not from separate lists.

## Admin

**People** (replaces Users, Council, Comms Cadre and Roles): one row per person with Approved, Admin, Comms Cadre and
Council roles, a search box and filters (awaiting approval, admins, Comms Cadre, Council). Changes save at once through
`PUT /api/admin/people/:id/access`. The last Admin can't remove their own Admin. Groups, Bulk add, Reminders and
Templates stay.

## Migration

At startup, once (`migrations/people-access-v1`), every person gets the new fields from today's data:

- `isAdmin`: `isAdmin` or `userType === 'Admin'`
- `commsCadre`: `userType === 'CommsCadre'`, a `CommsCadre` role, or active on `comms_cadre:active`
- `councilRoles`: every role list (`council_members:role:*`) and active legacy record (`council_member/*`) naming them;
  plus their per-person records (`council_members:<id>:<role>`) if they are still a council manager by type or role
  (the org chart wrote only those)
- `approved`: unchanged (Leads and Members stay approved)

The old keys are left in place (unused) so a rollback still finds them.

## Follow-ups (not changed here)

Permission gaps the review found, left as they were so this change only moves checks onto the new model:
`getTrackedChangesHandler` and `updateProposedVersionsHandler` allow any signed-in user (`|| true`); creating
tracked changes, change comments, batch create, the timeline and submission comments check only for a session.

## Comms setup (follow-on cleanup)

The rest of the old Admin tabs moved to where the work happens:
- **Groups → mailing lists.** Groups were only used to email their members. Comms needs to send to list addresses
  such as `ranger-<x>-cadre@burningman.org` instead, so lists are send destinations (`mailing_lists/<id>`), managed by
  the Comms Cadre and Admins under Requests → Lists & templates. Each says which audiences it serves; the Send view
  ticks those (Announce when none match) and the sender can change them. The `group/*` data and `/admin/groups`
  API are left in place, unused by the UI
- **Templates** moved to the same page and are editable by the Comms Cadre as well as Admins
- **Reminders** are Remind buttons in a request's approval conditions popover (one per unmet gate or waiting
  approver), limited to once a day per target and logged on the request
- **Bulk add** is Add people on the People screen, with an approved switch and an optional role
- On dev and staging `COMMS_EMAIL_OVERRIDE` sends list emails and reminders to one address, so the real lists are
  never mailed from there
