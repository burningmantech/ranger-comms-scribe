import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { ContentSubmission, ContentComment, ContentApproval, ContentChange, UserType, User, Group, CouncilRole } from '../types';
import { Role } from '../services/roleService';
import { getObject, putObject, deleteObject, listObjects } from '../services/cacheService';
import { withAuth } from '../authWrappers';
import { broadcastToSubmissionRoom } from './websocket';
import { uploadMedia } from '../services/mediaService';
import { Env } from '../utils/sessionManager';
import { getCouncilManagersForRole } from '../services/councilManagerService';

export const router = AutoRouter({ base: '/api/content' });

// Helper: recompute approval status using unique latest decisions and membership lists
async function recomputeApprovalStatus(submission: ContentSubmission, env: any): Promise<ContentSubmission> {
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

  const allRequiredApproversApproved = required.every(email =>
    uniqueApprovals.some(a => (a.approverEmail || '').trim().toLowerCase() === email && a.status === 'approved')
  );

  // Load comms cadre active list
  const commsCadreList = (await getObject<any[]>('comms_cadre:active', env)) || [];
  const commsCadreEmails = new Set((commsCadreList.filter(m => m.active).map(m => (m.email || '').trim().toLowerCase())));

  // Load all council manager emails across roles
  const councilEmails = new Set<string>();
  for (const role of Object.values(CouncilRole)) {
    try {
      const members = await getCouncilManagersForRole(role as CouncilRole, env);
      for (const m of members || []) {
        if (m && m.email) councilEmails.add(m.email.trim().toLowerCase());
      }
    } catch {}
  }

  const hasCouncilApproval = uniqueApprovals.some(a => {
    const email = (a.approverEmail || '').trim().toLowerCase();
    return (a.approverType === UserType.CouncilManager) || (a.approverRoles || []).includes('CouncilManager') || councilEmails.has(email);
  }) && uniqueApprovals.some(a => a.status === 'approved');

  const hasCommsCadreApproval = uniqueApprovals.some(a => {
    const email = (a.approverEmail || '').trim().toLowerCase();
    return (a.approverType === UserType.CommsCadre) || (a.approverRoles || []).includes('CommsCadre') || commsCadreEmails.has(email);
  }) && uniqueApprovals.some(a => a.status === 'approved');

  if (allRequiredApproversApproved && hasCouncilApproval && hasCommsCadreApproval) {
    submission.status = 'approved';
    submission.finalApprovalDate = submission.finalApprovalDate || new Date().toISOString();
  }

  return submission;
}

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
    announcementSent: false,
    assignedCouncilManagers: submission.assignedCouncilManagers || [],
    requiredApprovers: submission.requiredApprovers || []
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
  if (hasContentManagementGroup || user.userType === UserType.Admin) {
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
  const hasAccess = user.userType === UserType.Admin ||
                   submission.submittedBy === user.id ||
                   user.userType === UserType.CouncilManager ||
                   user.userType === UserType.CommsCadre ||
                   (submission.approvals && submission.approvals.some((a: ContentApproval) => a.approverId === user.id)) ||
                   (submission.requiredApprovers && submission.requiredApprovers.includes(user.email));

  if (!hasAccess) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  // Get proposed versions from tracked changes system
  const savedProposedVersions = await getObject(`proposed_versions/${id}`, env) as any;
  
  console.log('🔍 Content submission GET - checking for proposed versions:', {
    submissionId: id,
    hasProposedVersions: !!savedProposedVersions,
    proposedVersionsRichText: savedProposedVersions?.proposedVersionsRichText ? 'present' : 'missing',
    proposedVersionsContent: savedProposedVersions?.proposedVersionsContent ? 'present' : 'missing'
  });
  
  // Merge proposed versions into submission if they exist
  const submissionWithProposedVersions = {
    ...submission,
    proposedVersions: savedProposedVersions ? {
      richTextContent: savedProposedVersions.proposedVersionsRichText,
      content: savedProposedVersions.proposedVersionsContent,
      lastModified: savedProposedVersions.lastUpdatedAt,
      lastModifiedBy: savedProposedVersions.lastUpdatedBy
    } : undefined
  };

  console.log('🔍 Content submission GET - response:', {
    submissionId: id,
    hasProposedVersions: !!submissionWithProposedVersions.proposedVersions,
    proposedVersionsRichTextContentLength: submissionWithProposedVersions.proposedVersions?.richTextContent?.length,
    proposedVersionsContentLength: submissionWithProposedVersions.proposedVersions?.content?.length,
    proposedVersionsRichTextContentIsLexical: submissionWithProposedVersions.proposedVersions?.richTextContent ? submissionWithProposedVersions.proposedVersions.richTextContent.includes('"root"') : false
  });

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

  // Update the submission
  const updatedSubmission = {
    ...submission,
    ...updates,
    updatedAt: new Date().toISOString()
  };

  // If proposedVersions are included, also save them to the tracked changes system
  if (updates.proposedVersions) {
    try {
      const { putObject } = await import('../services/cacheService');
      const proposedVersionsData = {
        submissionId: id,
        proposedVersionsRichText: updates.proposedVersions.richTextContent,
        proposedVersionsContent: updates.proposedVersions.content,
        lastUpdatedBy: user.id,
        lastUpdatedAt: new Date().toISOString()
      };
      
      console.log('🔍 Content submission handler - saving proposed versions:', {
        submissionId: id,
        hasRichTextContent: !!updates.proposedVersions.richTextContent,
        richTextContentLength: updates.proposedVersions.richTextContent?.length,
        richTextContentIsLexical: updates.proposedVersions.richTextContent ? updates.proposedVersions.richTextContent.includes('"root"') : false,
        hasContent: !!updates.proposedVersions.content,
        contentLength: updates.proposedVersions.content?.length,
        richTextContentPreview: updates.proposedVersions.richTextContent?.substring(0, 100)
      });
      
      await putObject(`proposed_versions/${id}`, proposedVersionsData, env);
      console.log('✅ Proposed versions saved from content submission update');
    } catch (error) {
      console.warn('Failed to save proposed versions:', error);
    }
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
  await recomputeApprovalStatus(submission, env);

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
      title: submission.title
    }
  }, env);

  return json(approval);
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

