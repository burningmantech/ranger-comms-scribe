import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { ContentSubmission, ContentComment, ContentApproval, ContentChange, UserType, User } from '../types';
import { getObject, putObject, deleteObject, listObjects } from '../services/cacheService';
import { withAuth } from '../authWrappers';

export const router = AutoRouter({ base: '/content' });

// Create a new content submission
router.post('/submissions', withAuth, async (request: Request, env: any) => {
  const submission: Partial<ContentSubmission> = await request.json();
  const user = (request as any).user as User;

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
    announcementSent: false
  };

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
  
  // Filter based on user type
  let submissions;
  if (user.userType === UserType.CommsCadre || user.userType === UserType.CouncilManager) {
    submissions = allSubmissions;
  } else {
    submissions = allSubmissions.filter((sub: ContentSubmission) => 
      sub.submittedBy === user.id || 
      sub.approvals.some((a: ContentApproval) => a.approverId === user.id)
    );
  }

  return json(submissions);
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

  return json(newComment);
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
    approverName: user.name,
    approverType: user.userType,
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

  // Add the approval
  submission.approvals.push(approval);
  
  // Update approval counts
  const commsCadreApprovals = submission.approvals.filter((a: ContentApproval) => 
    a.approverType === UserType.CommsCadre && a.status === 'approved'
  ).length;

  const councilManagerApprovals = submission.approvals.filter((a: ContentApproval) => 
    a.approverType === UserType.CouncilManager && a.status === 'approved'
  );

  // Update status if needed
  if (commsCadreApprovals >= 2 && councilManagerApprovals.length > 0) {
    submission.status = 'approved';
    // Send announcement email
    await env.EMAIL.send({
      to: 'announce@rangers.burningman.org',
      subject: `New Approved Content: ${submission.title}`,
      text: `A new piece of content has been approved and is ready for announcement.\n\nTitle: ${submission.title}\nContent: ${submission.content}`
    });
  }

  // Update the submission in cache
  await putObject(`content_submissions/${id}`, submission, env);
  
  // Invalidate the submissions list cache
  await deleteObject('content_submissions/list', env);

  return json(approval);
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

  // Add the change
  submission.changes.push(newChange);

  // Update the submission in cache
  await putObject(`content_submissions/${id}`, submission, env);
  
  // Invalidate the submissions list cache
  await deleteObject('content_submissions/list', env);

  return json(newChange);
}); 
