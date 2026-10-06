# Annual dates

Requests, newsletter blurbs and key dates are full of dates that come round every year ("6pm - 10pm on
Sept. 1 2026"). Annual dates keep one table of these, with a rule for each, and show every request
that mentions one when its text is out of date.

## Rules

- An entry is `annual_dates/<id>` (`AnnualDate` in `backend/src/types.ts`) with a rule:
  - `{ kind: 'fixed', month, day }`: the same date every year. Feb 29 falls on Feb 28 in other years.
  - `{ kind: 'laborDay', offsetDays }`: whole days from Labor Day, the first Monday of September.
    The Man burns the Saturday before, which is always Labor Day − 2. The UI shows both
    ("6 days before Labor Day (4 days before the Burn)").
  - Optional `startTime`/`endTime` (wall-clock `HH:mm`, Pacific, never converted) and `durationDays`.
  - `overrides` by year, for a year when the date moved away from the rule.
- **Year:** an occurrence's year is its calendar year (Labor Day's year), not the Comms Calendar's
  Sep→Aug cycle. Sept 1 2026 and Aug 31 2027 are the same event in different years.
- **Example:** Sept 1 2026 is Labor Day (Sep 7) − 6. In 2027 that is Sep 6 − 6 = Tue Aug 31 2027, at
  the same times.
- **Code:** the pure functions are in `backend/src/utils/annualDates.ts`, mirrored in
  `frontend/src/utils/annualDates.ts`, and the two have the same tests.

## Finding dates

- `frontend/src/utils/dateDetection.ts` runs chrono-node's strict parser over the plain text of the
  body and blurb.
  - Only real dates count, so "today", "Friday" and "next week" are ignored.
  - Times and ranges are read as well.
- There is no editor node and no text transform. The review editor runs Yjs plus tracked changes,
  and the email renderer would need every new node type.

## Links, never live dates

- A request stores `dateLinks` (`{annualDateId, field: 'body'|'blurb', text, year}`) through
  `PUT /api/content/submissions/:id/date-links`.
- A key date stores `annualDateId`.
- The text and `KeyDate.date` stay exactly as written. Approvals count for a version, so a change to
  the table must never change approved content by itself.
- "Dates in this request" (`components/dates/DatesPanel.tsx`, on the request form and the review page)
  compares each linked date with the entry's next occurrence on or after Publish By (else today):
  - **Right for <year>**
  - **<year>: <date>, Update text**: rewrites the date in the style it was written in
    (`rewriteDate`), leaving words and times alone.
    - In the body it selects the text, presses Backspace and types, so the review editor records a
      tracked change. An approved request goes back to review.
    - In the blurb it is an unsaved edit to the newsletter item.
  - If the times changed, the panel says so, and they are edited by hand.
- **Untracked dates:**
  - "Looks like <entry>" appears when an entry falls on that day; this is the next-year workflow,
    where last year's text is pasted in.
  - **Track every year…** opens a dialog that defaults to a Labor Day rule within 45 days of Labor Day.

## Access

- Anyone signed in lists entries, and adds one by tracking a date.
- Comms Calendar editors (Admins, Comms Cadre, the Communications Manager) change and delete any entry.
  Whoever added an entry may change it too.
- The table is the **Annual dates** tab on `/comms-calendar`.
