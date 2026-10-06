import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { ContentSubmission, ContentComment, ContentApproval, ContentChange, User, ApprovalGates, ApproverDetail } from '../types';
import { getObject, putObject, deleteObject, listObjects } from '../services/cacheService';
import { withAuth } from '../authWrappers';
import { broadcastToSubmissionRoom } from './websocket';
import { uploadMedia } from '../services/mediaService';
import { buildAnnouncementEmail, embedGalleryImages } from '../services/announcementEmail';
import { fetchPublicImage, FetchPublicImageOptions, ImageImportError } from '../utils/imageImport';
import { Env } from '../utils/sessionManager';
import { Access, accessOf, approverCounts, derivedRoles, derivedUserType, isAdmin, isCommsCadre, isCommsManager, isReviewer, normalizeEmail } from '../services/access';
import { accessByEmail, peopleByEmail, peopleWhere } from '../services/peopleService';
import { listMailingLists, suggestedListIds } from '../services/mailingListService';
import { getUser } from '../services/userService';
import { audienceKeys, STANDALONE_EMAIL_AUDIENCES } from '../utils/audiences';
import { InputError, cleanKeyDates, cleanNewsletterRequest, cleanWritingHelp } from '../utils/newsletterInput';
import { getEdition } from '../services/newsletterService';
import { getTrackedChanges, ChangeComment } from '../services/trackedChangesService';
import { syncCalendarFromSubmission } from '../services/commsCalendarService';

export const router = AutoRouter({ base: '/api/content' });

// Record a sent submission in the Comms Calendar. Never fails the caller: the email has
// already gone, and an error here would invite sending it again.
async function recordInCommsCalendar(submission: ContentSubmission, env: Env, options: Parameters<typeof syncCalendarFromSubmission>[2]) {
  try {
    await syncCalendarFromSubmission(submission, env, options);
  } catch (error) {
    console.error(`Comms Calendar: could not record submission ${submission.id}:`, error);
  }
}

// Who each approval counts for: the roles the approver held when approving (the snapshot on
// the approval) or holds now (their record; services/access.ts). One store read per approver.
async function approvalCounter(approvals: ContentApproval[], env: any) {
  const current: Map<string, Access> = await accessByEmail(approvals.map((a) => a.approverEmail || ''), env);
  return (a: ContentApproval) => approverCounts(a, current.get(normalizeEmail(a.approverEmail)));
}

/** Every approval gate met (the request can be approved). */
export function allGatesMet(gates: ApprovalGates): boolean {
  return gates.councilManager.met && gates.commsCadre.met && gates.requiredApprovers.met && gates.trackedChanges.met;
}

// Recompute approval status from the gates. Promotes to 'approved' only; never demotes
// (syncSubmissionStatus does that) and never touches a 'sent' submission.
export async function recomputeApprovalStatus(submission: ContentSubmission, env: any): Promise<ContentSubmission> {
  if (submission.status === 'sent') return submission;
  if (allGatesMet(await computeApprovalGates(submission, env))) {
    submission.status = 'approved';
    submission.finalApprovalDate = submission.finalApprovalDate || new Date().toISOString();
  }
  return submission;
}

/**
 * Keep a submission's status in step with its tracked changes. Called last by every
 * handler that creates, resolves, undoes or deletes tracked changes (handlers/trackedChanges.ts).
 *
 * The rule:
 *  - `sent` never changes: the announcement has gone out.
 *  - `approved` with a pending tracked change drops back to `in_review`: the approved
 *    content has changed (a new edit, or an undo that made a change pending again).
 *    `finalApprovalDate` is cleared and an override approval (`approvalOverride`) no longer
 *    holds; its audit fields (`approvalOverrideBy/Reason/At`) stay. It becomes `approved`
 *    again only when the approval gates are met (recomputeApprovalStatus) or after a new
 *    override.
 *  - Anything else becomes `approved` when recomputeApprovalStatus says so: every required
 *    approver, a council manager and a Comms Cadre member approved, and no tracked change
 *    is pending (e.g. the last change was resolved after the approvals).
 *  - Only pending changes demote. An approver changing their vote does not (as before), so
 *    an override approval survives accepting or rejecting changes.
 *
 * Re-reads the submission (the caller may just have written it) and writes it only when
 * the status changes. Always tells the room, with the approval gates: `status_changed` when
 * the status changed, else `approval_state`. `onlyDemote` skips the promotion check (a newly
 * created change can only make a change pending). `approversChanged` (the approvers list was
 * edited) also demotes an `approved` request whose gates are no longer met, e.g. a new council
 * approver who hasn't approved yet; an override approval still holds.
 */
export async function syncSubmissionStatus(
  submissionId: string,
  env: any,
  actor?: { id?: string; email?: string; name?: string },
  options: { onlyDemote?: boolean; approversChanged?: boolean } = {}
): Promise<ContentSubmission | null> {
  try {
    const submission = await getObject<ContentSubmission>(`content_submissions/${submissionId}`, env);
    if (!submission || submission.status === 'sent') return submission;
    const before = submission.status;
    if (before === 'approved') {
      const changes = await getTrackedChanges(submissionId, env);
      const gatesFail = options.approversChanged && !submission.approvalOverride &&
        !allGatesMet(await computeApprovalGates(submission, env));
      if (changes.some(c => c.status === 'pending') || gatesFail) {
        submission.status = 'in_review';
        delete submission.finalApprovalDate;
        if (submission.approvalOverride) submission.approvalOverride = false;
      }
    } else if (!options.onlyDemote) {
      await recomputeApprovalStatus(submission, env);
    }
    const changed = submission.status !== before;
    if (changed) {
      // Write only the status fields, onto a fresh copy: the reads above take a while, and
      // a concurrent write (another decision, an autosave) must keep its content.
      const fresh = (await getObject<ContentSubmission>(`content_submissions/${submissionId}`, env)) || submission;
      if (fresh.status === 'sent') return fresh;
      fresh.status = submission.status;
      if (submission.finalApprovalDate) fresh.finalApprovalDate = submission.finalApprovalDate;
      else delete fresh.finalApprovalDate;
      if (submission.approvalOverride !== undefined) fresh.approvalOverride = submission.approvalOverride;
      await putObject(`content_submissions/${submissionId}`, fresh, env);
      await deleteObject('content_submissions/list', env);
    }
    // Open review pages show the gates ("N/4 conditions met") and the status (Send): tell
    // the room either way, `status_changed` when the status changed, else `approval_state`.
    await broadcastToSubmissionRoom(submissionId, {
      type: changed ? 'status_changed' : 'approval_state',
      userId: actor?.id || actor?.email || 'system',
      userName: actor?.name || '',
      userEmail: actor?.email || '',
      data: {
        status: submission.status,
        ...(changed ? { previousStatus: before, title: submission.title, reason: options.approversChanged ? 'approvers_changed' : 'tracked_changes' } : {}),
        approvalGates: await computeApprovalGates(submission, env),
      },
    }, env);
    return submission;
  } catch (err) {
    console.error(`Failed to sync the status of submission ${submissionId}:`, err);
    return null;
  }
}

