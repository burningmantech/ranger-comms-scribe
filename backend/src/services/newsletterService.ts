import { createHash } from 'crypto';
import {
  ContentComment,
  ContentSubmission,
  EditionApproval,
  NewsletterEdition,
  NewsletterSection,
  User,
} from '../types';
import { Env } from '../utils/sessionManager';
import { getObject, getObjectStrict, putObject, deleteObject, listObjects } from './cacheService';
import { getTrackedChanges } from './trackedChangesService';
import { approvedDocument, approvedFieldValue, validReplyTo } from './announcementEmail';
import { renderContentForEmail } from '../utils/lexicalEmail';
import { audienceKeys, STANDALONE_EMAIL_AUDIENCES } from '../utils/audiences';
import {
  buildNewsletterEmail,
  calendarEntries,
  CalendarEntry,
  DEFAULT_EDITION_TAGLINE,
  DEFAULT_EDITION_TITLE,
  NewsletterEmail,
} from './newsletterEmail';
import {
  InputError,
  cleanCalendar,
  cleanRichText,
  cleanSections,
  cleanStringList,
  cleanText,
} from '../utils/newsletterInput';
import { getActiveCommsCadreEmails, getCommsManagerEmails, isAdminUser, isCommsCadre, isCommsManager } from './commsCadreService';

/**
 * Newsletter editions ("Black Rock Ranger News"): built by the Comms Cadre from approved
 * requests whose audience includes the newsletter, plus their own sections; approved by a
 * Comms Cadre member and the Council Communications Manager; sent to Announce.
 *
 * Storage:
 *   newsletter_editions/<id>   the edition (NewsletterEdition)
 *   newsletter_sent/<number>   what was sent, frozen: { number, editionId, subject, sentAt, html, text }
 *   newsletter_slugs/<slug>    { submissionId }: the public "Read more" page of a request's document
 *
 * Requests record where they went (newsletterEditionId, newsletterSentIn) and their public
 * page (publicSlug, publicPublishedAt); this service is the only writer of those fields.
 */

export const EDITION_PREFIX = 'newsletter_editions/';
export const SENT_PREFIX = 'newsletter_sent/';
export const SLUG_PREFIX = 'newsletter_slugs/';
/** Issues before this app were made by hand; #10 went out in July 2026. */
export const FIRST_EDITION_NUMBER = 11;
/** Dates in the calendar are the Rangers' local dates. */
const TIME_ZONE = 'America/Los_Angeles';

export class ServiceError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface SentEdition {
  number: number;
  editionId: string;
  subject: string;
  sentAt: string;
  html: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Today's date (YYYY-MM-DD) in Black Rock City's time zone. */
export function todayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The site's origin: FRONTEND_URL, else PUBLIC_URL's origin (in AWS they're the same). */
export function siteOrigin(env: Env): string | null {
  for (const candidate of [env.FRONTEND_URL, env.PUBLIC_URL]) {
    if (!candidate) continue;
    try {
      return new URL(candidate).origin;
    } catch {
      // try the next
    }
  }
  return null;
}

export function documentPageUrl(env: Env, slug: string): string | null {
  const origin = siteOrigin(env);
  return origin ? `${origin}/news/${encodeURIComponent(slug)}` : null;
}

export function editionPageUrl(env: Env, number: number): string | null {
  const origin = siteOrigin(env);
  return origin ? `${origin}/newsletter/${number}` : null;
}

export function archivePageUrl(env: Env): string | null {
  const origin = siteOrigin(env);
  return origin ? `${origin}/newsletter` : null;
}

const editionKey = (id: string) => `${EDITION_PREFIX}${id}`;
const submissionKey = (id: string) => `content_submissions/${id}`;
const userKey = (user: User) => user.id || user.email;

/**
 * Edits to one edition are applied one at a time (each is a read, then a write, with awaits
 * in between). The service runs as a single process, so an in-memory queue is enough.
 */
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  }).catch(() => undefined);
  return next;
}

/** Plain text of a blurb or body (Lexical JSON or text). */
function plainText(content: string | undefined): string {
  return renderContentForEmail(content || '').text.trim();
}

function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base || 'announcement';
}

