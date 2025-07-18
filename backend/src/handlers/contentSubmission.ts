import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { ContentSubmission, ContentComment, ContentApproval, ContentChange, UserType, User, Group } from '../types';
import { Role } from '../services/roleService';
import { getObject, putObject, deleteObject, listObjects } from '../services/cacheService';
import { withAuth } from '../authWrappers';
import { broadcastToSubmissionRoom } from './websocket';
import { uploadMedia } from '../services/mediaService';
import { Env } from '../utils/sessionManager';

export const router = AutoRouter({ base: '/api/content' });

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
  const canApprove = user.userType === UserType.Admin ||
                    user.userType === UserType.CouncilManager ||
                    user.userType === UserType.CommsCadre ||
                    (submission.requiredApprovers && submission.requiredApprovers.includes(user.email));

  if (!canApprove) {
    return json({ error: 'Access denied' }, { status: 403 });
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

  // Check if all required approvers have approved
  const allRequiredApproversApproved = submission.requiredApprovers?.every(approverEmail =>
    submission.approvals.some(approval => 
      approval.approverEmail === approverEmail && approval.status === 'approved'
    ) ?? false
  ) ?? true; // If no requiredApprovers specified, consider it approved

  // Get total required approvers
  const requiredCommsCadreApprovers = 2; // Minimum required CommsCadre approvers
  const requiredCouncilManagers = submission.assignedCouncilManagers?.length || 0;

  // Update status if needed - check both legacy logic and new requiredApprovers logic
  const legacyApprovalMet = commsCadreApprovals >= requiredCommsCadreApprovers && 
                           councilManagerApprovals.length >= requiredCouncilManagers;
  
  const newApprovalMet = allRequiredApproversApproved;

  if (legacyApprovalMet && newApprovalMet) {
    submission.status = 'approved';
    submission.finalApprovalDate = new Date().toISOString();
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
