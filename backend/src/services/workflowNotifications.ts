import { ContentSubmission, User } from '../types';
import { Env } from '../utils/sessionManager';
import { getObjectStrict, putObject } from './cacheService';
import { createInAppNotification } from './notificationService';
import { getUser, wantsSubmitterUpdates } from './userService';
import { commsCadrePeople, peopleByEmail } from './peopleService';
import { normalizeEmail } from './access';
import { getTrackedChanges } from './trackedChangesService';
import { audienceKeys, STANDALONE_EMAIL_AUDIENCES } from '../utils/audiences';
import { renderWorkflowEmail, requestDetails, requestLink, sendWorkflowEmail } from './workflowEmail';

/** When someone was first and last asked to act on a request (ISO times). */
export interface AskTimes {
  first: string;
  last: string;
}

/** Who was asked to act on a request, and when: `approval_asks/<submissionId>`, by lowercased email. */
export type AskLog = Record<string, AskTimes>;

/** The log as stored; older entries are one time, which is read as both first and last. */
type StoredAskLog = Record<string, AskTimes | string>;

function readLog(stored: StoredAskLog | null): AskLog {
  const log: AskLog = {};
  for (const [email, value] of Object.entries(stored || {})) {
    if (typeof value === 'string') log[email] = { first: value, last: value };
    else if (value && typeof value.last === 'string') log[email] = { first: value.first || value.last, last: value.last };
  }
  return log;
}

const askLogKey = (submissionId: string) => `approval_asks/${submissionId}`;

/** The ask log of a request (lowercased email to first and last ask). Empty when nobody was asked or it can't be read. */
export async function getAskLog(env: Env, submissionId: string): Promise<AskLog> {
  try {
    return readLog(await getObjectStrict<StoredAskLog>(askLogKey(submissionId), env));
  } catch (err) {
    console.error(`Could not read the ask log of ${submissionId}:`, err);
    return {};
  }
}

// Writes to one log run one after another in this process, so two asks can't lose each other's entries
const queues = new Map<string, Promise<unknown>>();

/** Note that these people were asked just now (or `at`); their first ask is kept. Failures are logged, never thrown. */
export async function recordAsked(env: Env, submissionId: string, emails: string[], at: string = new Date().toISOString()): Promise<void> {
  const previous = queues.get(submissionId) || Promise.resolve();
  const next = previous.then(async () => {
    try {
      const log = readLog(await getObjectStrict<StoredAskLog>(askLogKey(submissionId), env));
      for (const email of emails) {
        const key = (email || '').trim().toLowerCase();
        if (key) log[key] = { first: log[key]?.first || at, last: at };
      }
      await putObject(askLogKey(submissionId), log, env);
    } catch (err) {
      console.error(`Could not record the approval ask for ${submissionId}:`, err);
    }
  });
  queues.set(submissionId, next);
  await next;
  if (queues.get(submissionId) === next) queues.delete(submissionId);
}

/**
 * Thrown by `askForApproval` when the email couldn't be sent. The in-app notifications went out
 * anyway: `notified` are the lowercased emails that got one (people without an account get none).
 * The SES error is in `emailError` and the message; log it, never show it to the person.
 */
export class ApprovalEmailError extends Error {
  constructor(readonly notified: string[], readonly emailError: unknown) {
    super(`Could not email the approval request: ${emailError instanceof Error ? emailError.message : String(emailError)}`);
    this.name = 'ApprovalEmailError';
  }
}

/**
 * Ask people to approve a request: an email (through COMMS_EMAIL_OVERRIDE on dev and staging)
 * and an in-app notification each. `kind` 'added': they were just added as an approver;
 * 'reminder': someone reminded them; 'submitted': the request was just submitted.
 * The in-app notifications go out even when the email fails. Records when they were asked
 * (everyone when the email went out, else those the in-app notification reached), then throws
 * an `ApprovalEmailError` if the email couldn't be sent.
 */