function randomSuffix(): string {
  return createHash('sha256').update(crypto.randomUUID()).digest('hex').slice(0, 6);
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** Comms Cadre or Admin: may build and send editions. */
export async function canManageNewsletter(user: User | undefined, env: Env): Promise<boolean> {
  if (!user) return false;
  return isAdminUser(user, env) || isCommsCadre(user, env);
}

/** Editors plus the Communications Manager: may open editions, comment and approve. */
export async function canReviewNewsletter(user: User | undefined, env: Env): Promise<boolean> {
  if (!user) return false;
  return (await canManageNewsletter(user, env)) || isCommsManager(user, env);
}

// ---------------------------------------------------------------------------
// Editions
// ---------------------------------------------------------------------------

export async function listEditions(env: Env): Promise<NewsletterEdition[]> {
  const listing = await listObjects(EDITION_PREFIX, env);
  const editions = await Promise.all(
    (listing?.objects || []).map((o: { key: string }) => getObject<NewsletterEdition>(o.key, env)),
  );
  return (editions.filter(Boolean) as NewsletterEdition[]).sort((a, b) => b.number - a.number);
}

export async function getEdition(id: string, env: Env): Promise<NewsletterEdition | null> {
  return getObjectStrict<NewsletterEdition>(editionKey(id), env);
}

async function requireEdition(id: string, env: Env): Promise<NewsletterEdition> {
  const edition = await getEdition(id, env);
  if (!edition) throw new ServiceError(404, 'Edition not found');
  return edition;
}

async function listSentNumbers(env: Env): Promise<number[]> {
  const listing = await listObjects(SENT_PREFIX, env);
  return (listing?.objects || [])
    .map((o: { key: string }) => Number(o.key.slice(SENT_PREFIX.length)))
    .filter((n: number) => Number.isInteger(n));
}

/** The next free number: one past the highest edition or sent issue (at least #11). */
export async function nextEditionNumber(env: Env, editions?: NewsletterEdition[]): Promise<number> {
  const all = editions || await listEditions(env);
  const highest = Math.max(FIRST_EDITION_NUMBER - 1, ...all.map((e) => e.number), ...(await listSentNumbers(env)));
  return highest + 1;
}

async function assertNumberFree(number: number, editionId: string, env: Env): Promise<void> {
  if (!Number.isInteger(number) || number < 1 || number > 100000) {
    throw new ServiceError(400, 'The edition number must be a whole number');
  }
  const editions = await listEditions(env);
  const clash = editions.find((e) => e.id !== editionId && e.number === number);
  if (clash) throw new ServiceError(409, `Edition #${number} already exists`);
  const sent = await getObject<SentEdition>(`${SENT_PREFIX}${number}`, env);
  if (sent && sent.editionId !== editionId) throw new ServiceError(409, `Issue #${number} has already been sent`);
}

export async function createEdition(
  input: { number?: unknown; subject?: unknown },
  user: User,
  env: Env,
): Promise<NewsletterEdition> {
  return serialized('newsletter:create', async () => {
    const editions = await listEditions(env);
    const number = input.number !== undefined && input.number !== null && input.number !== ''
      ? Number(input.number)
      : await nextEditionNumber(env, editions);
    await assertNumberFree(number, '', env);

    // Standing dates (e.g. "Burning Man!") carry over from the latest edition while they're ahead
    const today = todayIso();
    const previous = editions[0];
    const carried = (previous?.calendar || [])
      .filter((row) => (row.endDate || row.date) >= today)
      .map((row) => ({ ...row, id: crypto.randomUUID() }));

    const now = new Date().toISOString();
    const edition: NewsletterEdition = {
      id: crypto.randomUUID(),
      number,
      title: previous?.title || DEFAULT_EDITION_TITLE,
      tagline: previous?.tagline || DEFAULT_EDITION_TAGLINE,
      subject: cleanText(input.subject, 'Subject', 200),
      sections: [],
      calendar: carried,
      calendarHidden: [],
      ...(previous?.footnotes ? { footnotes: previous.footnotes } : {}),
      ...(previous?.replyTo ? { replyTo: previous.replyTo } : {}),
      status: 'draft',
      version: 1,
      approvals: [],
      comments: [],
      createdBy: userKey(user),
      createdAt: now,
      updatedBy: userKey(user),
      updatedAt: now,
    };
    await putObject(editionKey(edition.id), edition, env);
    return edition;
  });
}

/** A content change: the version moves on, and an approved edition needs approving again. */
function touch(edition: NewsletterEdition, user: User): void {
  edition.version += 1;
  edition.updatedBy = userKey(user);
  edition.updatedAt = new Date().toISOString();
  if (edition.status === 'approved') {
    edition.status = 'in_review';
    delete edition.approvedVersion;
  }
}

function assertEditable(edition: NewsletterEdition): void {
  if (edition.status === 'sent') throw new ServiceError(409, 'This edition has been sent and can no longer change');
}

function assertVersion(edition: NewsletterEdition, expected: unknown): void {
  if (Number(expected) !== edition.version) {
    throw new ServiceError(409, 'Someone else saved this edition. Reload to see their changes.', {
      conflict: true,
      edition,
    });
  }
}

const EDITABLE_FIELDS = ['number', 'title', 'tagline', 'subject', 'intro', 'sections', 'calendar', 'calendarHidden', 'footnotes', 'replyTo'] as const;

export async function updateEdition(id: string, patch: any, user: User, env: Env): Promise<NewsletterEdition> {
  return serialized(editionKey(id), async () => {
    const edition = await requireEdition(id, env);
    assertEditable(edition);
    assertVersion(edition, patch?.version);
    if (!EDITABLE_FIELDS.some((f) => patch && f in patch)) return edition;
    const before = JSON.stringify(EDITABLE_FIELDS.map((f) => edition[f] ?? null));

    try {
      if ('number' in patch) {
        const number = Number(patch.number);
        if (number !== edition.number) {
          await assertNumberFree(number, edition.id, env);
          edition.number = number;
        }
      }
      if ('title' in patch) edition.title = cleanText(patch.title, 'Title', 120) || DEFAULT_EDITION_TITLE;
      if ('tagline' in patch) edition.tagline = cleanText(patch.tagline, 'Tagline', 200);
      if ('subject' in patch) edition.subject = cleanText(patch.subject, 'Subject', 200);
      if ('intro' in patch) edition.intro = cleanRichText(patch.intro, 'Intro');
      if ('footnotes' in patch) edition.footnotes = cleanRichText(patch.footnotes, 'Footnotes');
      if ('replyTo' in patch) {
        const replyTo = cleanText(patch.replyTo, 'Reply-To', 300);
        if (replyTo && !validReplyTo(replyTo)) throw new InputError('Reply-To must be an email address');
        edition.replyTo = replyTo;
      }
      if ('calendar' in patch) edition.calendar = cleanCalendar(patch.calendar);
      if ('calendarHidden' in patch) edition.calendarHidden = cleanStringList(patch.calendarHidden, 'Hidden calendar rows');
      if ('sections' in patch) await replaceSections(edition, patch.sections, env);
    } catch (err) {
      if (err instanceof InputError) throw new ServiceError(400, err.message);
      throw err;
    }

    // A save that changes nothing keeps the version (and so any approval of it)
    if (JSON.stringify(EDITABLE_FIELDS.map((f) => edition[f] ?? null)) === before) return edition;
    touch(edition, user);
    await putObject(editionKey(edition.id), edition, env);
    return edition;
  });
}

/**
 * New sections from the editor. A section's source (the request it came from) is kept from
 * the stored section with the same id and never taken from the client; requests whose
 * section was removed are released back to the tray.
 */
async function replaceSections(edition: NewsletterEdition, input: unknown, env: Env): Promise<void> {
  const cleaned = cleanSections(input);
  const before = new Map(edition.sections.map((s) => [s.id, s]));
  const sections: NewsletterSection[] = cleaned.map((s) => {
    const previous = before.get(s.id);
    return previous?.sourceSubmissionId
      ? { ...s, kind: 'item', sourceSubmissionId: previous.sourceSubmissionId, sourceHash: previous.sourceHash }
      : { ...s, kind: 'custom' };
  });

  // Read more pages: every linked document gets a slug now, so the preview shows its address
  for (const section of sections) {
    if (section.readMore.kind === 'document' && section.readMore.submissionId) {
      const ok = await ensurePublicSlug(section.readMore.submissionId, env);
      if (!ok) throw new InputError(`"${section.heading || 'A section'}" links to a request that doesn't exist`);
    }
  }

  const kept = new Set(sections.map((s) => s.sourceSubmissionId).filter(Boolean));
  for (const previous of edition.sections) {
    if (previous.sourceSubmissionId && !kept.has(previous.sourceSubmissionId)) {
      await setPlacement(previous.sourceSubmissionId, edition.id, null, env);
    }
  }
  edition.sections = sections;
}

export async function deleteEdition(id: string, env: Env): Promise<void> {
  return serialized(editionKey(id), async () => {
    const edition = await requireEdition(id, env);
    if (edition.status === 'sent') throw new ServiceError(409, 'A sent edition cannot be deleted');
    for (const section of edition.sections) {
      if (section.sourceSubmissionId) await setPlacement(section.sourceSubmissionId, edition.id, null, env);
    }
    await deleteObject(editionKey(id), env);
  });
}

// ---------------------------------------------------------------------------
// Requests ↔ editions
// ---------------------------------------------------------------------------

async function updateSubmission(
  id: string,
  env: Env,
  change: (submission: ContentSubmission) => boolean | void,
): Promise<ContentSubmission | null> {
  return serialized(submissionKey(id), async () => {
    const submission = await getObjectStrict<ContentSubmission>(submissionKey(id), env);
    if (!submission) return null;
    if (change(submission) === false) return submission;
    await putObject(submissionKey(id), submission, env);
    await deleteObject('content_submissions/list', env);
    return submission;
  });
}

/** Mark a request as placed in `editionId` (or released from `fromEditionId` when null). */
async function setPlacement(submissionId: string, fromEditionId: string, editionId: string | null, env: Env): Promise<void> {
  await updateSubmission(submissionId, env, (submission) => {
    if (editionId) {
      submission.newsletterEditionId = editionId;
      return true;
    }
    if (submission.newsletterEditionId !== fromEditionId) return false;
    delete submission.newsletterEditionId;
    return true;
  });
}

/** Give a request a public page address (not yet published). False if there's no such request. */
export async function ensurePublicSlug(submissionId: string, env: Env): Promise<boolean> {
  const submission = await updateSubmission(submissionId, env, (s) => {
    if (s.publicSlug) return false;
    s.publicSlug = `${slugify(s.title || '')}-${randomSuffix()}`;
    return true;
  });
  if (!submission?.publicSlug) return false;
  const existing = await getObject<{ submissionId: string }>(`${SLUG_PREFIX}${submission.publicSlug}`, env);
  if (!existing) await putObject(`${SLUG_PREFIX}${submission.publicSlug}`, { submissionId }, env);
  return true;
}

/** Publish a request's document page (its slug is made first if needed). */
export async function publishDocumentPage(submissionId: string, env: Env): Promise<string | null> {
  if (!(await ensurePublicSlug(submissionId, env))) return null;
  const submission = await updateSubmission(submissionId, env, (s) => {
    if (s.publicPublishedAt) return false;
    s.publicPublishedAt = new Date().toISOString();
    return true;
  });
  return submission?.publicSlug || null;
}

function sourceHash(submission: ContentSubmission, title: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ title, newsletter: submission.newsletter || null, keyDates: submission.keyDates || [] }))
    .digest('hex')
    .slice(0, 16);
}

