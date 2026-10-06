# Ranger newsletter ("Black Rock Ranger News")

**Date:** 2026-10-06
**Status:** Built on `feat/newsletter` (from `feat/review-ui`)

## Why

The Rangers send a newsletter about once a month over Ranger Announce. Until now the comms form only had a
"Newsletter" audience checkbox; editions were assembled by hand in a Google Doc (issue #10 went out in July 2026).
This adds the whole path: submitters describe a newsletter item, the Comms Cadre build and edit editions, the
edition is approved, sent to Announce, and published on the web.

## How it works

1. **The request.** With *Newsletter* as an audience, the form asks for a **newsletter item**: a headline, a short
   blurb (or "Please write the blurb for me"), up to two photos with credits, links, and where **Read more** goes
   (nothing, the request's full announcement as a web page, or a link). Any request can add **key dates**
   (deadlines and events). The full text can ask for help too ("Please help me write this"). Stored on the
   submission as `audiences`, `newsletter`, `keyDates`, `writingHelp`. Reviewers edit the item and dates on the
   review page (a Newsletter panel, `PATCH /api/content/submissions/:id/newsletter`); they are not tracked changes.
2. **The tray.** Approved requests with the newsletter audience that are in no edition yet. Requests still in review
   show greyed out. Requests that asked for blurb help are flagged.
3. **The edition.** The cadre start the next number (#11 onwards) and add items from the tray. Each becomes a
   **section**: a copy of the item (edits never go back to the request). If the request's item changes later, the
   section shows "Request changed: refresh". They can also write their own sections, mark a section *Important*
   (a highlighted panel), reorder and remove sections (a removed item goes back to the tray), and edit the
   masthead, tagline, introduction, reply-to and footnotes.
4. **The calendar.** "Mark your calendar!" is built from the sections' key dates plus rows added by hand. Section
   rows can be hidden; duplicates merge; rows that have ended are left out when sending. Hand-added rows still ahead
   carry over to the next edition (e.g. "Burning Man!").
5. **Approval.** For the edition's current version: a Comms Cadre member **and** the Council Communications
   Manager approve, and nobody has asked for changes. As with requests, one person who is both counts for both.
   An Admin or the Communications Manager can override with a reason. **Any edit after approval needs approving
   again**: every save bumps `version`, and approvals count only for the version they were given on.
6. **Sending.** *Send test to me* sends to the signed-in user (subject prefixed `[TEST]`). *Send to Announce* needs
   the current version approved, sends to `ANNOUNCE_EMAIL_TO` as `"<subject> - Ranger News #N"`, with gallery
   photos attached inline (as announcements are), then freezes the edition, publishes its web page and the Read more
   pages it links to, and marks the requests: `newsletterSentIn`, and `status: 'sent'` when the request has no
   singular/allcom audience still to send.
7. **Public pages** (no sign-in, `noindex`): `/newsletter` (archive), `/newsletter/:number` (the edition as sent) and
   `/news/:slug` (a request's full announcement; the slug is unguessable). A document's page is published only when
   an edition that links to it is sent (also when it went out on its own as a singular announcement before).

A newsletter-only request no longer has a *Send Email* button on its review page (the backend refuses it too): it
goes out in an edition.

## The email

One builder (`backend/src/services/newsletterEmail.ts`) makes the preview, the test, the send and the web page, so
they match. It follows the July 2026 issue's look and tidies it: brown masthead and gold-brown section headings,
"All the Dust that Fits Under Your Hat • #N", a short rule, photos at column width with a right-aligned credit,
link lists, a button for Read more, the sand-coloured calendar table with a brown border, small grey footnotes, a
"View this edition in your browser" link (dropped from the web copy) and a link to past editions. "In this issue"
appears from four sections. Inline styles and tables only; every value escaped, every URL checked. The preview warns
about empty sections, missing Read more pages and size near Gmail's ~100 KB clipping limit.

## Storage

| Key | What |
|---|---|
| `newsletter_editions/<id>` | the edition (`NewsletterEdition`, `backend/src/types.ts`) |
| `newsletter_sent/<number>` | the sent HTML and text, frozen |
| `newsletter_slugs/<slug>` | `{ submissionId }` for a Read more page |

Edits to one edition are applied one at a time in-process (the service runs as a single task). Saves name the
version they edited; a stale save gets a 409 and the editor offers "load theirs" or "keep mine". A save that changes
nothing keeps the version (and the approval).

## API

`/api/newsletter` (Comms Cadre by user type, role or the active list; Admins):
`GET/POST /editions`, `GET/PUT/DELETE /editions/:id`, `GET /tray`,
`POST /editions/:id/sections/from-submission`, `POST /editions/:id/sections/:sectionId/refresh`,
`GET /editions/:id/preview`, `POST /editions/:id/{submit,approve,override-approve,comments,send-test,send}`.

`/api/public` (no session): `GET /newsletter`, `GET /newsletter/:number`, `GET /news/:slug`.

## Frontend

- `components/CommsRequest.tsx` + `components/newsletter/NewsletterItemFields.tsx`, `KeyDatesEditor.tsx`
- Review page: `components/newsletter/NewsletterReviewPanel.tsx`
- `/newsletter/editions` (`pages/NewsletterEditions.tsx`), `/newsletter/editions/:id` (`pages/NewsletterEditor.tsx`):
  sections, calendar, autosave, preview, tray, approvals and comments, test send, send
- Public pages: `pages/PublicNewsletter.tsx`
- `components/newsletter/RichTextField.tsx`: a Lexical editor as a form field (fixed initial value; only real edits
  reach `onChange`, so opening a page never counts as an edit)

## Known limits

- The nav link and route guard look at `userType`/`roles`; someone who is only on the active Comms Cadre list (not
  by type or role) can use the API but won't see the link.
- No real-time co-editing of an edition: two editors at once get the conflict prompt on save.
- Images in an edition are referenced from the gallery (public, as before).

## Testing

- Backend: `test/services/newsletterEmail.test.ts`, `test/handlers/newsletter.test.ts`
- Frontend: `components/CommsRequest.test.tsx`, `pages/__tests__/NewsletterEditor.test.tsx`
- End to end: `tools/collab-e2e/newsletter.js` (see its README entry; uses a fake SES)