export async function askForApproval(
  submission: ContentSubmission,
  emails: string[],
  actor: User,
  kind: 'added' | 'reminder' | 'submitted',
  env: Env
): Promise<void> {
  const by = actor.name || actor.email;
  const subject = kind === 'reminder'
    ? `Reminder: your approval is needed for "${submission.title}"`
    : `Your approval is needed for "${submission.title}"`;
  const said = kind === 'added'
    ? `${by} added you as an approver of "${submission.title}".`
    : kind === 'submitted'
      ? `${by} asked you to approve "${submission.title}".`
      : `${by} asked for your approval of "${submission.title}".`;

  const rendered = renderWorkflowEmail({
    heading: 'Your approval is needed',
    paragraphs: [said],
    details: await requestDetails(submission, env).catch(() => []),
    action: { label: 'Open the request', url: requestLink(env, submission.id) },
  });
  let emailError: unknown = null;
  try {
    await sendWorkflowEmail(env, emails, subject, rendered);
  } catch (err) {
    emailError = err ?? new Error('Email failed');
  }

  // The bell gets the ask whatever happened to the email
  const notified: string[] = [];
  for (const email of emails) {
    try {
      const person = await getUser(email, env).catch(() => null);
      if (!person) continue;
      const notification = await createInAppNotification({
        userId: person.email,
        type: 'submission_waiting',
        title: 'Your approval is needed',
        message: said,
        submissionId: submission.id,
        submissionTitle: submission.title,
        actorName: by,
      }, env);
      if (notification) notified.push(normalizeEmail(email));
    } catch (err) {
      console.error(`Could not add the approval notification for ${email}:`, err);
    }
  }

  // They were asked if either the email or the bell reached them (the digest waits from here)
  await recordAsked(env, submission.id, emailError ? notified : emails);
  if (emailError) throw new ApprovalEmailError(notified, emailError);
}

// =============================================================================
// A request is submitted
// =============================================================================

/** Whether a status change makes a request live: it leaves draft for submitted or in review. */
export function becomesSubmitted(before: string | undefined, after: string | undefined): boolean {
  return (!before || before === 'draft') && (after === 'submitted' || after === 'in_review');
}

/** Whether a new request is live from the start (the request form creates it in review). */
export function createdLive(status: string | undefined): boolean {
  return !!status && status !== 'draft' && status !== 'sent';
}

type Actor = { id?: string; email?: string; name?: string };

/** The person who submitted a request (`submittedBy` is usually a user id), or just their address. */
async function submitterOf(submission: ContentSubmission, env: Env): Promise<{ id?: string; email: string; name: string } | null> {
  const by = (submission.submittedBy || '').trim();
  if (!by) return null;
  const user = await getUser(by, env).catch(() => null);
  if (user?.email) return { id: user.id, email: normalizeEmail(user.email), name: user.name || user.email };
  return by.includes('@') ? { email: normalizeEmail(by), name: by } : null;
}

const isActor = (actor: Actor | undefined, submission: ContentSubmission, person: { id?: string; email: string }): boolean =>
  !!actor && (
    (!!actor.id && (actor.id === submission.submittedBy || actor.id === person.id)) ||
    (!!actor.email && normalizeEmail(actor.email) === person.email)
  );

/**
 * Tell the people who must act on a request that it was submitted: each listed approver is asked
 * to approve, and the Comms Cadre get one email (they give the Comms Cadre approval and pick a
 * council approver when none is listed). Never the submitter. Failures are logged, never thrown.
 * The caller decides it is time (once per request: `submittedNotifiedAt`).
 */
export async function notifyRequestSubmitted(submission: ContentSubmission, actor: Actor, env: Env): Promise<void> {
  try {
    const submitter = await submitterOf(submission, env);
    const submitterEmail = submitter?.email || '';
    const by = submitter?.name || actor.name || actor.email || 'Someone';

    const listed = Array.from(new Set((submission.requiredApprovers || []).map(normalizeEmail).filter(Boolean)))
      .filter((email) => email !== submitterEmail);
    if (listed.length > 0) {
      try {
        await askForApproval(submission, listed, { id: submitter?.id || '', email: submitterEmail, name: by } as User, 'submitted', env);
      } catch (err) {
        console.error(`Could not ask the approvers of ${submission.id}:`, err);
      }
    }

    const cadre = (await commsCadrePeople(env)).filter((p) => {
      const email = normalizeEmail(p.email);
      return email !== submitterEmail && !listed.includes(email);
    });
    if (cadre.length === 0) return;

    // Whether a council member is on the list (at submission there are no approvals to count)
    const allListed = (submission.requiredApprovers || []).map(normalizeEmail).filter(Boolean);
    const people = await peopleByEmail(allListed, env);
    const councilListed = allListed.some((email) => people.get(email)?.access.council);

    const paragraphs = [`${by} submitted a new request.`];
    if (!councilListed) paragraphs.push('No council approver is listed yet. Choose one on the review page.');
    const rendered = renderWorkflowEmail({
      heading: 'New request',
      paragraphs,
      details: await requestDetails(submission, env).catch(() => []),
      action: { label: 'Open the request', url: requestLink(env, submission.id) },
    });
    const emails = cadre.map((p) => normalizeEmail(p.email));
    let emailed = false;
    try {
      await sendWorkflowEmail(env, emails, `New request: "${submission.title}"`, rendered);
      emailed = true;
    } catch (err) {
      console.error(`Could not email the Comms Cadre about ${submission.id}:`, err);
    }
    const notified: string[] = [];
    for (const email of emails) {
      const notification = await createInAppNotification({
        userId: email,
        type: 'request_submitted',
        title: 'New request',
        message: `${by} submitted "${submission.title}".`,
        submissionId: submission.id,
        submissionTitle: submission.title,
        actorName: by,
      }, env);
      if (notification) notified.push(email);
    }
    // Only once they've been told (by email, else in the app): the reminder digest counts the wait from here
    await recordAsked(env, submission.id, emailed ? emails : notified);
  } catch (err) {
    console.error(`Could not tell people about the new request ${submission.id}:`, err);
  }
}