async function approvedTitle(submission: ContentSubmission, env: Env): Promise<string> {
  const changes = await getTrackedChanges(submission.id, env);
  return approvedFieldValue(changes, 'title', submission.title || '').replace(/\s+/g, ' ').trim();
}

/** A request's newsletter item as an edition section (a copy: edits never go back to the request). */
async function snapshotSection(submission: ContentSubmission, sectionId: string, env: Env, important?: boolean): Promise<NewsletterSection> {
  const title = await approvedTitle(submission, env);
  const request = submission.newsletter;
  let body = request?.blurb || '';
  if (!plainText(body)) {
    // No blurb (an older request, or one still to be written): start from the full document
    body = await approvedDocument(submission, await getTrackedChanges(submission.id, env), env);
  }
  const readMore = request?.readMore?.kind === 'document'
    ? { kind: 'document' as const, submissionId: submission.id, ...(request.readMore.label ? { label: request.readMore.label } : {}) }
    : request?.readMore?.kind === 'url' && request.readMore.url
      ? { kind: 'url' as const, url: request.readMore.url, ...(request.readMore.label ? { label: request.readMore.label } : {}) }
      : { kind: 'none' as const };
  return {
    id: sectionId,
    kind: 'item',
    sourceSubmissionId: submission.id,
    sourceHash: sourceHash(submission, title),
    heading: request?.headline || title,
    ...(important ? { important: true } : {}),
    body,
    photos: [...(request?.photos || [])],
    links: [...(request?.links || [])],
    readMore,
    keyDates: [...(submission.keyDates || [])],
  };
}