/** Who may see a submission (GET /submissions/:id); also who may resolve its comments. */
export function canViewSubmission(user: User, submission: ContentSubmission): boolean {
  return isReviewer(user) ||
    submission.submittedBy === user.id ||
    !!(submission.approvals && submission.approvals.some((a: ContentApproval) => a.approverId === user.id)) ||
    !!(submission.requiredApprovers && submission.requiredApprovers.includes(user.email));
}

/** The latest decision of each approver (by email, else id). */
function latestDecisions(submission: ContentSubmission): ContentApproval[] {
  const byApprover = new Map<string, ContentApproval>();
  for (const a of submission.approvals || []) {
    const key = (a.approverEmail || a.approverId || '').trim().toLowerCase();
    if (!key) continue;
    const prev = byApprover.get(key);
    const time = (x: ContentApproval) => new Date(x.updatedAt || x.createdAt).getTime();
    if (!prev || time(a) >= time(prev)) byApprover.set(key, a);
  }
  return Array.from(byApprover.values());
}

/**
 * The approval gates (also sent to the review page). The approvers list holds both kinds of
 * approver: the council members on it are the Council gate (at least one must be listed, and
 * all of them must approve; a council member who isn't listed doesn't count), the rest the
 * required approvers gate (met when all approved, or there are none). Someone is a council
 * member by their stored access, or (for someone with no stored record, e.g. a dev user) by
 * the role recorded on their approval here. One person on the list who is also Comms Cadre
 * meets the Comms Cadre gate with the same approval.
 */
export async function computeApprovalGates(submission: ContentSubmission, env: any): Promise<ApprovalGates> {
  const decisions = latestDecisions(submission);
  const decisionOf = (email: string) => decisions.find((a) => normalizeEmail(a.approverEmail) === email);

  const listed = Array.from(new Set((submission.requiredApprovers || []).map(normalizeEmail).filter(Boolean)));
  const people = await peopleByEmail(listed, env);
  const council: ApproverDetail[] = [];
  const others: ApproverDetail[] = [];
  for (const email of listed) {
    const decision = decisionOf(email);
    const person = people.get(email);
    const stored = person?.access;
    const isCouncil = stored ? stored.council : !!decision && approverCounts(decision).council;
    const detail: ApproverDetail = {
      email,
      name: person?.name || decision?.approverName,
      status: (decision ? decision.status : 'pending') as ApproverDetail['status'],
      date: decision ? (decision.updatedAt || decision.createdAt) : undefined,
      ...(isCouncil && stored?.councilRole ? { councilRole: stored.councilRole } : {}),
    };
    (isCouncil ? council : others).push(detail);
  }
  const othersApproved = others.filter((d) => d.status === 'approved').length;
  const councilMet = council.length > 0 && council.every((d) => d.status === 'approved');
  const lastCouncil = council
    .filter((d) => d.status === 'approved')
    .sort((x, y) => new Date(y.date || 0).getTime() - new Date(x.date || 0).getTime())[0];
  const lastCouncilDecision = lastCouncil ? decisionOf(lastCouncil.email) : undefined;

  const counts = await approvalCounter(decisions, env);
  const commsCadreApproval = decisions.find(a => a.status === 'approved' && counts(a).commsCadre);

  const changes = await getTrackedChanges(submission.id, env);
  const pendingChanges = changes.filter(c => c.status === 'pending');

  return {
    councilManager: {
      met: councilMet,
      approver: councilMet ? lastCouncil?.email : undefined,
      approverName: councilMet ? council.map((d) => d.name || d.email).join(', ') : undefined,
      date: councilMet ? lastCouncil?.date : undefined,
      comment: councilMet ? lastCouncilDecision?.comment : undefined,
      approvers: council,
    },
    commsCadre: {
      met: !!commsCadreApproval,
      approver: commsCadreApproval?.approverEmail,
      approverName: commsCadreApproval?.approverName,
      date: commsCadreApproval ? (commsCadreApproval.updatedAt || commsCadreApproval.createdAt) : undefined,
      comment: commsCadreApproval?.comment,
    },
    requiredApprovers: {
      met: othersApproved === others.length,
      approved: othersApproved,
      total: others.length,
      details: others,
    },
    trackedChanges: {
      met: pendingChanges.length === 0,
      pending: pendingChanges.length,
      total: changes.length,
    },
  };
}

/**
 * The request form's newsletter fields, validated: audience keys, writing help, the
 * newsletter item (only kept when the audience includes the newsletter) and key dates.
 */
function cleanNewsletterFields(input: any): Pick<ContentSubmission, 'audiences' | 'writingHelp' | 'newsletter' | 'keyDates'> {
  const out: Pick<ContentSubmission, 'audiences' | 'writingHelp' | 'newsletter' | 'keyDates'> = {};
  if (Array.isArray(input.audiences)) {
    out.audiences = input.audiences.filter((a: unknown) => typeof a === 'string' && a.trim()).map((a: string) => a.trim()).slice(0, 20);
  }
  const writingHelp = cleanWritingHelp(input.writingHelp);
  if (writingHelp.document || writingHelp.blurb) out.writingHelp = writingHelp;
  const keyDates = cleanKeyDates(input.keyDates);
  if (keyDates.length) out.keyDates = keyDates;
  if (input.newsletter && (out.audiences || []).includes('newsletter')) {
    out.newsletter = cleanNewsletterRequest(input.newsletter);
  }
  return out;
}

