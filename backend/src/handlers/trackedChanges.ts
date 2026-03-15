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
import { getObject, putObject } from '../services/cacheService';
import { mergeTextIntoLexicalJson } from '../services/trackedChangesService';


/**
 * Strip tracked-change marker nodes (deleted-text, inserted-text) from Lexical
 * JSON so the persisted richTextContent is clean after accept/reject.
 *
 * - `deleted-text` nodes are removed entirely (the text was deleted).
 * - `inserted-text` nodes are replaced with a normal text node preserving the
 *   inserted text content and any formatting.
 * - Adjacent text nodes with identical format/style are merged.
 */
function cleanLexicalJson(jsonStr: string): string {
  try {
    const root = JSON.parse(jsonStr);

    function cleanChildren(children: any[]): any[] {
      const cleaned: any[] = [];
      for (const node of children) {
        if (node.type === 'deleted-text') {
          // Drop deletion markers — the text is gone
          continue;
        }
        if (node.type === 'inserted-text') {
          // Convert to a normal text node
          cleaned.push({
            detail: node.detail ?? 0,
            format: node.format ?? 0,
            mode: node.mode ?? 'normal',
            style: node.style ?? '',
            text: node.text ?? node.insertedText ?? '',
            type: 'text',
            version: 1,
          });
          continue;
        }
        // Recurse into children of element nodes (paragraphs, etc.)
        if (node.children && Array.isArray(node.children)) {
          node.children = cleanChildren(node.children);
        }
        cleaned.push(node);
      }

      // Merge adjacent text nodes with identical format & style
      const merged: any[] = [];
      for (const node of cleaned) {
        const prev = merged[merged.length - 1];
        if (
          prev &&
          prev.type === 'text' &&
          node.type === 'text' &&
          prev.format === node.format &&
          prev.style === node.style
        ) {
          prev.text += node.text;
        } else {
          merged.push(node);
        }
      }
      return merged;
    }

    if (root.root?.children) {
      root.root.children = cleanChildren(root.root.children);
    }
    return JSON.stringify(root);
  } catch {
    return jsonStr;
  }
}

/**
 * Extract plain text from a parsed Lexical JSON object.
 * Joins text from paragraph/heading blocks with newlines.
 */
function extractPlainTextFromLexicalJson(lexical: any): string {
  if (!lexical?.root?.children) return '';
  const lines: string[] = [];
  for (const block of lexical.root.children) {
    if (block.type === 'paragraph' || block.type === 'heading') {
      const texts: string[] = [];
      if (Array.isArray(block.children)) {
        for (const child of block.children) {
          if (child.type === 'text') {
            texts.push(child.text || '');
          }
        }
      }
      lines.push(texts.join(''));
    }
  }
  return lines.join('\n');
}

/**
 * After any accept or reject, recompute submission.content and
 * submission.richTextContent so the persisted state is correct.
 *
 * Uses the stored original content (before any tracked changes) as the base,
 * then replays only non-rejected changes' individual deltas.
 */