function isNewsletterRequest(submission: ContentSubmission, changes: Parameters<typeof audienceKeys>[1] = []): boolean {
  return audienceKeys(submission, changes).includes('newsletter');
}

export async function addSubmissionSection(editionId: string, submissionId: string, user: User, env: Env): Promise<NewsletterEdition> {
  return serialized(editionKey(editionId), async () => {
    const edition = await requireEdition(editionId, env);
    assertEditable(edition);
    const submission = await getObjectStrict<ContentSubmission>(submissionKey(submissionId), env);
    if (!submission) throw new ServiceError(404, 'Request not found');
    if (submission.status !== 'approved' && submission.status !== 'sent') {
      throw new ServiceError(409, 'Only approved requests can go in an edition');
    }
    if (submission.newsletterSentIn) {
      throw new ServiceError(409, `This item already went out in issue #${submission.newsletterSentIn}`);
    }
    if (edition.sections.some((s) => s.sourceSubmissionId === submissionId)) {
      throw new ServiceError(409, 'This item is already in this edition');
    }
    if (submission.newsletterEditionId && submission.newsletterEditionId !== editionId) {
      const other = await getEdition(submission.newsletterEditionId, env);
      if (other && other.status !== 'sent') throw new ServiceError(409, `This item is already in edition #${other.number}`);
    }

    const section = await snapshotSection(submission, crypto.randomUUID(), env);
    edition.sections.push(section);
    if (section.readMore.kind === 'document') await ensurePublicSlug(submissionId, env);
    await setPlacement(submissionId, editionId, editionId, env);
    touch(edition, user);
    await putObject(editionKey(edition.id), edition, env);
    return edition;
  });
}

/** Copy the request's current newsletter item over the section (its id and Important flag stay). */
export async function refreshSection(editionId: string, sectionId: string, user: User, env: Env): Promise<NewsletterEdition> {
  return serialized(editionKey(editionId), async () => {
    const edition = await requireEdition(editionId, env);
    assertEditable(edition);
    const index = edition.sections.findIndex((s) => s.id === sectionId);
    if (index < 0) throw new ServiceError(404, 'Section not found');
    const current = edition.sections[index];
    if (!current.sourceSubmissionId) throw new ServiceError(400, 'This section was not made from a request');
    const submission = await getObjectStrict<ContentSubmission>(submissionKey(current.sourceSubmissionId), env);
    if (!submission) throw new ServiceError(404, 'The request no longer exists');
    edition.sections[index] = await snapshotSection(submission, current.id, env, current.important);
    if (edition.sections[index].readMore.kind === 'document') await ensurePublicSlug(submission.id, env);
    touch(edition, user);
    await putObject(editionKey(edition.id), edition, env);
    return edition;
  });
}

export interface SectionSource {
  submissionId: string;
  title: string;
  status: ContentSubmission['status'] | 'missing';
  /** The request's newsletter item changed since the section was made or refreshed. */
  changed: boolean;
}