// Fields only this server sets (newsletter placement and public pages) or that have their own
// endpoint (PATCH /submissions/:id/newsletter, PUT /submissions/:id/approvers); PUT bodies
// often carry a stale loaded copy.
const PUT_IGNORED_FIELDS = [
  'newsletter', 'keyDates', 'writingHelp',
  'newsletterEditionId', 'newsletterSentIn', 'publicSlug', 'publicPublishedAt',
  'sentTo', 'reminders', 'requiredApprovers',
] as const;

// Create a new content submission
router.post('/submissions', withAuth, async (request: Request, env: any) => {
  const submission: Partial<ContentSubmission> = await request.json();
  const user = (request as any).user as User;

  let newsletterFields: Pick<ContentSubmission, 'audiences' | 'writingHelp' | 'newsletter' | 'keyDates'>;
  try {
    newsletterFields = cleanNewsletterFields(submission);
  } catch (err) {
    if (err instanceof InputError) return json({ error: err.message }, { status: 400 });
    throw err;
  }

  const newSubmission: ContentSubmission = {
    id: crypto.randomUUID(),
    title: submission.title!,
    content: submission.content!,
    submittedBy: user.id,
    submittedAt: new Date().toISOString(),
    status: submission.status || 'draft',
    formFields: submission.formFields || [],
    comments: [],
    approvals: [],
    changes: [],
    commsCadreApprovals: 0,
    councilManagerApprovals: [],
    announcementSent: false,
    assignedCouncilManagers: submission.assignedCouncilManagers || [],
    requiredApprovers: submission.requiredApprovers || [],
    ...newsletterFields,
  };
  // The content as submitted, kept unchanged for the Original view (accept / reject
  // rewrite content and richTextContent). A copy of exactly what is stored above.
  newSubmission.originalContent = newSubmission.content;
  if (newSubmission.richTextContent !== undefined) {
    newSubmission.originalRichTextContent = newSubmission.richTextContent;
  }

  // Store in cache with appropriate key
  await putObject(`content_submissions/${newSubmission.id}`, newSubmission, env);
  
  // Invalidate the submissions list cache
  await deleteObject('content_submissions/list', env);

  return json(newSubmission);
});

// Get all submissions (filtered by user permissions)
router.get('/submissions', withAuth, async (request: Request, env: any) => {
  const user = (request as any).user as User;
  
  // Get all submissions from cache
  const response = await listObjects('content_submissions/', env);
  
  // Fetch the full content of each submission
  const submissionPromises = response.objects.map(async (obj: any) => {
    const submission = await getObject<ContentSubmission>(obj.key, env);
    return submission;
  });
  
  const allSubmissions = (await Promise.all(submissionPromises)).filter((sub): sub is ContentSubmission => sub !== null);
  
  // Reviewers see everything; others their own, and the ones they approve
  let submissions;
  if (isReviewer(user)) {
    submissions = allSubmissions;
  } else {
    submissions = allSubmissions.filter((sub: ContentSubmission) => 
      sub.submittedBy === user.id || 
      (sub.approvals && sub.approvals.some((a: ContentApproval) => a.approverId === user.id)) ||
      (sub.requiredApprovers && sub.requiredApprovers.includes(user.email))
    );
  }

  return json(submissions);
});

// Get submissions needing the current user's action
router.get('/submissions/my-actions', withAuth, async (request: Request, env: any) => {
  const user = (request as any).user as User;

  // Get all submissions
  const response = await listObjects('content_submissions/', env);
  const submissionPromises = response.objects.map(async (obj: any) => {
    return await getObject<ContentSubmission>(obj.key, env);
  });
  const allSubmissions = (await Promise.all(submissionPromises)).filter(
    (sub): sub is ContentSubmission => sub !== null
  );

  const needsAction: any[] = [];
  const inProgress: any[] = [];

  for (const submission of allSubmissions) {
    if (['sent', 'rejected', 'draft'].includes(submission.status)) continue;

    const isRequiredApprover = (submission.requiredApprovers || []).some((e) => normalizeEmail(e) === normalizeEmail(user.email));
    const hasActed = (submission.approvals || []).some(
      (a: ContentApproval) =>
        a.approverEmail === user.email || a.approverId === user.id
    );

    const access = accessOf(user);
    const reviewer = isReviewer(user);

    const gates = await computeApprovalGates(submission, env);

    // Council members act on the requests that list them; the Comms Cadre approve, and pick a
    // council approver when none is listed yet
    if (isRequiredApprover && !hasActed) {
      needsAction.push({ ...submission, approvalGates: gates });
    } else if (access.commsCadre && gates.councilManager.approvers.length === 0) {
      needsAction.push({ ...submission, approvalGates: gates });
    } else if (reviewer && !hasActed) {
      if (access.commsCadre && !gates.commsCadre.met) {
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
    const aUrgent = a.formFields?.some(
      (f: any) => f.name === 'urgent' && f.value === 'true'
    );
    const bUrgent = b.formFields?.some(
      (f: any) => f.name === 'urgent' && f.value === 'true'
    );
    if (aUrgent && !bUrgent) return -1;
    if (!aUrgent && bUrgent) return 1;
    return (
      new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime()
    );
  };

  needsAction.sort(sortByUrgencyThenAge);
  inProgress.sort(sortByUrgencyThenAge);

  return json({ needsAction, inProgress });
});

// Get a single submission by ID
router.get('/submissions/:id', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const user = (request as any).user as User;

  // Get the submission from cache
  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }

  // Check if user has access to this submission
  if (!canViewSubmission(user, submission)) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  // Get proposed versions from tracked changes system
  const savedProposedVersions = await getObject(`proposed_versions/${id}`, env) as any;
  
  // Compute approval gates for the frontend approval tracker
  const approvalGates = await computeApprovalGates(submission, env);

  // Merge proposed versions into submission if they exist
  const placedIn = submission.newsletterEditionId ? await getEdition(submission.newsletterEditionId, env).catch(() => null) : null;
  const submissionWithProposedVersions = {
    ...submission,
    approvalGates,
    ...(placedIn && placedIn.sections.some((s) => s.sourceSubmissionId === submission.id)
      ? { newsletterPlacement: { editionId: placedIn.id, number: placedIn.number, status: placedIn.status } }
      : {}),
    proposedVersions: savedProposedVersions ? {
      richTextContent: savedProposedVersions.proposedVersionsRichText,
      content: savedProposedVersions.proposedVersionsContent,
      lastModified: savedProposedVersions.lastUpdatedAt,
      lastModifiedBy: savedProposedVersions.lastUpdatedBy
    } : undefined
  };

  return json(submissionWithProposedVersions);
});