// Send announcement email after full approval; Comms Cadre can send
router.post('/submissions/:id/send-email', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const user = (request as any).user as User;

  const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }

  // Must be approved first
  if (submission.status !== 'approved') {
    return json({ error: 'Submission not approved yet' }, { status: 400 });
  }

  // Only Comms Cadre or Admin can send
  if (!(user.userType === UserType.CommsCadre || user.userType === UserType.Admin)) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  // Send to appropriate list. For now, announcements go to rangers-announce
  const toAddress = 'rangers-announce@burningman.org';
  try {
    if (!env.SESKey || !env.SESSecret) {
      // Fall back to EMAIL provider if configured
      if (env.EMAIL) {
        await env.EMAIL.send({
          to: toAddress,
          subject: submission.title,
          text: submission.content
        });
      } else {
        return json({ error: 'Email service not configured' }, { status: 500 });
      }
    } else {
      const { sendEmail } = await import('../utils/email');
      await sendEmail(toAddress, submission.title, submission.content, env.SESKey, env.SESSecret);
    }

    submission.status = 'sent';
    submission.sentBy = user.id || user.email;
    submission.sentAt = new Date().toISOString();
    submission.announcementSent = true;

    await putObject(`content_submissions/${id}`, submission, env);
    await deleteObject('content_submissions/list', env);

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

// Add the new proxy route for Google Docs images
router.post('/editor-images/proxy-google-docs', withAuth, async (request: Request, env: any) => {
  console.log('🔧 Proxy route handler called');
  const user = (request as any).user;
  console.log('👤 User from withAuth:', user);
  
  return await proxyGoogleDocsImage(request, env);
});

// Proxy endpoint for downloading Google Docs images
export async function proxyGoogleDocsImage(request: Request, env: Env): Promise<Response> {
  console.log('🔧 proxyGoogleDocsImage called');
  
  if (request.method !== 'POST') {
    console.log('❌ Method not allowed:', request.method);
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    console.log('📥 Parsing request JSON...');
    const { imageUrl } = await request.json();
    
    if (!imageUrl || typeof imageUrl !== 'string') {
      console.log('❌ Invalid image URL:', imageUrl);
      return new Response('Invalid image URL', { status: 400 });
    }

    // Validate that it's a Google Docs/userusercontent URL for security
    if (!imageUrl.includes('googleusercontent.com') && !imageUrl.includes('docs.google.com')) {
      console.log('❌ Non-Google URL rejected:', imageUrl);
      return new Response('Only Google Docs images are supported', { status: 400 });
    }

    console.log('🔄 Proxying Google Docs image:', imageUrl);

    // Download the image from Google's servers
    const imageResponse = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    console.log('📥 Google response status:', imageResponse.status);
    console.log('📥 Google response content-type:', imageResponse.headers.get('content-type'));
    console.log('📥 Google response content-length:', imageResponse.headers.get('content-length'));

    if (!imageResponse.ok) {
      console.error('❌ Failed to fetch image from Google:', imageResponse.status, imageResponse.statusText);
      
      // Try to get the response body for more details
      try {
        const errorText = await imageResponse.text();
        console.error('❌ Google error response body:', errorText);
      } catch (e) {
        console.error('❌ Could not read Google error response');
      }
      
      return new Response(`Failed to fetch image: ${imageResponse.status} ${imageResponse.statusText}`, { status: 400 });
    }

    // Get the image data
    const imageData = await imageResponse.arrayBuffer();
    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';

    console.log('✅ Successfully proxied Google Docs image:', {
      size: imageData.byteLength,
      contentType
    });

    // Return the image data to the frontend
    // Let the main router handle CORS via corsify
    return new Response(imageData, {
      headers: {
        'Content-Type': contentType
      }
    });

  } catch (error) {
    console.error('❌ Error proxying Google Docs image:', error);
    return new Response('Internal server error', { status: 500 });
  }
} 