/** For the editor: each request-made section's source request and whether it has changed. */
export async function sectionSources(edition: NewsletterEdition, env: Env): Promise<Record<string, SectionSource>> {
  const out: Record<string, SectionSource> = {};
  await Promise.all(edition.sections.map(async (section) => {
    if (!section.sourceSubmissionId) return;
    const submission = await getObject<ContentSubmission>(submissionKey(section.sourceSubmissionId), env);
    if (!submission) {
      out[section.id] = { submissionId: section.sourceSubmissionId, title: '', status: 'missing', changed: false };
      return;
    }
    const title = await approvedTitle(submission, env);
    out[section.id] = {
      submissionId: submission.id,
      title,
      status: submission.status,
      changed: edition.status !== 'sent' && sourceHash(submission, title) !== section.sourceHash,
    };
  }));
  return out;
}

export interface TrayItem {
  id: string;
  title: string;
  status: ContentSubmission['status'];
  submittedAt: string;
  publishBy?: string;
  headline: string;
  hasBlurb: boolean;
  photoCount: number;
  keyDateCount: number;
  readMore: 'none' | 'document' | 'url';
  writingHelp: { document: boolean; blurb: boolean };
}

/**
 * Requests for the newsletter that are in no edition yet: approved ones are ready to add,
 * ones still in review are coming. Scans every request (as the request list does).
 */