// Update a submission
router.put('/submissions/:id', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const user = (request as any).user as User;
  const updates = await request.json();

  // Get the current submission
  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }

  // Check if user has permission to edit this submission (the approvers have their own
  // endpoint: PUT /submissions/:id/approvers)
  const canEdit = isReviewer(user) ||
                 submission.submittedBy === user.id ||
                 (submission.requiredApprovers && submission.requiredApprovers.includes(user.email));

  if (!canEdit) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  // Update the submission. proposedVersions is neither stored in the record nor written
  // to proposed_versions/<id> here: it lives only in that object, whose one writer from a
  // client is PUT /tracked-changes/submission/:id. Bodies here often carry a copy loaded
  // earlier (the submission list, a stale record), which would hide every edit since.
  // Comments and approvals are likewise left out: they change only through their own
  // endpoints (comments, resolve, approve), and a loaded copy would undo those.
  const {
    proposedVersions: _ignoredProposedVersions,
    comments: _ignoredComments,
    approvals: _ignoredApprovals,
    ...fieldUpdates
  } = updates;
  const updatedSubmission = {
    ...submission,
    ...fieldUpdates,
    updatedAt: new Date().toISOString()
  };
  // The content as submitted never changes (bodies here can carry a whole loaded copy)
  for (const key of ['originalContent', 'originalRichTextContent'] as const) {
    if (submission[key] === undefined) delete (updatedSubmission as any)[key];
    else (updatedSubmission as any)[key] = submission[key];
  }
  delete (updatedSubmission as any).proposedVersions;
  for (const key of PUT_IGNORED_FIELDS) {
    if (submission[key] === undefined) delete (updatedSubmission as any)[key];
    else (updatedSubmission as any)[key] = submission[key];
  }

  // Store the updated submission
  await putObject(`content_submissions/${id}`, updatedSubmission, env);
  if (updatedSubmission.status === 'sent' && submission.status !== 'sent') {
    await recordInCommsCalendar(updatedSubmission, env, { by: user.email });
  }
  
  // Invalidate the submissions list cache
  await deleteObject('content_submissions/list', env);

  // Broadcast the update to connected WebSocket clients
  await broadcastToSubmissionRoom(id, {
    type: 'content_updated',
    userId: user.id || user.email,
    userName: user.name,
    userEmail: user.email,
    data: {
      title: updatedSubmission.title,
      status: updatedSubmission.status,
      changes: updates
    }
  }, env);

  return json(updatedSubmission);
});

// Add a comment to a submission
router.post('/submissions/:id/comments', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const comment: Partial<ContentComment> = await request.json();
  const user = (request as any).user as User;

  const newComment: ContentComment = {
    id: crypto.randomUUID(),
    submissionId: id,
    content: comment.content!,
    authorId: user.id,
    authorName: user.name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isSuggestion: comment.isSuggestion || false,
    resolved: false,
    parentId: comment.parentId,
    replies: []
  };

  // Get the current submission
  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }

  // Add the comment
  submission.comments.push(newComment);

  // Update the submission in cache
  await putObject(`content_submissions/${id}`, submission, env);
  
  // Invalidate the submissions list cache
  await deleteObject('content_submissions/list', env);

  // Broadcast the comment to connected WebSocket clients
  await broadcastToSubmissionRoom(id, {
    type: 'comment_added',
    userId: user.id || user.email,
    userName: user.name,
    userEmail: user.email,
    data: {
      comment: newComment,
      title: submission.title
    }
  }, env);

  return json(newComment);
});

/**
 * Resolve or reopen a comment thread (Google Docs style): body `{ resolved: boolean }`.
 * The thread is its root comment; replies (`@reply:<id>` in their content) follow it in the
 * UI. Any user who can view the submission may resolve or reopen (posting a comment has no
 * stricter rule). Looks in the submission's comments first, then in the change comments
 * (POST /tracked-changes/change/:id/comment) of this submission; `changeId` in the body
 * finds those directly. Broadcasts `comment_resolved` to the submission room.
 */
router.post('/submissions/:id/comments/:commentId/resolve', withAuth, async (request: Request, env: any) => {
  const { id, commentId } = (request as any).params;
  const user = (request as any).user as User;
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  if (typeof body?.resolved !== 'boolean') {
    return json({ error: 'resolved (boolean) is required' }, { status: 400 });
  }
  const resolved: boolean = body.resolved;

  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }
  if (!canViewSubmission(user, submission)) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  const now = new Date().toISOString();
  const apply = <C extends object>(comment: C): C => {
    const next: any = { ...comment, resolved, updatedAt: now };
    if (resolved) {
      next.resolvedBy = user.email || user.id;
      next.resolvedByName = user.name;
      next.resolvedAt = now;
    } else {
      delete next.resolvedBy;
      delete next.resolvedByName;
      delete next.resolvedAt;
    }
    return next;
  };

  let updated: any;
  let changeId: string | undefined;
  const index = (submission.comments || []).findIndex(c => c.id === commentId);
  if (index !== -1) {
    updated = apply(submission.comments[index]);
    submission.comments[index] = updated;
    await putObject(`content_submissions/${id}`, submission, env);
    await deleteObject('content_submissions/list', env);
  } else {
    // A change comment: stored per change under change-comments/change/<changeId>/<id>
    const candidates: string[] = typeof body.changeId === 'string' && body.changeId
      ? [body.changeId]
      : (await getTrackedChanges(id, env)).map(c => c.id);
    for (const candidate of candidates) {
      const key = `change-comments/change/${candidate}/${commentId}`;
      const stored = await getObject<ChangeComment>(key, env);
      if (!stored || stored.submissionId !== id) continue;
      updated = apply(stored);
      changeId = candidate;
      await putObject(key, updated, env);
      await putObject(`comment:${key}`, updated, env, undefined, 3600);
      await deleteObject(`change_comments:change:${candidate}`, env);
      break;
    }
  }
  if (!updated) {
    return json({ error: 'Comment not found' }, { status: 404 });
  }

  await broadcastToSubmissionRoom(id, {
    type: 'comment_resolved',
    userId: user.id || user.email,
    userName: user.name,
    userEmail: user.email,
    data: {
      commentId,
      ...(changeId ? { changeId } : {}),
      resolved,
      resolvedBy: updated.resolvedBy,
      resolvedByName: updated.resolvedByName,
      resolvedAt: updated.resolvedAt,
    },
  }, env);

  return json(updated);
});

