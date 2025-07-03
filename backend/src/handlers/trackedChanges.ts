import { CustomRequest } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { AutoRouter } from 'itty-router';
import { 
  getTrackedChanges, 
  createTrackedChange, 
  updateChangeStatus, 
  getChangeComments, 
  addChangeComment, 
  getChangeHistory,
  getCompleteProposedVersion,
  TrackedChange,
  ChangeComment
} from '../services/trackedChangesService';
import { getObject } from '../services/cacheService';
import { mergeTextIntoLexicalJson } from '../services/trackedChangesService';

// Get all tracked changes for a submission
export async function getTrackedChangesHandler(request: CustomRequest, env: any): Promise<Response> {
  const { submissionId } = request.params!;
  
  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Get submission to check permissions (you'll need to implement this based on your content submission service)
    // For now, we'll assume the user has access if they're authenticated
    
    // Check if user has access
    const hasAccess = request.user.userType === 'Admin' ||
                     request.user.userType === 'CommsCadre' ||
                     request.user.userType === 'CouncilManager' ||
                     true; // TODO: Check if user is the submitter

    if (!hasAccess) {
      return new Response('Forbidden', { status: 403 });
    }

    // Get all changes for the submission
    const changes = await getTrackedChanges(submissionId, env);

    // Get the original submission (for richTextContent)
    const submission = await getObject(`content_submissions/${submissionId}`, env) as import('../types').ContentSubmission | null;

    // Get comments for each change
    const changesWithComments = await Promise.all(
      changes.map(async (change: TrackedChange) => {
        const comments = await getChangeComments(change.id, env);
        return {
          ...change,
          comments
        };
      })
    );

    // Get complete proposed versions for each field
    const fields = [...new Set(changes.map(change => change.field))];
    const proposedVersions: Record<string, string> = {};
    const proposedVersionsRichText: Record<string, string> = {};
    
    for (const field of fields) {
      const completeVersion = await getCompleteProposedVersion(submissionId, field, env);
      if (completeVersion) {
        proposedVersions[field] = completeVersion;
        // If the original is Lexical JSON, merge the new text into it
        if (submission && submission.richTextContent && submission.richTextContent.trim().startsWith('{')) {
          proposedVersionsRichText[field] = mergeTextIntoLexicalJson(submission.richTextContent, completeVersion);
        }
      }
    }

    return new Response(JSON.stringify({
      changes: changesWithComments,
      proposedVersions,
      proposedVersionsRichText
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error fetching tracked changes:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Create a new tracked change (suggestion)
export async function createTrackedChangeHandler(request: CustomRequest, env: any): Promise<Response> {
  const { submissionId } = request.params!;
  
  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { field, oldValue, newValue } = await request.json();

    if (!field || !oldValue || !newValue) {
      return new Response('Missing required fields', { status: 400 });
    }

    // Create the tracked change
    const newChange = await createTrackedChange(
      submissionId,
      field,
      oldValue,
      newValue,
      request.user.id,
      request.user.name,
      env
    );

    return new Response(JSON.stringify(newChange), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error creating tracked change:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Approve or reject a tracked change
export async function updateChangeStatusHandler(request: CustomRequest, env: any): Promise<Response> {
  const { changeId } = request.params!;
  
  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { status, comment } = await request.json();

    if (!['approved', 'rejected'].includes(status)) {
      return new Response('Invalid status', { status: 400 });
    }

    // Check permissions
    const hasPermission = request.user.userType === 'Admin' ||
                         request.user.userType === 'CommsCadre' ||
                         request.user.userType === 'CouncilManager';

    if (!hasPermission) {
      return new Response('Forbidden', { status: 403 });
    }

    // Update the change status
    const updatedChange = await updateChangeStatus(
      changeId,
      status,
      env,
      status === 'approved' ? request.user.id : undefined,
      status === 'approved' ? request.user.name : undefined,
      status === 'rejected' ? request.user.id : undefined,
      status === 'rejected' ? request.user.name : undefined
    );

    if (!updatedChange) {
      return new Response('Change not found', { status: 404 });
    }

    // If there's a comment, add it
    if (comment) {
      await addChangeComment(
        changeId,
        updatedChange.submissionId,
        comment,
        request.user.id,
        request.user.name,
        env
      );
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error updating change status:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Add a comment to a tracked change
export async function addChangeCommentHandler(request: CustomRequest, env: any): Promise<Response> {
  const { changeId } = request.params!;
  
  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { content } = await request.json();

    if (!content) {
      return new Response('Missing comment content', { status: 400 });
    }

    // Get the change to get the submission ID
    const changes = await getTrackedChanges('', env); // Get all changes to find the one with matching ID
    const change = changes.find(c => c.id === changeId);
    
    if (!change) {
      return new Response('Change not found', { status: 404 });
    }

    // Create the comment
    const newComment = await addChangeComment(
      changeId,
      change.submissionId,
      content,
      request.user.id,
      request.user.name,
      env
    );

    return new Response(JSON.stringify(newComment), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error adding comment:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Get change history for analytics
export async function getChangeHistoryHandler(request: CustomRequest, env: any): Promise<Response> {
  if (!request.user || !['Admin', 'CommsCadre', 'CouncilManager'].includes(request.user.userType)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const { startDate, endDate, userId } = request.params!;
    
    const result = await getChangeHistory(env, startDate, endDate, userId);

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error fetching change history:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Create the router
export const router = AutoRouter({ base: '/tracked-changes' })
  .get('/submission/:submissionId', getTrackedChangesHandler)
  .post('/submission/:submissionId', createTrackedChangeHandler)
  .put('/change/:changeId/status', updateChangeStatusHandler)
  .post('/change/:changeId/comment', addChangeCommentHandler)
  .get('/history', getChangeHistoryHandler);