export async function getTray(env: Env): Promise<{ ready: TrayItem[]; upcoming: TrayItem[] }> {
  const listing = await listObjects('content_submissions/', env);
  const editions = new Map((await listEditions(env)).map((e) => [e.id, e]));
  const submissions = await Promise.all(
    (listing?.objects || [])
      .filter((o: { key: string }) => o.key !== 'content_submissions/list')
      .map((o: { key: string }) => getObject<ContentSubmission>(o.key, env)),
  );
  const ready: TrayItem[] = [];
  const upcoming: TrayItem[] = [];
  for (const submission of submissions as (ContentSubmission | null)[]) {
    if (!submission || !submission.id) continue;
    if (!['submitted', 'in_review', 'approved', 'sent'].includes(submission.status)) continue;
    if (submission.newsletterSentIn) continue;
    const placedIn = submission.newsletterEditionId ? editions.get(submission.newsletterEditionId) : undefined;
    if (placedIn && placedIn.sections.some((s) => s.sourceSubmissionId === submission.id)) continue;
    const changes = await getTrackedChanges(submission.id, env);
    if (!isNewsletterRequest(submission, changes)) continue;
    const title = approvedFieldValue(changes, 'title', submission.title || '').replace(/\s+/g, ' ').trim();
    const publishBy = (submission.formFields || []).find((f) => f.id === 'publishBy')?.value;
    const item: TrayItem = {
      id: submission.id,
      title,
      status: submission.status,
      submittedAt: submission.submittedAt,
      ...(typeof publishBy === 'string' && publishBy ? { publishBy } : {}),
      headline: submission.newsletter?.headline || title,
      hasBlurb: !!plainText(submission.newsletter?.blurb),
      photoCount: submission.newsletter?.photos?.length || 0,
      keyDateCount: submission.keyDates?.length || 0,
      readMore: submission.newsletter?.readMore?.kind || 'none',
      writingHelp: { document: !!submission.writingHelp?.document, blurb: !!submission.writingHelp?.blurb },
    };
    (submission.status === 'approved' || submission.status === 'sent' ? ready : upcoming).push(item);
  }
  const byDate = (a: TrayItem, b: TrayItem) => (a.submittedAt || '').localeCompare(b.submittedAt || '');
  return { ready: ready.sort(byDate), upcoming: upcoming.sort(byDate) };
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export interface ApprovalState {
  version: number;
  commsCadre: { met: boolean; by?: string };
  commsManager: { met: boolean; by?: string };
  rejectedBy: string[];
  override: boolean;
}

/**
 * Who counts for each gate now: people with Comms Cadre, and people with the Communications
 * Manager council role (People page). An approval counts for a gate if the approver held the
 * role when they approved or holds it now, so giving someone the role afterwards doesn't make
 * them approve again.
 */
export interface ApprovalMembership {
  cadreEmails: Set<string>;
  managerEmails: Set<string>;
  managers: Array<{ name: string; email: string }>;
}

export async function loadApprovalMembership(env: Env): Promise<ApprovalMembership> {
  const { commsCadrePeople, commsManagerPeople } = await import('./peopleService');
  const [cadre, managers] = await Promise.all([commsCadrePeople(env), commsManagerPeople(env)]);
  return {
    cadreEmails: new Set(cadre.map((p) => p.email.trim().toLowerCase())),
    managerEmails: new Set(managers.map((p) => p.email.trim().toLowerCase())),
    managers: managers.map((p) => ({ name: p.name, email: p.email })),
  };
}

const EMPTY_MEMBERSHIP: ApprovalMembership = { cadreEmails: new Set(), managerEmails: new Set(), managers: [] };

/** The decisions that count: each person's latest, for the current version. */
function currentDecisions(edition: NewsletterEdition): EditionApproval[] {
  const latest = new Map<string, EditionApproval>();
  for (const a of edition.approvals) {
    if (a.version !== edition.version) continue;
    const key = (a.approverEmail || a.approverId).toLowerCase();
    const previous = latest.get(key);
    if (!previous || a.createdAt >= previous.createdAt) latest.set(key, a);
  }
  return Array.from(latest.values());
}

export function approvalState(edition: NewsletterEdition, membership: ApprovalMembership = EMPTY_MEMBERSHIP): ApprovalState {
  const decisions = currentDecisions(edition);
  const approved = decisions.filter((a) => a.status === 'approved');
  const email = (a: EditionApproval) => (a.approverEmail || '').trim().toLowerCase();
  const cadre = approved.find((a) => a.asCommsCadre || membership.cadreEmails.has(email(a)));
  const manager = approved.find((a) => a.asCommsManager || membership.managerEmails.has(email(a)));
  return {
    version: edition.version,
    commsCadre: { met: !!cadre, ...(cadre ? { by: cadre.approverName || cadre.approverEmail } : {}) },
    commsManager: { met: !!manager, ...(manager ? { by: manager.approverName || manager.approverEmail } : {}) },
    rejectedBy: decisions.filter((a) => a.status === 'rejected').map((a) => a.approverName || a.approverEmail),
    override: !!edition.approvalOverride && edition.approvalOverride.version === edition.version,
  };
}

/**
 * Approved when, for the current version, a Comms Cadre member and the Communications Manager
 * have approved and nobody has asked for changes (one person who is both counts for both,
 * as with requests), or after an override.
 */
function recomputeStatus(edition: NewsletterEdition, membership: ApprovalMembership): void {
  if (edition.status === 'sent') return;
  const state = approvalState(edition, membership);
  const approved = state.override || (state.commsCadre.met && state.commsManager.met && state.rejectedBy.length === 0);
  if (approved) {
    edition.status = 'approved';
    edition.approvedVersion = edition.version;
  } else if (edition.status === 'approved') {
    edition.status = 'in_review';
    delete edition.approvedVersion;
  }
}

/**
 * Bring an edition's status up to date with who is in the Comms Cadre and Communications
 * Manager lists now (e.g. the approver was made Communications Manager after approving).
 * Writes only when the status changes.
 */
export async function reconcileApproval(edition: NewsletterEdition, membership: ApprovalMembership, env: Env): Promise<NewsletterEdition> {
  if (edition.status !== 'in_review' && edition.status !== 'approved') return edition;
  const probe: NewsletterEdition = { ...edition };
  recomputeStatus(probe, membership);
  if (probe.status === edition.status) return edition;
  return serialized(editionKey(edition.id), async () => {
    const fresh = await requireEdition(edition.id, env);
    if (fresh.status !== 'in_review' && fresh.status !== 'approved') return fresh;
    const before = fresh.status;
    recomputeStatus(fresh, membership);
    if (fresh.status !== before) await putObject(editionKey(fresh.id), fresh, env);
    return fresh;
  });
}

export async function submitForApproval(id: string, user: User, env: Env): Promise<NewsletterEdition> {
  const edition = await serialized(editionKey(id), async () => {
    const e = await requireEdition(id, env);
    assertEditable(e);
    if (e.status !== 'draft') return e;
    e.status = 'in_review';
    e.updatedAt = new Date().toISOString();
    recomputeStatus(e, await loadApprovalMembership(env));
    await putObject(editionKey(e.id), e, env);
    return e;
  });
  await notifyReviewers(edition, user, env);
  return edition;
}

async function notifyReviewers(edition: NewsletterEdition, actor: User, env: Env): Promise<void> {
  try {
    const { createInAppNotification } = await import('./notificationService');
    const { getUser } = await import('./userService');
    const emails = new Set([...(await getCommsManagerEmails(env)), ...(await getActiveCommsCadreEmails(env))]);
    emails.delete((actor.email || '').toLowerCase());
    for (const email of emails) {
      const recipient = await getUser(email, env);
      if (!recipient) continue;
      await createInAppNotification({
        userId: recipient.id,
        type: 'newsletter_review',
        title: `Ranger News #${edition.number} is ready for approval`,
        message: `${actor.name || actor.email} asked for approval of "${edition.subject || `Ranger News #${edition.number}`}".`,
        actorName: actor.name || actor.email,
        link: `/newsletter/editions/${edition.id}`,
      }, env);
    }
  } catch (err) {
    console.error('Could not notify newsletter reviewers:', err);
  }
}

export async function decideEdition(
  id: string,
  input: { status?: unknown; comment?: unknown; version?: unknown },
  user: User,
  env: Env,
): Promise<NewsletterEdition> {
  const status = input.status === 'rejected' ? 'rejected' : input.status === 'approved' ? 'approved' : null;
  if (!status) throw new ServiceError(400, 'status must be approved or rejected');
  const [asCommsCadre, asCommsManager] = await Promise.all([isCommsCadre(user, env), isCommsManager(user, env)]);
  if (!asCommsCadre && !asCommsManager) {
    throw new ServiceError(403, 'Only the Comms Cadre and the Communications Manager can approve editions');
  }
  return serialized(editionKey(id), async () => {
    const edition = await requireEdition(id, env);
    assertEditable(edition);
    // The decision is about the version on the approver's screen
    if (input.version !== undefined) assertVersion(edition, input.version);
    const comment = cleanText(input.comment, 'Comment', 2000);
    edition.approvals.push({
      id: crypto.randomUUID(),
      approverId: user.id,
      approverEmail: user.email,
      approverName: user.name,
      asCommsCadre,
      asCommsManager,
      status,
      ...(comment ? { comment } : {}),
      version: edition.version,
      createdAt: new Date().toISOString(),
    });
    if (comment) edition.comments.push(makeComment(edition.id, `${status === 'approved' ? 'Approved' : 'Changes requested'}: ${comment}`, user));
    if (edition.status === 'draft') edition.status = 'in_review';
    recomputeStatus(edition, await loadApprovalMembership(env));
    await putObject(editionKey(edition.id), edition, env);
    return edition;
  });
}

export async function overrideApproval(id: string, input: { reason?: unknown; version?: unknown }, user: User, env: Env): Promise<NewsletterEdition> {
  if (!isAdminUser(user) && !(await isCommsManager(user, env))) {
    throw new ServiceError(403, 'Only an Admin or the Communications Manager can override');
  }
  const reason = cleanText(input.reason, 'Reason', 1000);
  if (!reason) throw new ServiceError(400, 'Give a reason for the override');
  return serialized(editionKey(id), async () => {
    const edition = await requireEdition(id, env);
    assertEditable(edition);
    if (input.version !== undefined) assertVersion(edition, input.version);
    edition.approvalOverride = { by: userKey(user), byName: user.name || user.email, reason, at: new Date().toISOString(), version: edition.version };
    edition.comments.push(makeComment(edition.id, `Approval override: ${reason}`, user));
    recomputeStatus(edition, await loadApprovalMembership(env));
    await putObject(editionKey(edition.id), edition, env);
    return edition;
  });
}

function makeComment(editionId: string, content: string, user: User): ContentComment {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    submissionId: editionId,
    content,
    authorId: user.id,
    authorName: user.name || user.email,
    createdAt: now,
    updatedAt: now,
    isSuggestion: false,
    resolved: false,
  };
}