// Approve or reject a submission
router.post('/submissions/:id/approve', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const { status, comment } = await request.json();
  const user = (request as any).user as User;

  const approval: ContentApproval = {
    id: crypto.randomUUID(),
    submissionId: id,
    approverId: user.id,
    approverEmail: user.email,
    approverName: user.name,
    // What they held when approving (approval gates also check what they hold now)
    approverType: derivedUserType(accessOf(user)),
    approverRoles: derivedRoles(accessOf(user)),
    status,
    comment,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Get the current submission
  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }

  // Check if user has permission to approve this submission
  // Any required reviewer, Comms Cadre, or Council Manager can approve
  const canApprove = isReviewer(user) ||
                    (submission.requiredApprovers && submission.requiredApprovers.includes(user.email));

  if (!canApprove) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  // Add/update approval ensuring unique approver decision
  const existingApprovalIndex = submission.approvals.findIndex((a: ContentApproval) =>
    (a.approverId && a.approverId === user.id) || (a.approverEmail && a.approverEmail === user.email)
  );

  if (existingApprovalIndex !== -1) {
    const existingApproval = submission.approvals[existingApprovalIndex];
    if (existingApproval.status === status) {
      return json({ error: `You have already ${status} this submission` }, { status: 400 });
    }
    submission.approvals[existingApprovalIndex] = {
      ...existingApproval,
      status,
      comment,
      updatedAt: new Date().toISOString()
    };
  } else {
    submission.approvals.push(approval);
  }
  
  // Recompute status with multi-role awareness and membership lists
  const statusBefore = submission.status;
  await recomputeApprovalStatus(submission, env);

  // Check if approval was blocked by pending tracked changes
  let pendingTrackedChangesCount = 0;
  if (status === 'approved' && submission.status !== 'approved' && statusBefore !== 'approved') {
    const changes = await getTrackedChanges(id, env);
    pendingTrackedChangesCount = changes.filter(c => c.status === 'pending').length;
  }

  // Update the submission in cache
  await putObject(`content_submissions/${id}`, submission, env);

  // Invalidate the submissions list cache
  await deleteObject('content_submissions/list', env);

  // Broadcast the approval to connected WebSocket clients
  await broadcastToSubmissionRoom(id, {
    type: 'approval_added',
    userId: user.id || user.email,
    userName: user.name,
    userEmail: user.email,
    data: {
      approval: approval,
      submissionStatus: submission.status,
      title: submission.title,
      // Open review pages update their "N/4 conditions met" from this
      approvalGates: await computeApprovalGates(submission, env),
    }
  }, env);

  // Notify submitter of approval/rejection
  try {
    const { notifyApprovalDecision } = await import('../services/notificationService');
    await notifyApprovalDecision(
      id,
      submission.title,
      submission.submittedBy,
      status,
      user.name || user.email,
      env
    );
  } catch (err) {
    console.error('Error sending approval notification:', err);
  }

  const response: any = { ...approval };
  if (pendingTrackedChangesCount > 0) {
    response.pendingTrackedChanges = pendingTrackedChangesCount;
    response.message = `Approval recorded, but submission cannot be fully approved until ${pendingTrackedChangesCount} pending tracked change(s) are resolved.`;
  }

  return json(response);
});

// Override approval by Communications Manager (Council) with confirmation
router.post('/submissions/:id/override-approve', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const { confirm, reason } = await request.json();
  const user = (request as any).user as User;

  // Only the Communications Manager (council role) or an Admin can override
  const canOverride = isAdmin(user, env) || isCommsManager(user);
  if (!canOverride) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  if (!confirm) {
    return json({ error: 'Confirmation required' }, { status: 400 });
  }

  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }

  submission.status = 'approved';
  submission.finalApprovalDate = new Date().toISOString();
  submission.approvalOverride = true;
  submission.approvalOverrideBy = user.id || user.email;
  submission.approvalOverrideReason = reason;
  submission.approvalOverrideAt = new Date().toISOString();

  await putObject(`content_submissions/${id}`, submission, env);
  await deleteObject('content_submissions/list', env);

  await broadcastToSubmissionRoom(id, {
    type: 'status_changed',
    userId: user.id || user.email,
    userName: user.name,
    userEmail: user.email,
    data: { status: submission.status, title: submission.title }
  }, env);

  return json(submission);
});

// Request changes — reviewer asks submitter for revisions (requires comment)
router.post('/submissions/:id/request-changes', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const user = (request as any).user as User;
  const { comment } = await request.json();

  if (!comment || !comment.trim()) {
    return json({ error: 'Comment required when requesting changes' }, { status: 400 });
  }

  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }

  // Only reviewers can request changes
  const canRequest = isReviewer(user) ||
    (submission.requiredApprovers && submission.requiredApprovers.includes(user.email));

  if (!canRequest) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  // Keep status as in_review
  submission.status = 'in_review';

  // Add comment
  const newComment = {
    id: crypto.randomUUID(),
    submissionId: id,
    content: comment.trim(),
    authorId: user.id || user.email,
    authorName: user.name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isSuggestion: false,
    resolved: false,
  };
  submission.comments = [...(submission.comments || []), newComment];

  await putObject(`content_submissions/${id}`, submission, env);
  await deleteObject('content_submissions/list', env);

  // Notify submitter
  try {
    const { createInAppNotification } = await import('../services/notificationService');
    await createInAppNotification({
      userId: submission.submittedBy,
      type: 'changes_requested',
      title: 'Changes requested',
      message: `${user.name || user.email} requested changes on "${submission.title}"`,
      submissionId: id,
      submissionTitle: submission.title,
      actorName: user.name || user.email,
    }, env);
  } catch (err) {
    console.error('Error sending changes-requested notification:', err);
  }

  // Broadcast via WebSocket
  await broadcastToSubmissionRoom(id, {
    type: 'status_changed',
    userId: user.id || user.email,
    userName: user.name,
    userEmail: user.email,
    data: { status: 'in_review', comment: newComment },
  }, env);

  return json({ success: true, comment: newComment });
});