async function recomputeContentAfterResolution(
  submissionId: string,
  field: string,
  env: any,
): Promise<{ content: string; richText: string } | null> {
  const originalData = await getObject<any>(`original_content/${submissionId}`, env);
  if (!originalData) return null; // Legacy: no original stored

  const allChanges = await getTrackedChanges(submissionId, env);
  const fieldChanges = allChanges
    .filter((c: any) => c.field === field)
    .sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  if (fieldChanges.length === 0) {
    return { content: originalData.content, richText: originalData.richTextContent };
  }

  const hasRejections = fieldChanges.some((c: any) => c.status === 'rejected');
  const activeChanges = fieldChanges.filter((c: any) => c.status !== 'rejected');

  if (activeChanges.length === 0) {
    // All changes rejected — revert to original
    return { content: originalData.content, richText: originalData.richTextContent };
  }

  if (!hasRejections) {
    // No rejections — the last active change's cpv is the correct cumulative state
    const last = activeChanges[activeChanges.length - 1];
    const content = last.completeProposedVersion || last.newValue;
    let richText = last.richTextNewValue;
    if (!richText && originalData.richTextContent) {
      richText = mergeTextIntoLexicalJson(originalData.richTextContent, content);
    }
    richText = cleanLexicalJson(richText || content);
    return { content, richText };
  }

  // ---- Mixed accept/reject: replay only non-rejected changes ----
  const originalContent: string = originalData.content || '';
  let result = originalContent;

  for (let i = 0; i < fieldChanges.length; i++) {
    if (fieldChanges[i].status === 'rejected') continue;

    // Compute this change's individual delta by diffing its cpv
    // against the previous change's cpv (or original for the first change).
    const prevCpv: string = i === 0
      ? originalContent
      : (fieldChanges[i - 1].completeProposedVersion || fieldChanges[i - 1].newValue || originalContent);
    const currCpv: string = fieldChanges[i].completeProposedVersion || fieldChanges[i].newValue || '';

    // Prefix / suffix matching to isolate the delta
    let pLen = 0;
    while (pLen < prevCpv.length && pLen < currCpv.length && prevCpv[pLen] === currCpv[pLen]) pLen++;
    let sLen = 0;
    while (
      sLen < prevCpv.length - pLen &&
      sLen < currCpv.length - pLen &&
      prevCpv[prevCpv.length - 1 - sLen] === currCpv[currCpv.length - 1 - sLen]
    ) sLen++;

    const removedText = prevCpv.substring(pLen, prevCpv.length - sLen);
    const addedText = currCpv.substring(pLen, currCpv.length - sLen);

    if (removedText) {
      // Replacement or deletion
      const pos = result.indexOf(removedText);
      if (pos >= 0) {
        result = result.substring(0, pos) + addedText + result.substring(pos + removedText.length);
      }
    } else if (addedText) {
      // Pure insertion — use context anchor to find position
      const anchor = prevCpv.substring(Math.max(0, pLen - 30), pLen);
      if (anchor) {
        const anchorPos = result.indexOf(anchor);
        if (anchorPos >= 0) {
          const insertPos = anchorPos + anchor.length;
          result = result.substring(0, insertPos) + addedText + result.substring(insertPos);
        } else {
          // Fallback: insert at computed offset
          result = result.substring(0, Math.min(pLen, result.length)) + addedText + result.substring(Math.min(pLen, result.length));
        }
      } else {
        // No anchor (insertion at very beginning)
        result = addedText + result;
      }
    }
    // If neither added nor removed, no change for this entry
  }

  // Build rich text from the recomputed plain text.
  // Strategy: prefer rich text from the last active change (preserves formatting)
  // and fall back to mergeTextIntoLexicalJson only when necessary.
  let richText: string;

  // Try using the last active change's richTextNewValue if its plain text
  // matches our recomputed result. This preserves ALL formatting because
  // richTextNewValue is the complete Lexical JSON captured at edit time.
  const lastActive = activeChanges[activeChanges.length - 1];
  if (lastActive?.richTextNewValue) {
    // Extract plain text from the rich text to compare
    let richTextPlain: string;
    try {
      const parsed = JSON.parse(lastActive.richTextNewValue);
      richTextPlain = extractPlainTextFromLexicalJson(parsed);
    } catch {
      richTextPlain = '';
    }

    if (richTextPlain === result) {
      // Rich text matches the computed result — use it directly
      richText = cleanLexicalJson(lastActive.richTextNewValue);
    } else if (originalData.richTextContent) {
      richText = cleanLexicalJson(mergeTextIntoLexicalJson(originalData.richTextContent, result));
    } else {
      richText = result;
    }
  } else if (originalData.richTextContent) {
    richText = cleanLexicalJson(mergeTextIntoLexicalJson(originalData.richTextContent, result));
  } else {
    richText = result;
  }

  return { content: result, richText };
}

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

    if (savedProposedVersions) {
      if (savedProposedVersions.proposedVersionsRichText) {
        proposedVersionsRichText['content'] = savedProposedVersions.proposedVersionsRichText;
      }
      if (savedProposedVersions.proposedVersionsContent) {
        proposedVersions['content'] = savedProposedVersions.proposedVersionsContent;
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
        } else if (proposedVersions[field] && submission && submission.richTextContent && submission.richTextContent.trim().startsWith('{')) {
          // Fallback: merge the plain text into the original rich text structure
          // Only do this when there IS a plain text proposed version (i.e. active changes exist)
          proposedVersionsRichText[field] = mergeTextIntoLexicalJson(submission.richTextContent, proposedVersions[field]);
        }
      }
    }

    const response = {
      changes: changesWithComments,
      proposedVersions,
      proposedVersionsRichText
    };

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

    if (!field || oldValue === undefined || oldValue === null || newValue === undefined || newValue === null) {
      return new Response('Missing required fields', { status: 400 });
    }

    // On the first tracked change for this submission, snapshot the original
    // content so we can recompute correctly after mixed accept/reject.
    const originalKey = `original_content/${submissionId}`;
    const existingOriginal = await getObject<any>(originalKey, env);
    if (!existingOriginal) {
      const submission = await getObject<any>(`content_submissions/${submissionId}`, env);
      if (submission) {
        await putObject(originalKey, {
          content: submission.content || '',
          richTextContent: submission.richTextContent || '',
        }, env);
      }
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
    const { status, comment, submissionId, revertedRichText } = await request.json();

    if (!['approved', 'rejected'].includes(status)) {
      return new Response('Invalid status', { status: 400 });
    }

    // Check permissions: privileged roles always allowed
    let hasPermission = request.user.userType === 'Admin' ||
      request.user.userType === 'CommsCadre' ||
      request.user.userType === 'CouncilManager';

    // Also allow the submission author to accept/reject changes to their content
    if (!hasPermission && submissionId) {
      const submission = await getObject<any>(`content_submissions/${submissionId}`, env);
      if (submission && submission.submittedBy === request.user.id) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return new Response('Forbidden', { status: 403 });
    }

    if (!submissionId) {
      return new Response('submissionId is required', { status: 400 });
    }

    // Update the change status
    const updatedChange = await updateChangeStatus(
      submissionId,
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
        submissionId,
        comment,
        request.user.id,
        request.user.name,
        env
      );
    }

    // After accepting or rejecting, recompute the submission content from the
    // stored original + non-rejected changes so the persisted state is correct.
    try {
      const recomputed = await recomputeContentAfterResolution(submissionId, updatedChange.field, env);
      if (recomputed) {
        const submission = await getObject<any>(`content_submissions/${submissionId}`, env);
        if (submission) {
          // For accepts with richTextNewValue, prefer it over mergeTextIntoLexicalJson
          // because it preserves formatting.  Only use it when there are no rejections
          // (otherwise the recomputed plain text is authoritative).
          const allChanges = await getTrackedChanges(submissionId, env);
          const hasRejections = allChanges.some((c: any) => c.field === updatedChange.field && c.status === 'rejected');

          if (!hasRejections && status === 'approved' && updatedChange.richTextNewValue) {
            submission.content = recomputed.content;
            submission.richTextContent = cleanLexicalJson(updatedChange.richTextNewValue);
          } else {
            submission.content = recomputed.content;
            // If the client provided the reverted rich text (from the Lexical editor
            // after format revert), use it directly. The server-side recomputation
            // can't preserve inline format changes (bold/italic) that were reverted
            // client-side via Lexical node.setFormat().
            if (revertedRichText && typeof revertedRichText === 'string' && revertedRichText.includes('"root"')) {
              submission.richTextContent = revertedRichText;
            } else {
              submission.richTextContent = recomputed.richText;
            }
          }
          await putObject(`content_submissions/${submissionId}`, submission, env);

          // Update proposed_versions cache
          await putObject(`proposed_versions/${submissionId}`, {
            proposedVersionsContent: submission.content,
            proposedVersionsRichText: submission.richTextContent,
            proposedVersionsFields: [updatedChange.field],
            lastUpdatedAt: new Date().toISOString(),
            lastUpdatedBy: request.user.id,
          }, env);
        }
      }
    } catch (err) {
      console.error('Failed to update submission content after change resolution:', err);
    }

    // Server-side cascade rejection: when a change is rejected, also reject
    // all dependent changes whose regions overlap with this change.
    let cascadeRejectedIds: string[] = [];
    if (status === 'rejected') {
      const dependentIds = await getCascadeDependencies(
        submissionId,
        changeId,
        env
      );
      for (const depId of dependentIds) {
        try {
          await updateChangeStatus(
            submissionId,
            depId,
            'rejected',
            env,
            undefined,
            undefined,
            request.user.id,
            request.user.name
          );
          cascadeRejectedIds.push(depId);
        } catch (err) {
          console.error(`Cascade rejection: failed to reject dependent ${depId}`, err);
        }
      }
      if (cascadeRejectedIds.length > 0) {
        console.log(`Cascade rejection: rejected ${cascadeRejectedIds.length} dependent changes`, cascadeRejectedIds);
      }
    }

    return new Response(JSON.stringify({ success: true, cascadeRejectedIds }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error updating change status:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Batch update status for multiple tracked changes
export async function batchUpdateStatusHandler(request: CustomRequest, env: any): Promise<Response> {
  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { changeIds, status, comment, submissionId } = await request.json();

    if (!Array.isArray(changeIds) || changeIds.length === 0) {
      return new Response(JSON.stringify({ error: 'changeIds array required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }
    if (!['approved', 'rejected'].includes(status)) {
      return new Response(JSON.stringify({ error: 'Invalid status' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    let hasPermission = request.user.userType === 'Admin' ||
      request.user.userType === 'CommsCadre' ||
      request.user.userType === 'CouncilManager';

    // Also allow the submission author to accept/reject changes to their content
    if (!hasPermission && submissionId) {
      const submission = await getObject<any>(`content_submissions/${submissionId}`, env);
      if (submission && submission.submittedBy === request.user.id) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return new Response('Forbidden', { status: 403 });
    }

    if (!submissionId) {
      return new Response(JSON.stringify({ error: 'submissionId required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const results = [];
    for (const changeId of changeIds) {
      const updatedChange = await updateChangeStatus(
        submissionId,
        changeId,
        status,
        env,
        status === 'approved' ? request.user.id : undefined,
        status === 'approved' ? request.user.name : undefined,
        status === 'rejected' ? request.user.id : undefined,
        status === 'rejected' ? request.user.name : undefined
      );

      if (!updatedChange) {
        results.push({ changeId, success: false, error: 'Not found' });
        continue;
      }

      if (comment) {
        await addChangeComment(
          changeId,
          submissionId,
          comment,
          request.user.id,
          request.user.name || request.user.email,
          env
        );
      }

      results.push({ changeId, success: true });
    }

    // After batch resolution, recompute submission content from original + non-rejected changes.
    try {
      // Determine which fields were affected
      const allChanges = await getTrackedChanges(submissionId, env);
      const affectedFields = [...new Set(
        allChanges.filter((c: any) => changeIds.includes(c.id)).map((c: any) => c.field)
      )];

      for (const field of affectedFields) {
        const recomputed = await recomputeContentAfterResolution(submissionId, field, env);
        if (recomputed) {
          const submission = await getObject<any>(`content_submissions/${submissionId}`, env);
          if (submission) {
            // For batch accepts with no rejections, prefer richTextNewValue from the latest change
            const hasRejections = allChanges.some((c: any) => c.field === field && c.status === 'rejected');
            if (!hasRejections && status === 'approved') {
              const justApproved = allChanges
                .filter((c: any) => changeIds.includes(c.id) && c.status === 'approved' && c.field === field)
                .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
              const latestApproved = justApproved[0];
              if (latestApproved?.richTextNewValue) {
                submission.content = recomputed.content;
                submission.richTextContent = cleanLexicalJson(latestApproved.richTextNewValue);
              } else {
                submission.content = recomputed.content;
                submission.richTextContent = recomputed.richText;
              }
            } else {
              submission.content = recomputed.content;
              submission.richTextContent = recomputed.richText;
            }
            await putObject(`content_submissions/${submissionId}`, submission, env);
            await putObject(`proposed_versions/${submissionId}`, {
              proposedVersionsContent: submission.content,
              proposedVersionsRichText: submission.richTextContent,
              proposedVersionsFields: affectedFields,
              lastUpdatedAt: new Date().toISOString(),
              lastUpdatedBy: 'batch',
            }, env);
          }
        }
      }
    } catch (err) {
      console.error('Failed to update submission content after batch resolution:', err);
    }

    return new Response(JSON.stringify({ results }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error in batch status update:', error);
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

    // Get submissionId from request body
    const { submissionId } = await request.json();
    if (!submissionId) {
      return new Response('submissionId is required', { status: 400 });
    }

    // Undo the change
    const updatedChange = await undoChange(submissionId, changeId, env);

    if (!updatedChange) {
      return new Response('Change not found or cannot be undone', { status: 404 });
    }

    // Note: On undo, the change goes back to pending status. The editor
    // will display it as a tracked change on top of submission.content.
    // We don't update submission.content here because the change is no
    // longer resolved — it needs to be re-accepted or rejected.

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
  const { submissionId, changeId } = request.params!;

  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Fetch the change first to check permissions before deleting
    const changeKey = `tracked-changes/submission/${submissionId}/${changeId}`;
    const change = await getObject(changeKey, env) as TrackedChange | null;

    if (!change) {
      return new Response('Change not found', { status: 404 });
    }

    // Allow deletion if user is the change author OR has elevated permissions
    const isAuthor = change.changedBy === request.user.id;
    const hasElevatedPermission = request.user.userType === 'Admin' ||
      request.user.userType === 'CommsCadre' ||
      request.user.userType === 'CouncilManager';

    if (!isAuthor && !hasElevatedPermission) {
      return new Response('Forbidden', { status: 403 });
    }

    const result = await deleteChange(submissionId, changeId, env);

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

// Permanently delete ALL tracked changes for a submission (reset state)
export async function deleteAllChangesHandler(request: CustomRequest, env: any): Promise<Response> {
  const { submissionId } = request.params!;

  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const hasElevatedPermission = request.user.userType === 'Admin' ||
      request.user.userType === 'CommsCadre' ||
      request.user.userType === 'CouncilManager';

    if (!hasElevatedPermission) {
      return new Response('Forbidden', { status: 403 });
    }

    const { listObjects, deleteObject } = await import('../services/cacheService');
    const objects = await listObjects(`tracked-changes/submission/${submissionId}/`, env);

    // Delete all changes
    for (const obj of objects.objects) {
      await deleteObject(obj.key, env);
      await deleteObject(`change:${obj.key}`, env);
    }

    // Delete proposed versions cache
    await deleteObject(`proposed_versions/${submissionId}`, env);
    await deleteObject(`tracked_changes:submission:${submissionId}`, env);

    return new Response(JSON.stringify({ success: true, count: objects.objects.length }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error deleting all changes:', error);
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

    if (changes.length > 50) {
      return new Response('Batch size exceeds maximum of 50 changes', { status: 400 });
    }

    // Validate each change has required fields
    for (const change of changes) {
      if (!change.field || !change.oldValue || !change.newValue) {
        return new Response('Each change must have field, oldValue, and newValue', { status: 400 });
      }
    }

    // Snapshot original content if not already stored
    const originalKey = `original_content/${submissionId}`;
    const existingOriginal = await getObject<any>(originalKey, env);
    if (!existingOriginal) {
      const submission = await getObject<any>(`content_submissions/${submissionId}`, env);
      if (submission) {
        await putObject(originalKey, {
          content: submission.content || '',
          richTextContent: submission.richTextContent || '',
        }, env);
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
  .delete('/submission/:submissionId/change/:changeId', deleteChangeHandler)
  .delete('/submission/:submissionId/all', deleteAllChangesHandler)
  .put('/batch-status', batchUpdateStatusHandler)
  .put('/change/:changeId/status', updateChangeStatusHandler)
  .post('/change/:changeId/comment', addChangeCommentHandler)
  .post('/:changeId/undo', undoChangeHandler)
  .get('/history', getChangeHistoryHandler);