export async function addComment(id: string, content: unknown, user: User, env: Env): Promise<NewsletterEdition> {
  const text = cleanText(content, 'Comment', 4000);
  if (!text) throw new ServiceError(400, 'The comment is empty');
  return serialized(editionKey(id), async () => {
    const edition = await requireEdition(id, env);
    edition.comments.push(makeComment(edition.id, text, user));
    await putObject(editionKey(edition.id), edition, env);
    return edition;
  });
}

// ---------------------------------------------------------------------------
// Rendering and sending
// ---------------------------------------------------------------------------

/** Public page addresses of the documents an edition links to (null where there is none). */
async function documentUrls(edition: NewsletterEdition, env: Env, requirePublished: boolean): Promise<Map<string, string | null>> {
  const urls = new Map<string, string | null>();
  for (const section of edition.sections) {
    const id = section.readMore.kind === 'document' ? section.readMore.submissionId : undefined;
    if (!id || urls.has(id)) continue;
    const submission = await getObject<ContentSubmission>(submissionKey(id), env);
    const usable = submission?.publicSlug && (!requirePublished || submission.publicPublishedAt);
    urls.set(id, usable ? documentPageUrl(env, submission!.publicSlug!) : null);
  }
  return urls;
}

export async function renderEdition(edition: NewsletterEdition, env: Env, asOf: string = todayIso()): Promise<NewsletterEmail> {
  const urls = await documentUrls(edition, env, false);
  return buildNewsletterEmail(edition, {
    publicUrl: env.PUBLIC_URL,
    asOf,
    webUrl: editionPageUrl(env, edition.number),
    archiveUrl: archivePageUrl(env),
    documentUrl: (id) => urls.get(id) ?? null,
  });
}

/** The calendar for the editor: every row, with whether it's hidden or already past. */
export function editorCalendar(edition: NewsletterEdition, asOf: string = todayIso()): Array<CalendarEntry & { hidden: boolean; past: boolean }> {
  const hidden = new Set(edition.calendarHidden || []);
  return calendarEntries(edition, asOf, { includePast: true, includeHidden: true }).map((e) => ({
    ...e,
    hidden: e.source === 'section' && hidden.has(e.key),
    past: (e.endDate || e.date) < asOf,
  }));
}

/** Problems that block sending: linked documents not approved, a missing subject. */
async function sendBlockers(edition: NewsletterEdition, env: Env): Promise<string[]> {
  const problems: string[] = [];
  if (!edition.subject.trim()) problems.push('The edition has no subject');
  if (edition.sections.length === 0) problems.push('The edition has no sections');
  for (const section of edition.sections) {
    const id = section.readMore.kind === 'document' ? section.readMore.submissionId : undefined;
    if (!id) continue;
    const submission = await getObject<ContentSubmission>(submissionKey(id), env);
    if (!submission || (submission.status !== 'approved' && submission.status !== 'sent')) {
      problems.push(`"${section.heading}" links to a document that isn't approved`);
    }
  }
  return problems;
}