// The newsletter item, key dates and writing help. Not tracked changes: the submitter,
// required approvers, the Comms Cadre and Admins edit them directly (the cadre may write the
// blurb for someone who asked for help). Fixed once the item has gone out in an edition.
router.patch('/submissions/:id/newsletter', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const user = (request as any).user as User;
  const body = await request.json().catch(() => ({}));

  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }
  const canEdit = isAdmin(user, env) ||
    submission.submittedBy === user.id ||
    (submission.requiredApprovers || []).some((e) => (e || '').toLowerCase() === (user.email || '').toLowerCase()) ||
    isCommsCadre(user);
  if (!canEdit) {
    return json({ error: 'Access denied' }, { status: 403 });
  }
  if (submission.newsletterSentIn) {
    return json({ error: `This item went out in issue #${submission.newsletterSentIn} and can no longer change` }, { status: 409 });
  }

  try {
    if ('newsletter' in body) {
      if (body.newsletter) submission.newsletter = cleanNewsletterRequest(body.newsletter);
      else delete submission.newsletter;
    }
    if ('keyDates' in body) {
      const keyDates = cleanKeyDates(body.keyDates);
      if (keyDates.length) submission.keyDates = keyDates;
      else delete submission.keyDates;
    }
    if ('writingHelp' in body) {
      const writingHelp = cleanWritingHelp(body.writingHelp);
      if (writingHelp.document || writingHelp.blurb) submission.writingHelp = writingHelp;
      else delete submission.writingHelp;
    }
  } catch (err) {
    if (err instanceof InputError) return json({ error: err.message }, { status: 400 });
    throw err;
  }
  submission.updatedAt = new Date().toISOString();

  await putObject(`content_submissions/${id}`, submission, env);
  await deleteObject('content_submissions/list', env);

  await broadcastToSubmissionRoom(id, {
    type: 'content_updated',
    userId: user.id || user.email,
    userName: user.name,
    userEmail: user.email,
    data: {
      title: submission.title,
      status: submission.status,
      changes: { newsletter: submission.newsletter, keyDates: submission.keyDates, writingHelp: submission.writingHelp },
    },
  }, env);

  return json({
    newsletter: submission.newsletter || null,
    keyDates: submission.keyDates || [],
    writingHelp: submission.writingHelp || {},
    updatedAt: submission.updatedAt,
  });
});

// The announcement email as it would be sent: subject, recipient, Reply-To, HTML and text.
// Built by the same code as send-email, so the review page's Send view shows exactly what goes
// out. Anyone who can view the submission can preview it (in any status).
router.get('/submissions/:id/email-preview', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const user = (request as any).user as User;

  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }
  if (!canViewSubmission(user, submission)) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  // The lists it can go to, with the ones its audience suggests ticked
  const allLists = await listMailingLists(env);
  return json({
    ...(await buildAnnouncementEmail(submission, env)),
    // Dev: a sent announcement can be sent again (Resend Email)
    resendAllowed: env.ALLOW_ANNOUNCEMENT_RESEND === true,
    lists: allLists.map((l) => ({ id: l.id, name: l.name, address: l.address, builtIn: !!l.builtIn })),
    suggestedListIds: suggestedListIds(allLists, audienceKeys(submission, await getTrackedChanges(id, env))),
    sentTo: submission.sentTo || [],
    redirectedTo: env.COMMS_EMAIL_OVERRIDE || null,
  });
});

// Send announcement email after full approval; Comms Cadre can send
router.post('/submissions/:id/send-email', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const user = (request as any).user as User;

  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }

  // Must be approved first; a sent one again only where resending is allowed (dev)
  const resend = submission.status === 'sent' && env.ALLOW_ANNOUNCEMENT_RESEND === true;
  if (submission.status !== 'approved' && !resend) {
    return json({ error: submission.status === 'sent' ? 'Already sent' : 'Submission not approved yet' }, { status: 400 });
  }

  // Only Comms Cadre or Admin can send
  if (!(isCommsCadre(user) || isAdmin(user, env))) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  // A newsletter item goes out in a newsletter edition, not on its own
  const audiences = audienceKeys(submission, await getTrackedChanges(id, env));
  if (audiences.includes('newsletter') && !audiences.some((a) => STANDALONE_EMAIL_AUDIENCES.has(a))) {
    return json({ error: 'This request goes out in the newsletter. Add it to an edition instead.' }, { status: 409 });
  }

  // Sending is switched on by ANNOUNCE_EMAIL_TO (unset in staging); the lists come from
  // Requests → Settings, Ranger Announce from that address
  if (!env.ANNOUNCE_EMAIL_TO) {
    return json({ error: 'Sending is not configured here (ANNOUNCE_EMAIL_TO)' }, { status: 503 });
  }
  const body = await request.json().catch(() => ({})) as { listIds?: unknown };
  const allLists = await listMailingLists(env);
  const chosenIds = Array.isArray(body.listIds)
    ? body.listIds.filter((x): x is string => typeof x === 'string')
    : suggestedListIds(allLists, audiences);
  const chosen = allLists.filter((l) => chosenIds.includes(l.id));
  if (chosen.length === 0) {
    return json({ error: 'Choose at least one mailing list to send to' }, { status: 400 });
  }
  try {
    const { sendEmail, commsRecipients } = await import('../utils/email');
    // The approved document rendered for email (absolute image URLs), with the approved
    // Subject, Reply-To and signature: the same build as the email-preview endpoint.
    const email = await buildAnnouncementEmail(submission, env);
    // Gallery images go inside the email, so mail apps that block remote images show them
    const embedded = await embedGalleryImages(email.html, env);
    // On dev and staging (COMMS_EMAIL_OVERRIDE) the email goes to the override, not the lists
    const delivery = commsRecipients(chosen.map((l) => l.address), email.subject, env);
    await sendEmail(delivery.to, delivery.subject, email.text, env, {
      html: embedded.html,
      text: email.text,
      attachments: embedded.attachments,
      ...(email.replyTo ? { replyTo: email.replyTo } : {}),
    });

    submission.sentTo = chosen.map((l) => ({ id: l.id, name: l.name, address: l.address }));
    submission.status = 'sent';
    submission.sentBy = user.id || user.email;
    submission.sentAt = new Date().toISOString();
    submission.announcementSent = true;

    await putObject(`content_submissions/${id}`, submission, env);
    await deleteObject('content_submissions/list', env);
    // Announce, unless the request asked for the Newsletter too (the calendar shows Both)
    await recordInCommsCalendar(submission, env, { subject: email.subject, fallbackMethod: 'Announce', by: user.email });

    await broadcastToSubmissionRoom(id, {
      type: 'status_changed',
      userId: user.id || user.email,
      userName: user.name,
      userEmail: user.email,
      data: { status: submission.status, title: submission.title }
    }, env);

    return json({ success: true, sentTo: submission.sentTo });
  } catch (e: any) {
    return json({ error: e.message || 'Failed to send email' }, { status: 500 });
  }
});

