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
  getCompleteRichTextProposedVersion,
  undoChange,
  deleteChange,
  getCascadeDependencies,
  batchCreateTrackedChanges,
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
    
    // First, try to get saved proposed versions from cache
    const savedProposedVersions = await getObject(`proposed_versions/${submissionId}`, env) as any;
    
    console.log('🔍 Backend getTrackedChangesHandler - savedProposedVersions:', {
      hasData: !!savedProposedVersions,
      proposedVersionsRichText: savedProposedVersions?.proposedVersionsRichText ? 'present' : 'missing',
      proposedVersionsContent: savedProposedVersions?.proposedVersionsContent ? 'present' : 'missing',
      submissionId
    });
    
    if (savedProposedVersions) {
      console.log('📋 Found saved proposed versions for submission:', submissionId);
      if (savedProposedVersions.proposedVersionsRichText) {
        proposedVersionsRichText['content'] = savedProposedVersions.proposedVersionsRichText;
        console.log('✅ Set proposedVersionsRichText from cache:', {
          length: savedProposedVersions.proposedVersionsRichText.length,
          isLexical: savedProposedVersions.proposedVersionsRichText.includes('"root"')
        });
      }
      if (savedProposedVersions.proposedVersionsContent) {
        proposedVersions['content'] = savedProposedVersions.proposedVersionsContent;
        console.log('✅ Set proposedVersionsContent from cache:', {
          length: savedProposedVersions.proposedVersionsContent.length
        });
      }
    }
    
    // Fall back to calculating from changes if no saved versions
    for (const field of fields) {
      if (!proposedVersions[field]) {
        const completeVersion = await getCompleteProposedVersion(submissionId, field, env);
        if (completeVersion) {
          proposedVersions[field] = completeVersion;
        }
      }
      
      if (!proposedVersionsRichText[field]) {
        const completeRichTextVersion = await getCompleteRichTextProposedVersion(submissionId, field, env);
        if (completeRichTextVersion) {
          proposedVersionsRichText[field] = completeRichTextVersion;
        } else if (submission && submission.richTextContent && submission.richTextContent.trim().startsWith('{')) {
          // Fallback: merge the plain text into the original rich text structure
          proposedVersionsRichText[field] = mergeTextIntoLexicalJson(submission.richTextContent, proposedVersions[field] || '');
        }
      }
    }

    const response = {
      changes: changesWithComments,
      proposedVersions,
      proposedVersionsRichText
    };

    console.log('🔍 Backend getTrackedChangesHandler - response:', {
      changesCount: changesWithComments.length,
      proposedVersionsFields: Object.keys(proposedVersions),
      proposedVersionsRichTextFields: Object.keys(proposedVersionsRichText),
      proposedVersionsRichTextContentLength: proposedVersionsRichText.content?.length,
      proposedVersionsRichTextContentIsLexical: proposedVersionsRichText.content ? proposedVersionsRichText.content.includes('"root"') : false
    });

    return new Response(JSON.stringify(response), {
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
    const { field, oldValue, newValue, richTextOldValue, richTextNewValue, regionMap } = await request.json();

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
      env,
      richTextOldValue,
      richTextNewValue,
      regionMap
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

// Undo a change decision
export async function undoChangeHandler(request: CustomRequest, env: any): Promise<Response> {
  const { changeId } = request.params!;
  
  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Check permissions - same as approve/reject
    const hasPermission = request.user.userType === 'Admin' ||
                         request.user.userType === 'CommsCadre' ||
                         request.user.userType === 'CouncilManager';

    if (!hasPermission) {
      return new Response('Forbidden', { status: 403 });
    }

    // Undo the change
    const updatedChange = await undoChange(changeId, env);

    if (!updatedChange) {
      return new Response('Change not found or cannot be undone', { status: 404 });
    }

    return new Response(JSON.stringify({ success: true, change: updatedChange }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error undoing change:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Update proposed versions for a submission
export async function updateProposedVersionsHandler(request: CustomRequest, env: any): Promise<Response> {
  const { submissionId } = request.params!;
  
  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { proposedVersionsRichText, proposedVersionsContent } = await request.json();

    console.log('🔍 updateProposedVersionsHandler - received data:', {
      submissionId,
      hasProposedVersionsRichText: !!proposedVersionsRichText,
      proposedVersionsRichTextLength: proposedVersionsRichText?.length,
      proposedVersionsRichTextIsLexical: proposedVersionsRichText ? proposedVersionsRichText.includes('"root"') : false,
      hasProposedVersionsContent: !!proposedVersionsContent,
      proposedVersionsContentLength: proposedVersionsContent?.length,
      proposedVersionsRichTextPreview: proposedVersionsRichText?.substring(0, 100)
    });

    // Check permissions
    const hasPermission = request.user.userType === 'Admin' ||
                         request.user.userType === 'CommsCadre' ||
                         request.user.userType === 'CouncilManager' ||
                         true; // TODO: Check if user is the submitter

    if (!hasPermission) {
      return new Response('Forbidden', { status: 403 });
    }

    // Store the proposed versions
    const proposedVersionsData = {
      submissionId,
      proposedVersionsRichText,
      proposedVersionsContent,
      lastUpdatedBy: request.user.id,
      lastUpdatedAt: new Date().toISOString()
    };

    console.log('🔍 updateProposedVersionsHandler - saving data:', {
      submissionId,
      dataKeys: Object.keys(proposedVersionsData),
      proposedVersionsRichTextLength: proposedVersionsData.proposedVersionsRichText?.length,
      proposedVersionsContentLength: proposedVersionsData.proposedVersionsContent?.length,
      proposedVersionsRichTextIsLexical: proposedVersionsData.proposedVersionsRichText ? proposedVersionsData.proposedVersionsRichText.includes('"root"') : false
    });

    // Store in cache (you can also store this in D1 database if needed)
    const { putObject } = await import('../services/cacheService');
    await putObject(`proposed_versions/${submissionId}`, proposedVersionsData, env);

    console.log('✅ updateProposedVersionsHandler - proposed versions saved successfully for submission:', submissionId);

    return new Response(JSON.stringify({ success: true, data: proposedVersionsData }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error updating proposed versions:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Permanently delete a tracked change
export async function deleteChangeHandler(request: CustomRequest, env: any): Promise<Response> {
  const { changeId } = request.params!;

  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Check permissions - same as approve/reject
    const hasPermission = request.user.userType === 'Admin' ||
                         request.user.userType === 'CommsCadre' ||
                         request.user.userType === 'CouncilManager';

    if (!hasPermission) {
      return new Response('Forbidden', { status: 403 });
    }

    const result = await deleteChange(changeId, env);

    if (!result) {
      return new Response('Change not found', { status: 404 });
    }

    return new Response(JSON.stringify({ success: true, submissionId: result.submissionId }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error deleting change:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Get cascade dependency chain for a change
export async function getCascadeHandler(request: CustomRequest, env: any): Promise<Response> {
  const { submissionId, changeId } = request.params!;

  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const dependentIds = await getCascadeDependencies(submissionId, changeId, env);

    return new Response(JSON.stringify({ changeId, dependentIds }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error getting cascade dependencies:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Batch create tracked changes (all-or-nothing)
export async function batchCreateHandler(request: CustomRequest, env: any): Promise<Response> {
  const { submissionId } = request.params!;

  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { changes } = await request.json();

    if (!Array.isArray(changes) || changes.length === 0) {
      return new Response('Missing or empty changes array', { status: 400 });
    }

    // Validate each change has required fields
    for (const change of changes) {
      if (!change.field || !change.oldValue || !change.newValue) {
        return new Response('Each change must have field, oldValue, and newValue', { status: 400 });
      }
    }

    // Populate changedBy/changedByName from the authenticated user
    const changesData = changes.map((change: any) => ({
      field: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
      changedBy: request.user!.id,
      changedByName: request.user!.name,
      richTextOldValue: change.richTextOldValue,
      richTextNewValue: change.richTextNewValue,
      regionMap: change.regionMap,
      timestamp: change.timestamp,
    }));

    const createdChanges = await batchCreateTrackedChanges(submissionId, changesData, env);

    return new Response(JSON.stringify({ success: true, changes: createdChanges }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error batch creating changes:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Create the router
export const router = AutoRouter({ base: '/api/tracked-changes' })
  .get('/submission/:submissionId', getTrackedChangesHandler)
  .post('/submission/:submissionId', createTrackedChangeHandler)
  .put('/submission/:submissionId', updateProposedVersionsHandler)
  .post('/submission/:submissionId/batch', batchCreateHandler)
  .get('/submission/:submissionId/cascade/:changeId', getCascadeHandler)
  .put('/change/:changeId/status', updateChangeStatusHandler)
  .delete('/change/:changeId', deleteChangeHandler)
  .post('/change/:changeId/comment', addChangeCommentHandler)
  .post('/:changeId/undo', undoChangeHandler)
  .get('/history', getChangeHistoryHandler);