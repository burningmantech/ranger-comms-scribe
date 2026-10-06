import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { ContentSubmission, ContentComment, ContentApproval, ContentChange, UserType, User, Group, CouncilRole, ApprovalGates } from '../types';
import { Role } from '../services/roleService';
import { getObject, putObject, deleteObject, listObjects } from '../services/cacheService';
import { withAuth } from '../authWrappers';
import { broadcastToSubmissionRoom } from './websocket';
import { uploadMedia } from '../services/mediaService';
import { buildAnnouncementEmail, embedGalleryImages } from '../services/announcementEmail';
import { fetchPublicImage, FetchPublicImageOptions, ImageImportError } from '../utils/imageImport';
import { Env } from '../utils/sessionManager';
import { getCouncilManagersForRole } from '../services/councilManagerService';
import { getActiveCommsCadreEmails, isCommsCadre } from '../services/commsCadreService';
import { audienceKeys, STANDALONE_EMAIL_AUDIENCES } from '../utils/audiences';
import { InputError, cleanKeyDates, cleanNewsletterRequest, cleanWritingHelp } from '../utils/newsletterInput';
import { getEdition, publishDocumentPage } from '../services/newsletterService';
import { getTrackedChanges, ChangeComment } from '../services/trackedChangesService';

export const router = AutoRouter({ base: '/api/content' });

// Helper: recompute approval status using unique latest decisions and membership lists.
// Promotes to 'approved' only; never demotes (syncSubmissionStatus does that) and never
// touches a 'sent' submission.
// Every council manager's email (lowercased), across all roles. The roles are read in
// parallel: this runs on every tracked-change operation, and each read is a store round trip.
async function loadCouncilEmails(env: any): Promise<Set<string>> {
  const lists = await Promise.all(
    Object.values(CouncilRole).map((role) =>
      getCouncilManagersForRole(role as CouncilRole, env).catch(() => [])
    )
  );
  const emails = new Set<string>();
  for (const members of lists) {
    for (const m of members || []) {
      if (m && m.email) emails.add(m.email.trim().toLowerCase());
    }
  }
  return emails;
}