/**
 * Ask people to approve a request: an email (through COMMS_EMAIL_OVERRIDE on dev and staging)
 * and an in-app notification each. `kind` 'added': they were just added as an approver;
 * 'reminder': someone reminded them. Throws if the email can't be sent.
 */
async function askForApproval(
  submission: ContentSubmission,
  emails: string[],
  actor: User,
  kind: 'added' | 'reminder',
  env: any
): Promise<void> {
  let origin = '';
  try {
    origin = new URL(env.FRONTEND_URL || env.PUBLIC_URL).origin;
  } catch {
    origin = '';
  }
  const link = `${origin}/tracked-changes/${submission.id}`;
  const by = actor.name || actor.email;
  const subject = kind === 'added'
    ? `Your approval is needed for "${submission.title}"`
    : `Reminder: your approval is needed for "${submission.title}"`;
  const said = kind === 'added'
    ? `${by} added you as an approver of "${submission.title}".`
    : `${by} asked for your approval of "${submission.title}".`;
  const { sendEmail, commsRecipients } = await import('../utils/email');
  const delivery = commsRecipients(emails, subject, env);
  await sendEmail(delivery.to, delivery.subject, `${said}\n\nOpen it here: ${link}\n\nThanks!`, env);
  try {
    const { createInAppNotification } = await import('../services/notificationService');
    for (const email of emails) {
      const person = await getUser(email, env).catch(() => null);
      if (!person) continue;
      await createInAppNotification({
        userId: person.id,
        type: 'submission_waiting',
        title: 'Your approval is needed',
        message: said,
        submissionId: submission.id,
        submissionTitle: submission.title,
        actorName: by,
      }, env);
    }
  } catch (err) {
    console.error('Could not add approval notifications:', err);
  }
}

const looksLikeEmail = (value: string) => /^[^\s@<>,;]+@[^\s@<>,;]+$/.test(value);

// Change a request's approvers (the review page). Admins, the Comms Cadre and Council: the Cadre
// picks or swaps the council approver(s), e.g. when the submitter didn't know who should approve.
// People added are asked by email and in the app; the status is checked again (an approved
// request whose new approvers haven't approved goes back to in review).
router.put('/submissions/:id/approvers', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const user = (request as any).user as User;
  if (!isReviewer(user, env)) {
    return json({ error: 'Only the Comms Cadre, Council and Admins change who approves a request' }, { status: 403 });
  }
  const body = await request.json().catch(() => ({})) as { approvers?: unknown };
  if (!Array.isArray(body.approvers) || body.approvers.some((e) => typeof e !== 'string')) {
    return json({ error: 'Send approvers: a list of email addresses' }, { status: 400 });
  }
  const approvers = Array.from(new Set(body.approvers.map((e: string) => normalizeEmail(e)).filter(Boolean)));
  const bad = approvers.find((e) => !looksLikeEmail(e));
  if (bad) return json({ error: `"${bad}" is not an email address` }, { status: 400 });
  if (approvers.length > 50) return json({ error: 'At most 50 approvers' }, { status: 400 });

  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  if (!submission) return json({ error: 'Submission not found' }, { status: 404 });
  if (submission.status === 'sent') return json({ error: 'This request has been sent' }, { status: 409 });

  const before = new Set((submission.requiredApprovers || []).map(normalizeEmail));
  submission.requiredApprovers = approvers;
  submission.updatedAt = new Date().toISOString();
  await putObject(`content_submissions/${id}`, submission, env);
  await deleteObject('content_submissions/list', env);

  // Ask the people just added, unless they already approved (or are the one adding them)
  const approvedAlready = new Set(latestDecisions(submission).filter((a) => a.status === 'approved').map((a) => normalizeEmail(a.approverEmail)));
  const added = approvers.filter((e) => !before.has(e) && e !== normalizeEmail(user.email) && !approvedAlready.has(e));
  if (added.length > 0 && ['submitted', 'in_review', 'approved'].includes(submission.status)) {
    try {
      await askForApproval(submission, added, user, 'added', env);
    } catch (err) {
      console.error('Could not tell the new approvers:', err);
    }
  }

  const synced = await syncSubmissionStatus(id, env, user, { approversChanged: true });
  const fresh = synced || submission;
  return json({ submission: { ...fresh, approvalGates: await computeApprovalGates(fresh, env) } });
});