export async function sendTestEdition(id: string, user: User, env: Env): Promise<{ to: string }> {
  const edition = await requireEdition(id, env);
  // The signed-in account's own address (dev accounts are user@localhost, so no TLD rule)
  if (!user.email || !/^[^\s@<>,;]+@[^\s@<>,;]+$/.test(user.email)) {
    throw new ServiceError(400, 'Your account has no email address to send a test to');
  }
  const email = await renderEdition(edition, env);
  const { sendEmail } = await import('../utils/email');
  const { embedGalleryImages } = await import('./announcementEmail');
  const embedded = await embedGalleryImages(email.html, env);
  await sendEmail(user.email, `[TEST] ${email.subject}`, email.text, env, {
    html: embedded.html,
    text: email.text,
    attachments: embedded.attachments,
    ...(edition.replyTo && validReplyTo(edition.replyTo) ? { replyTo: validReplyTo(edition.replyTo)! } : {}),
  });
  return { to: user.email };
}

export async function sendEdition(id: string, user: User, env: Env): Promise<NewsletterEdition> {
  const toAddress = env.ANNOUNCE_EMAIL_TO;
  if (!toAddress) throw new ServiceError(503, 'Announcement email address is not configured (ANNOUNCE_EMAIL_TO)');

  return serialized(editionKey(id), async () => {
    const edition = await requireEdition(id, env);
    if (edition.status === 'sent') throw new ServiceError(409, 'This edition has already been sent');
    if (edition.status !== 'approved' || edition.approvedVersion !== edition.version) {
      throw new ServiceError(409, 'The edition must be approved (in its current version) before it is sent');
    }
    await assertNumberFree(edition.number, edition.id, env);
    const blockers = await sendBlockers(edition, env);
    if (blockers.length) throw new ServiceError(409, blockers.join('; '), { blockers });

    // Publish the linked documents' pages first, so the links work when the email lands
    for (const section of edition.sections) {
      if (section.readMore.kind === 'document' && section.readMore.submissionId) {
        await publishDocumentPage(section.readMore.submissionId, env);
      }
    }

    const asOf = todayIso();
    const email = await renderEdition(edition, env, asOf);
    const { sendEmail } = await import('../utils/email');
    const { embedGalleryImages } = await import('./announcementEmail');
    const embedded = await embedGalleryImages(email.html, env);
    const replyTo = edition.replyTo ? validReplyTo(edition.replyTo) : null;
    await sendEmail(toAddress, email.subject, email.text, env, {
      html: embedded.html,
      text: email.text,
      attachments: embedded.attachments,
      ...(replyTo ? { replyTo } : {}),
    });

    const sentAt = new Date().toISOString();
    const sent: SentEdition = { number: edition.number, editionId: edition.id, subject: email.subject, sentAt, html: email.html, text: email.text };
    await putObject(`${SENT_PREFIX}${edition.number}`, sent, env);

    edition.status = 'sent';
    edition.sentAt = sentAt;
    edition.sentBy = userKey(user);
    await putObject(editionKey(edition.id), edition, env);

    for (const section of edition.sections) {
      if (!section.sourceSubmissionId) continue;
      const changes = await getTrackedChanges(section.sourceSubmissionId, env);
      await updateSubmission(section.sourceSubmissionId, env, (submission) => {
        submission.newsletterSentIn = edition.number;
        submission.newsletterEditionId = edition.id;
        // Done, unless it also goes out on its own (singular / allcom)
        const keys = audienceKeys(submission, changes);
        if (submission.status === 'approved' && !keys.some((k) => STANDALONE_EMAIL_AUDIENCES.has(k))) {
          submission.status = 'sent';
          submission.sentAt = sentAt;
          submission.sentBy = userKey(user);
        }
        return true;
      });
    }
    return edition;
  });
}

// ---------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------

export async function listSentEditions(env: Env): Promise<Array<Pick<SentEdition, 'number' | 'subject' | 'sentAt'>>> {
  const numbers = await listSentNumbers(env);
  const sent = await Promise.all(numbers.map((n) => getObject<SentEdition>(`${SENT_PREFIX}${n}`, env)));
  return (sent.filter(Boolean) as SentEdition[])
    .map(({ number, subject, sentAt }) => ({ number, subject, sentAt }))
    .sort((a, b) => b.number - a.number);
}

export async function getSentEdition(number: number, env: Env): Promise<SentEdition | null> {
  if (!Number.isInteger(number)) return null;
  return getObject<SentEdition>(`${SENT_PREFIX}${number}`, env);
}

/** A published document page's request, or null (unknown slug, or not published yet). */
export async function getPublishedDocument(slug: string, env: Env): Promise<ContentSubmission | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const entry = await getObject<{ submissionId: string }>(`${SLUG_PREFIX}${slug}`, env);
  if (!entry) return null;
  const submission = await getObject<ContentSubmission>(submissionKey(entry.submissionId), env);
  if (!submission || submission.publicSlug !== slug || !submission.publicPublishedAt) return null;
  if (submission.status !== 'approved' && submission.status !== 'sent') return null;
  return submission;
}