export async function recomputeApprovalStatus(submission: ContentSubmission, env: any): Promise<ContentSubmission> {
  if (submission.status === 'sent') return submission;
  // Deduplicate by latest decision per approver
  const approvalsByApprover = new Map<string, ContentApproval>();
  for (const a of submission.approvals || []) {
    const key = (a.approverEmail || a.approverId || '').trim().toLowerCase();
    if (!key) continue;
    const prev = approvalsByApprover.get(key);
    if (!prev) {
      approvalsByApprover.set(key, a);
    } else {
      const prevTime = new Date(prev.updatedAt || prev.createdAt).getTime();
      const currTime = new Date(a.updatedAt || a.createdAt).getTime();
      approvalsByApprover.set(key, currTime >= prevTime ? a : prev);
    }
  }
  const uniqueApprovals = Array.from(approvalsByApprover.values());

  // Normalize required approvers
  const required = (submission.requiredApprovers || []).map(e => (e || '').trim().toLowerCase());

  const allRequiredApproversApproved = required.length > 0 && required.every(email =>
    uniqueApprovals.some(a => (a.approverEmail || '').trim().toLowerCase() === email && a.status === 'approved')
  );

  // Load comms cadre active list
  const commsCadreEmails = await getActiveCommsCadreEmails(env);

  // Load all council manager emails across roles
  const councilEmails = await loadCouncilEmails(env);

  // Check that a council manager specifically approved (not just that they exist AND someone approved)
  const hasCouncilApproval = uniqueApprovals.some(a => {
    const email = (a.approverEmail || '').trim().toLowerCase();
    const isCouncil = (a.approverType === UserType.CouncilManager) || (a.approverRoles || []).includes('CouncilManager') || councilEmails.has(email);
    return isCouncil && a.status === 'approved';
  });

  const hasCommsCadreApproval = uniqueApprovals.some(a => {
    const email = (a.approverEmail || '').trim().toLowerCase();
    const isCommsCadre = (a.approverType === UserType.CommsCadre) || (a.approverRoles || []).includes('CommsCadre') || commsCadreEmails.has(email);
    return isCommsCadre && a.status === 'approved';
  });

  if (allRequiredApproversApproved && hasCouncilApproval && hasCommsCadreApproval) {
    // Gate: all tracked changes must be resolved before approval
    const changes = await getTrackedChanges(submission.id, env);
    const pendingChanges = changes.filter(c => c.status === 'pending');
    if (pendingChanges.length > 0) {
      return submission; // Don't approve until all tracked changes are resolved
    }

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
 * created change can only make a change pending).
 */
export async function syncSubmissionStatus(
  submissionId: string,
  env: any,
  actor?: { id?: string; email?: string; name?: string },
  options: { onlyDemote?: boolean } = {}
): Promise<ContentSubmission | null> {
  try {
    const submission = await getObject<ContentSubmission>(`content_submissions/${submissionId}`, env);
    if (!submission || submission.status === 'sent') return submission;
    const before = submission.status;
    if (before === 'approved') {
      const changes = await getTrackedChanges(submissionId, env);
      if (changes.some(c => c.status === 'pending')) {
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
        ...(changed ? { previousStatus: before, title: submission.title, reason: 'tracked_changes' } : {}),
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
  return user.userType === UserType.Admin ||
    submission.submittedBy === user.id ||
    user.userType === UserType.CouncilManager ||
    user.userType === UserType.CommsCadre ||
    !!(submission.approvals && submission.approvals.some((a: ContentApproval) => a.approverId === user.id)) ||
    !!(submission.requiredApprovers && submission.requiredApprovers.includes(user.email));
}

// Compute structured approval gate data for the frontend approval tracker
export async function computeApprovalGates(submission: ContentSubmission, env: any): Promise<ApprovalGates> {
  // Deduplicate by latest decision per approver (same logic as recomputeApprovalStatus)
  const approvalsByApprover = new Map<string, ContentApproval>();
  for (const a of submission.approvals || []) {
    const key = (a.approverEmail || a.approverId || '').trim().toLowerCase();
    if (!key) continue;
    const prev = approvalsByApprover.get(key);
    if (!prev) {
      approvalsByApprover.set(key, a);
    } else {
      const prevTime = new Date(prev.updatedAt || prev.createdAt).getTime();
      const currTime = new Date(a.updatedAt || a.createdAt).getTime();
      approvalsByApprover.set(key, currTime >= prevTime ? a : prev);
    }
  }
  const uniqueApprovals = Array.from(approvalsByApprover.values());

  // --- Required approvers gate ---
  const required = (submission.requiredApprovers || []).map(e => (e || '').trim().toLowerCase());
  const requiredDetails = required.map(email => {
    const approval = uniqueApprovals.find(
      a => (a.approverEmail || '').trim().toLowerCase() === email
    );
    return {
      email,
      name: approval?.approverName,
      status: (approval ? approval.status : 'pending') as 'approved' | 'rejected' | 'pending',
      date: approval ? (approval.updatedAt || approval.createdAt) : undefined,
    };
  });
  const approvedCount = requiredDetails.filter(d => d.status === 'approved').length;

  // --- Council manager gate ---
  const councilEmails = await loadCouncilEmails(env);

  const councilApproval = uniqueApprovals.find(a => {
    const email = (a.approverEmail || '').trim().toLowerCase();
    const isCouncil = (a.approverType === UserType.CouncilManager) ||
      (a.approverRoles || []).includes('CouncilManager') ||
      councilEmails.has(email);
    return isCouncil && a.status === 'approved';
  });

  // --- Comms cadre gate ---
  const commsCadreEmails = await getActiveCommsCadreEmails(env);

  const commsCadreApproval = uniqueApprovals.find(a => {
    const email = (a.approverEmail || '').trim().toLowerCase();
    const isCommsCadre = (a.approverType === UserType.CommsCadre) ||
      (a.approverRoles || []).includes('CommsCadre') ||
      commsCadreEmails.has(email);
    return isCommsCadre && a.status === 'approved';
  });

  // --- Tracked changes gate ---
  const changes = await getTrackedChanges(submission.id, env);
  const pendingChanges = changes.filter(c => c.status === 'pending');

  return {
    councilManager: {
      met: !!councilApproval,
      approver: councilApproval?.approverEmail,
      approverName: councilApproval?.approverName,
      date: councilApproval ? (councilApproval.updatedAt || councilApproval.createdAt) : undefined,
      comment: councilApproval?.comment,
    },
    commsCadre: {
      met: !!commsCadreApproval,
      approver: commsCadreApproval?.approverEmail,
      approverName: commsCadreApproval?.approverName,
      date: commsCadreApproval ? (commsCadreApproval.updatedAt || commsCadreApproval.createdAt) : undefined,
      comment: commsCadreApproval?.comment,
    },
    requiredApprovers: {
      met: required.length > 0 && approvedCount === required.length,
      approved: approvedCount,
      total: required.length,
      details: requiredDetails,
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
// endpoint (PATCH /submissions/:id/newsletter); PUT bodies often carry a stale loaded copy.
const PUT_IGNORED_FIELDS = [
  'newsletter', 'keyDates', 'writingHelp',
  'newsletterEditionId', 'newsletterSentIn', 'publicSlug', 'publicPublishedAt',
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
  
  // Get user's groups and their associated roles
  const userGroups = await Promise.all((user.groups || []).map(async (groupId: string) => {
    const group = await getObject<Group>(`groups/${groupId}`, env);
    if (!group) return null;
    
    // Get the role associated with this group
    const role = await getObject<Role>(`roles/${group.name}`, env);
    return { group, role };
  }));
  
  // Check if user has any group with content management permissions
  const hasContentManagementGroup = userGroups.some((groupData) => {
    if (!groupData) return false;
    const { role } = groupData;
    return role && (
      role.permissions.canEdit ||
      role.permissions.canApprove ||
      role.permissions.canCreateSuggestions ||
      role.permissions.canApproveSuggestions ||
      role.permissions.canReviewSuggestions
    );
  });
  
  // Filter based on user's groups and permissions
  let submissions;
  if (hasContentManagementGroup || user.userType === UserType.Admin || user.userType === UserType.CouncilManager || user.userType === UserType.CommsCadre) {
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

    const isRequiredApprover = (submission.requiredApprovers || []).includes(user.email);
    const hasActed = (submission.approvals || []).some(
      (a: ContentApproval) =>
        a.approverEmail === user.email || a.approverId === user.id
    );

    const isReviewer =
      user.userType === UserType.CommsCadre ||
      user.userType === UserType.CouncilManager ||
      user.userType === UserType.Admin;

    const gates = await computeApprovalGates(submission, env);

    if (isRequiredApprover && !hasActed) {
      needsAction.push({ ...submission, approvalGates: gates });
    } else if (isReviewer && !hasActed) {
      if (
        (user.userType === UserType.CouncilManager && !gates.councilManager.met) ||
        (user.userType === UserType.CommsCadre && !gates.commsCadre.met)
      ) {
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

  // Check if user has permission to edit this submission
  // Allow editing required approvers by submitter, Council, or Comms Cadre
  const canEdit = user.userType === UserType.Admin ||
                 user.userType === UserType.CouncilManager ||
                 user.userType === UserType.CommsCadre ||
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
    approverType: user.userType,
    approverRoles: user.roles || [],
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
  const canApprove = user.userType === UserType.Admin ||
                    user.userType === UserType.CouncilManager ||
                    user.userType === UserType.CommsCadre ||
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

  // Only Communications Manager (specific Council role) or Admin can override
  let isCommsManagerRole = false;
  try {
    const commsManagers = await getCouncilManagersForRole(CouncilRole.CommunicationsManager, env);
    isCommsManagerRole = commsManagers.some((m) => m.email === user.email || m.userId === user.id);
  } catch (e) {
    // Fallback: if user is CouncilManager and system cannot read council roles, deny unless Admin
    isCommsManagerRole = false;
  }
  const canOverride = user.userType === UserType.Admin || isCommsManagerRole;
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
  const canRequest = user.userType === UserType.Admin ||
    user.userType === UserType.CouncilManager ||
    user.userType === UserType.CommsCadre ||
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
  const canEdit = user.userType === UserType.Admin ||
    submission.submittedBy === user.id ||
    (submission.requiredApprovers || []).some((e) => (e || '').toLowerCase() === (user.email || '').toLowerCase()) ||
    await isCommsCadre(user, env);
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

  return json({
    ...(await buildAnnouncementEmail(submission, env)),
    // Dev: a sent announcement can be sent again (Resend Email)
    resendAllowed: env.ALLOW_ANNOUNCEMENT_RESEND === true,
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
  if (!(user.userType === UserType.CommsCadre || user.userType === UserType.Admin)) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  // A newsletter item goes out in a newsletter edition, not on its own
  const audiences = audienceKeys(submission, await getTrackedChanges(id, env));
  if (audiences.includes('newsletter') && !audiences.some((a) => STANDALONE_EMAIL_AUDIENCES.has(a))) {
    return json({ error: 'This request goes out in the newsletter. Add it to an edition instead.' }, { status: 409 });
  }

  // The list comes from config so dev and staging can't email the real announcement list
  const toAddress = env.ANNOUNCE_EMAIL_TO;
  if (!toAddress) {
    return json({ error: 'Announcement email address is not configured (ANNOUNCE_EMAIL_TO)' }, { status: 503 });
  }
  try {
    const { sendEmail } = await import('../utils/email');
    // The approved document rendered for email (absolute image URLs), with the approved
    // Subject, Reply-To and signature: the same build as the email-preview endpoint.
    const email = await buildAnnouncementEmail(submission, env);
    // Gallery images go inside the email, so mail apps that block remote images show them
    const embedded = await embedGalleryImages(email.html, env);
    await sendEmail(toAddress, email.subject, email.text, env, {
      html: embedded.html,
      text: email.text,
      attachments: embedded.attachments,
      ...(email.replyTo ? { replyTo: email.replyTo } : {}),
    });

    submission.status = 'sent';
    submission.sentBy = user.id || user.email;
    submission.sentAt = new Date().toISOString();
    submission.announcementSent = true;

    await putObject(`content_submissions/${id}`, submission, env);
    await deleteObject('content_submissions/list', env);
    // Its public page, so a later newsletter can link to it ("Read more")
    try {
      await publishDocumentPage(id, env);
    } catch (err) {
      console.error('Could not publish the public page of', id, err);
    }

    await broadcastToSubmissionRoom(id, {
      type: 'status_changed',
      userId: user.id || user.email,
      userName: user.name,
      userEmail: user.email,
      data: { status: submission.status, title: submission.title }
    }, env);

    return json({ success: true });
  } catch (e: any) {
    return json({ error: e.message || 'Failed to send email' }, { status: 500 });
  }
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
  const canTrackChanges = user.userType === UserType.Admin ||
                         user.userType === UserType.CouncilManager ||
                         user.userType === UserType.CommsCadre ||
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
  const canDelete = user.userType === UserType.Admin ||
                   user.userType === UserType.CouncilManager ||
                   user.userType === UserType.CommsCadre ||
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
