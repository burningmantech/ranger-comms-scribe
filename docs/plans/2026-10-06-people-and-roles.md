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
| `isAdmin` | Admin: the admin pages, overrides, everything |
| `commsCadre` | Comms Cadre: reviews requests, builds and sends the newsletter |
| `councilRole` | The one council role held, or null: `CommunicationsManager`, `IntakeManager`, … |

Anyone signed in can submit requests and follow their own; there is no approval step (see "One council role, no
approval step" below). The fields are independent: a person can be Comms Cadre and Communications Manager.
`userType` and `roles` remain on the record for older readers but are **derived** from these fields on every save
(`saveUser`), never set directly: `userType` is the "highest" of Admin › CouncilManager › CommsCadre › Member;
`roles` lists `Admin`, `CommsCadre`, `CouncilManager` as they apply (or `Member`).

Lead and the Public/Member distinction are gone. The Roles tab is gone: what each role
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

**People** (replaces Users, Council, Comms Cadre and Roles): one row per person with Comms Cadre, Council role (one
menu) and Admin, a search box and filters (admins, Comms Cadre, Council). Changes save at once through
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
- **Groups → mailing lists.** In the UI, groups were only used to email their members. Comms needs to send to list
  addresses such as `ranger-<x>-cadre@burningman.org` instead, so lists are send destinations (`mailing_lists/<id>`),
  managed by the Comms Cadre and Admins under Requests → Lists & templates. Each says which audiences it serves; the
  Send view ticks those (Announce when none match) and the sender can change them. The `group/*` data and
  `/admin/groups` API are left in place with no screen. The backend still has `groupId` access checks and group
  notifications for blog posts, pages and gallery media, but no screen sets a `groupId`, so nothing reaches them
- **Templates** moved to the same page and are editable by the Comms Cadre as well as Admins
- **Reminders** are Remind buttons in a request's approval conditions popover (one per unmet gate or waiting
  approver), limited to once a day per target and logged on the request
- **Bulk add** is Add people on the People screen, with an optional role
- On dev and staging `COMMS_EMAIL_OVERRIDE` sends list emails and reminders to one address, so the real lists are
  never mailed from there

## One council role, no approval step

- **A person holds one council role** (`councilRole`, or null). `PUT /api/admin/people/:id/access` takes
  `councilRole`; setting one replaces the other, and a body with the old `councilRoles` (or `approved`) is refused
  with 400 so an old caller fails loudly. Records written before this keep `councilRoles` until their next save: they
  are read as their first known role, and `withDerivedAccess` drops the list on save. The people-access migration
  gives someone named for several roles the first in `COUNCIL_ROLES` order and reports it
- **No approval step.** `approved` gated nothing on the server (submitting already needed only a session); it only
  decided Public vs Member, the People screen's Approve button and "Awaiting approval" filter, and which people the
  required-approver picker (`GET /user/approvers`) suggested. Everyone signed in is now a Member, the picker lists
  everyone with an account, and `POST /admin/approve-user` and `POST /auth/approve` are gone. `approved` on older
  records is ignored and dropped on their next save

## Who approves a request

One approvers list per request (`requiredApprovers`) holds both kinds of approver, and the gates split it:

- **Council**: the council members on the list; at least one listed, all of them approved. The Comms Cadre choose
  (or swap) the council approver when the submitter didn't know who should approve, and "Add all of Council" lists
  every council member for a message signed by all of Council. A council member who isn't listed doesn't count
- **Other approvers**: the rest of the list, all approved (met when there are none)
- **Comms Cadre** and **Edits resolved** as before

After submission only Admins, the Comms Cadre and Council change the list (`PUT /submissions/:id/approvers`; the
general PUT ignores it so a stale copy can't undo a change). People added are emailed and notified in the app; the
status is checked again, so an approved request whose new approvers haven't approved goes back to in review. The
Comms Cadre see a request with no council approver in their "needs action" list; council members see only the
requests that list them. Reminders go to each waiting approver by name (`council` reminds the listed council
members still to approve).

Before this, any council member's approval met the Council gate and an empty list could never be approved, so
requests submitted with "I don't know" could only be approved by override.