// Remind approvers: one approver on the list (target = their email), the listed council members
// still to approve ('council'), or the Comms Cadre ('commsCadre'). Email plus an in-app
// notification, at most once a day per target on a request. Reviewers and the submitter may remind.
const REMIND_INTERVAL_MS = 20 * 60 * 60 * 1000;
router.post('/submissions/:id/remind', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const user = (request as any).user as User;
  const { target } = await request.json().catch(() => ({})) as { target?: unknown };
  if (typeof target !== 'string' || !target.trim()) return json({ error: 'Say who to remind' }, { status: 400 });

  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  if (!submission) return json({ error: 'Submission not found' }, { status: 404 });
  if (!(isReviewer(user, env) || submission.submittedBy === user.id || submission.submittedBy === user.email)) {
    return json({ error: 'Access denied' }, { status: 403 });
  }
  if (submission.status !== 'in_review' && submission.status !== 'submitted') {
    return json({ error: 'Only a request waiting for approval needs reminders' }, { status: 409 });
  }

  const gates = await computeApprovalGates(submission, env);
  const key = target.trim() === 'commsCadre' ? 'commsCadre' : target.trim().toLowerCase();
  let recipients: Array<{ email: string; name: string }>;
  let who: string;
  const listed = [...gates.councilManager.approvers, ...gates.requiredApprovers.details];
  if (key === 'council') {
    if (gates.councilManager.met) return json({ error: 'The council approvers have approved' }, { status: 409 });
    if (gates.councilManager.approvers.length === 0) {
      return json({ error: 'No council approver chosen yet: add one to the approvers first' }, { status: 409 });
    }
    recipients = gates.councilManager.approvers
      .filter((d) => d.status !== 'approved')
      .map((d) => ({ email: d.email, name: d.name || d.email }));
    who = 'the council approvers';
  } else if (key === 'commsCadre') {
    if (gates.commsCadre.met) return json({ error: 'A Comms Cadre member has already approved' }, { status: 409 });
    recipients = await peopleWhere(env, (a) => a.commsCadre);
    who = 'the Comms Cadre';
  } else {
    const waiting = listed.find((d) => d.email === key && d.status !== 'approved');
    if (!waiting) return json({ error: `${target} isn't an approver still to approve` }, { status: 409 });
    recipients = [{ email: waiting.email, name: waiting.name || waiting.email }];
    who = waiting.name || waiting.email;
  }
  recipients = recipients.filter((r) => normalizeEmail(r.email) !== normalizeEmail(user.email));
  if (recipients.length === 0) return json({ error: `Nobody else to remind for ${who}` }, { status: 409 });

  const last = [...(submission.reminders || [])].reverse().find((r) => r.target === key);
  if (last && Date.now() - new Date(last.at).getTime() < REMIND_INTERVAL_MS) {
    const when = new Date(last.at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' });
    return json({ error: `${who} was reminded ${when}; try again tomorrow`, lastReminder: last }, { status: 429 });
  }

  try {
    await askForApproval(submission, recipients.map((r) => r.email), user, 'reminder', env);
  } catch (e: any) {
    return json({ error: e.message || 'Could not send the reminder' }, { status: 502 });
  }

  const reminder = { target: key, to: recipients.map((r) => r.email), by: user.email, byName: user.name || user.email, at: new Date().toISOString() };
  const fresh = (await getObject<ContentSubmission>(`content_submissions/${id}`, env)) || submission;
  fresh.reminders = [...(fresh.reminders || []), reminder].slice(-50);
  await putObject(`content_submissions/${id}`, fresh, env);
  return json({ reminder, reminders: fresh.reminders });
});

// Track changes to a submission
router.post('/submissions/:id/changes', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const change: Partial<ContentChange> = await request.json();
  const user = (request as any).user as User;

  const newChange: ContentChange = {
    id: crypto.randomUUID(),
    submissionId: id,
    field: change.field!,
    oldValue: change.oldValue!,
    newValue: change.newValue!,
    changedBy: user.id,
    changedAt: new Date().toISOString(),
    reason: change.reason
  };

  // Get the current submission
  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }

  // Check if user has permission to track changes on this submission
  const canTrackChanges = isReviewer(user) ||
                         submission.submittedBy === user.id ||
                         (submission.requiredApprovers && submission.requiredApprovers.includes(user.email));

  if (!canTrackChanges) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  // Add the change
  submission.changes.push(newChange);

  // Update the submission in cache
  await putObject(`content_submissions/${id}`, submission, env);
  
  // Invalidate the submissions list cache
  await deleteObject('content_submissions/list', env);

  return json(newChange);
});

// Delete a submission
router.delete('/submissions/:id', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const user = (request as any).user as User;

  // Get the submission from cache
  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }

  // Check if user has permission to delete this submission
  const canDelete = isReviewer(user) ||
                   submission.submittedBy === user.id;

  if (!canDelete) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  // Delete the submission from cache
  await deleteObject(`content_submissions/${id}`, env);
  
  // Invalidate the submissions list cache
  await deleteObject('content_submissions/list', env);

  return json({ message: 'Submission deleted successfully' });
});

// Upload image for rich text editor content
router.post('/editor-images/upload', withAuth, async (request: Request, env: any) => {
  try {
    const formData = await request.formData();
    const user = (request as any).user as User;
    const mediaFile = formData.get('media') as File;
    const thumbnailFile = formData.get('thumbnail') as File;
    const mediumFile = formData.get('medium') as File;
    const isPublic = formData.get('isPublic') === 'true';
    const takenBy = formData.get('takenBy') as string;

    if (!mediaFile) {
      return json({ error: 'No media file provided' }, { status: 400 });
    }

    const result = await uploadMedia(
      mediaFile,
      thumbnailFile,
      user.id,
      env,
      isPublic,
      undefined, // No groupId for editor images
      takenBy,
      mediumFile
    );

    if (result.success && result.mediaItem) {
      return json(result.mediaItem);
    } else {
      return json({ error: result.message }, { status: 500 });
    }
  } catch (error) {
    console.error('Error uploading editor image:', error);
    return json({ error: 'Failed to upload image' }, { status: 500 });
  }
});

// Import a public https image (pasted into the editor) so the browser can upload a copy to
// the gallery. SSRF guards live in utils/imageImport. The old Google-Docs-only route is kept
// as an alias for clients loaded before the rename.
export async function importEditorImage(request: Request, options?: FetchPublicImageOptions): Promise<Response> {
  let imageUrl: unknown;
  try {
    ({ imageUrl } = (await request.json()) as { imageUrl?: unknown });
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof imageUrl !== 'string' || !imageUrl || imageUrl.length > 8192) {
    return json({ error: 'Invalid image URL' }, { status: 400 });
  }

  try {
    const { data, contentType } = await fetchPublicImage(imageUrl, options);
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof ImageImportError) {
      console.warn(`Editor image import refused (${error.status}): ${error.message}`);
      return json({ error: error.message }, { status: error.status });
    }
    console.error('Editor image import failed:', error);
    return json({ error: 'Could not import the image' }, { status: 502 });
  }
}

router.post('/editor-images/import', withAuth, (request: Request) => importEditorImage(request));
router.post('/editor-images/proxy-google-docs', withAuth, (request: Request) => importEditorImage(request));