// =============================================================================
// Updates for the submitter
// =============================================================================

export type SubmitterEvent = 'changes_requested' | 'declined' | 'approved' | 'sent';

export interface SubmitterEventExtra {
  /** The reviewer's comment (changes_requested, declined). */
  comment?: string;
  /** The edition a request went out in (sent). */
  edition?: number;
}

const COMMENT_LIMIT = 1000;

/**
 * Tell the person who submitted a request what happened to it: an in-app notification always,
 * and an email unless they switched submitter updates off. Nothing when they did it themselves.
 * Failures are logged, never thrown.
 */
export async function notifySubmitter(
  submission: ContentSubmission,
  event: SubmitterEvent,
  actor: Actor | undefined,
  env: Env,
  extra: SubmitterEventExtra = {}
): Promise<void> {
  try {
    const submitter = await submitterOf(submission, env);
    if (!submitter || isActor(actor, submission, submitter)) return;

    const title = submission.title;
    const by = actor?.name || actor?.email || 'Someone';
    const comment = (extra.comment || '').trim().slice(0, COMMENT_LIMIT);
    const lists = (submission.sentTo || []).map((l) => l.name).filter(Boolean);

    let subject: string;
    let heading: string;
    let said: string;
    let more: string[] = [];
    let type: 'changes_requested' | 'rejection_received' | 'request_approved' | 'request_sent';
    let inAppTitle: string;
    switch (event) {
      case 'changes_requested':
        type = 'changes_requested';
        inAppTitle = 'Changes requested';
        subject = `Changes requested on "${title}"`;
        heading = 'Changes requested';
        said = `${by} requested changes on "${title}".`;
        if (comment) more = [`Their comment:\n${comment}`];
        break;
      case 'declined':
        type = 'rejection_received';
        inAppTitle = 'Not approved';
        subject = `${by} didn't approve "${title}"`;
        heading = "A request wasn't approved";
        said = `${by} didn't approve "${title}".`;
        if (comment) more = [`Their comment:\n${comment}`];
        break;
      case 'approved': {
        type = 'request_approved';
        inAppTitle = 'Request approved';
        subject = `"${title}" is approved`;
        heading = 'Your request is approved';
        said = `"${title}" is approved.`;
        const audiences = audienceKeys(submission, await getTrackedChanges(submission.id, env).catch(() => []));
        const newsletterOnly = audiences.includes('newsletter') && !audiences.some((a) => STANDALONE_EMAIL_AUDIENCES.has(a));
        more = [newsletterOnly
          ? 'It will go out in the next Ranger News.'
          : 'The Comms Cadre will send it.'];
        break;
      }
      default:
        type = 'request_sent';
        inAppTitle = 'Request sent';
        subject = `"${title}" was sent`;
        heading = 'Your request was sent';
        said = extra.edition !== undefined
          ? `"${title}" went out in Ranger News #${extra.edition}.`
          : lists.length > 0
            ? `"${title}" was sent to ${lists.join(', ')}.`
            : `"${title}" was sent.`;
    }

    try {
      if (await wantsSubmitterUpdates(env, submitter.email)) {
        const rendered = renderWorkflowEmail({
          heading,
          paragraphs: [said, ...more],
          details: await requestDetails(submission, env).catch(() => []),
          action: { label: 'Open the request', url: requestLink(env, submission.id) },
        });
        await sendWorkflowEmail(env, [submitter.email], subject, rendered);
      }
    } catch (err) {
      console.error(`Could not email the submitter of ${submission.id}:`, err);
    }

    await createInAppNotification({
      userId: submitter.email,
      type,
      title: inAppTitle,
      message: said,
      submissionId: submission.id,
      submissionTitle: title,
      actorName: actor?.name || actor?.email,
    }, env);
  } catch (err) {
    console.error(`Could not tell the submitter of ${submission.id} (${event}):`, err);
  }
}
