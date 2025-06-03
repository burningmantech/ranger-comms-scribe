import { Router } from 'itty-router';
import { ContentSubmission, ContentComment, ContentApproval, ContentChange, UserType, User } from '../types';
import { withAuth } from '../authWrappers';

const router = Router();

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
    status: 'draft',
    formFields: submission.formFields || [],
    comments: [],
    approvals: [],
    changes: [],
    commsCadreApprovals: 0,
    councilManagerApprovals: [],
    announcementSent: false
  };

  await env.DB.prepare(
    'INSERT INTO content_submissions (id, title, content, submittedBy, submittedAt, status, formFields, comments, approvals, changes, commsCadreApprovals, councilManagerApprovals, announcementSent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    newSubmission.id,
    newSubmission.title,
    newSubmission.content,
    newSubmission.submittedBy,
    newSubmission.submittedAt,
    newSubmission.status,
    JSON.stringify(newSubmission.formFields),
    JSON.stringify(newSubmission.comments),
    JSON.stringify(newSubmission.approvals),
    JSON.stringify(newSubmission.changes),
    newSubmission.commsCadreApprovals,
    JSON.stringify(newSubmission.councilManagerApprovals),
    newSubmission.announcementSent
  ).run();

  return new Response(JSON.stringify(newSubmission), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Get all submissions (filtered by user permissions)
router.get('/submissions', withAuth, async (request: Request, env: any) => {
  const user = (request as any).user as User;
  let submissions;

  if (user.userType === UserType.CommsCadre || user.userType === UserType.CouncilManager) {
    submissions = await env.DB.prepare('SELECT * FROM content_submissions').all();
  } else {
    submissions = await env.DB.prepare(
      'SELECT * FROM content_submissions WHERE submittedBy = ? OR id IN (SELECT submissionId FROM content_approvals WHERE approverId = ?)'
    ).bind(user.id, user.id).all();
  }

  return new Response(JSON.stringify(submissions.results), {
    headers: { 'Content-Type': 'application/json' }
  });
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

  await env.DB.prepare(
    'UPDATE content_submissions SET comments = json_set(comments, "$[#]", ?) WHERE id = ?'
  ).bind(JSON.stringify(newComment), id).run();

  return new Response(JSON.stringify(newComment), {
    headers: { 'Content-Type': 'application/json' }
  });
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

  await env.DB.prepare(
    'UPDATE content_submissions SET approvals = json_set(approvals, "$[#]", ?) WHERE id = ?'
  ).bind(JSON.stringify(approval), id).run();

  // Update submission status based on approvals
  const submission = await env.DB.prepare('SELECT * FROM content_submissions WHERE id = ?').bind(id).first();
  const approvals = JSON.parse(submission.approvals);
  
  const commsCadreApprovals = approvals.filter((a: ContentApproval) => 
    a.approverType === UserType.CommsCadre && a.status === 'approved'
  ).length;

  const councilManagerApprovals = approvals.filter((a: ContentApproval) => 
    a.approverType === UserType.CouncilManager && a.status === 'approved'
  );

  let newStatus = submission.status;
  if (commsCadreApprovals >= 2 && councilManagerApprovals.length > 0) {
    newStatus = 'approved';
    // Send announcement email
    await env.EMAIL.send({
      to: 'announce@rangers.burningman.org',
      subject: `New Approved Content: ${submission.title}`,
      text: `A new piece of content has been approved and is ready for announcement.\n\nTitle: ${submission.title}\nContent: ${submission.content}`
    });
  }

  await env.DB.prepare(
    'UPDATE content_submissions SET status = ?, commsCadreApprovals = ?, councilManagerApprovals = ? WHERE id = ?'
  ).bind(newStatus, commsCadreApprovals, JSON.stringify(councilManagerApprovals), id).run();

  return new Response(JSON.stringify(approval), {
    headers: { 'Content-Type': 'application/json' }
  });
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

  await env.DB.prepare(
    'UPDATE content_submissions SET changes = json_set(changes, "$[#]", ?) WHERE id = ?'
  ).bind(JSON.stringify(newChange), id).run();

  return new Response(JSON.stringify(newChange), {
    headers: { 'Content-Type': 'application/json' }
  });
});

export default router; 