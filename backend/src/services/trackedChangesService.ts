import { Env } from '../utils/sessionManager';
import { getObject, putObject, deleteObject, listObjects } from './cacheService';
import { v4 as uuidv4 } from 'uuid';

export interface RegionMap {
  field: string;
  ranges: Array<{ start: number; end: number }>;
}

export interface TrackedChange {
  id: string;
  submissionId: string;
  field: string;
  oldValue: string;
  newValue: string;
  changedBy: string;
  changedByName: string;
  timestamp: string;
  status: 'pending' | 'approved' | 'rejected';
  approvedBy?: string;
  approvedByName?: string;
  rejectedBy?: string;
  rejectedByName?: string;
  approvedAt?: string;
  rejectedAt?: string;
  isIncremental?: boolean;
  previousVersionId?: string;
  completeProposedVersion?: string; // Store the complete proposed version for incremental changes
  richTextOldValue?: string; // Store the rich text content for the old value
  richTextNewValue?: string; // Store the rich text content for the new value
  regionMap?: RegionMap; // Maps the affected region in the document for cascade dependency tracking
}

export interface ChangeComment {
  id: string;
  changeId: string;
  submissionId: string;
  content: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

// Get all tracked changes for a submission
export const getTrackedChanges = async (submissionId: string, env: Env): Promise<TrackedChange[]> => {
  try {
    // Cache key for all tracked changes for this submission
    const cacheKey = `tracked_changes:submission:${submissionId}`;
    
    // Try to get from cache first
    let changes = await getObject<TrackedChange[]>(cacheKey, env);
    
    // If not in cache, fetch from R2
    if (!changes) {
      // List all objects with the tracked-changes/submission/ prefix
      const objects = await listObjects(`tracked-changes/submission/${submissionId}/`, env);
      
      // Create a list of promises to get each change's content
      const changePromises = objects.objects.map(async (object: { key: string }) => {
        // Check cache for individual change
        const changeCacheKey = `change:${object.key}`;
        const cachedChange = await getObject<TrackedChange>(changeCacheKey, env);
        
        if (cachedChange) {
          return cachedChange;
        }
        
        // If not in cache, get from R2
        const changeObject = await env.R2.get(object.key);
        if (!changeObject) return null;
        
        const change = await changeObject.json() as TrackedChange;
        
        // Cache individual change
        await putObject(changeCacheKey, change, env, undefined, 3600); // Cache for 1 hour
        
        return change;
      });
      
      // Wait for all promises to resolve and filter out null values
      changes = (await Promise.all(changePromises)).filter((change: any): change is TrackedChange => change !== null);
      
      // Cache all changes for this submission
      await putObject(cacheKey, changes, env, undefined, 300); // Cache for 5 minutes
    }
    
    // Sort changes by timestamp (newest first)
    return changes.sort((a: TrackedChange, b: TrackedChange) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  } catch (error) {
    console.error('Error fetching tracked changes:', error);
    return [];
  }
};

// Word-level LCS to produce diff segments
const wordLcsDiff = (
  prevWords: string[],
  currWords: string[]
): Array<{ type: 'equal' | 'delete' | 'insert'; words: string[] }> => {
  const m = prevWords.length;
  const n = currWords.length;

  // Build LCS table
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (prevWords[i - 1] === currWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Traceback to produce segments
  const segments: Array<{ type: 'equal' | 'delete' | 'insert'; words: string[] }> = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    let type: 'equal' | 'delete' | 'insert';
    let word: string;

    if (i > 0 && j > 0 && prevWords[i - 1] === currWords[j - 1]) {
      type = 'equal';
      word = prevWords[i - 1];
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      type = 'insert';
      word = currWords[j - 1];
      j--;
    } else {
      type = 'delete';
      word = prevWords[i - 1];
      i--;
    }

    if (segments.length > 0 && segments[0].type === type) {
      segments[0].words.unshift(word);
    } else {
      segments.unshift({ type, words: [word] });
    }
  }

  return segments;
};

// Calculate incremental changes between two versions
// Uses word-level LCS diff to identify only the words that actually changed,
// separating disjoint change groups with "…".
export const calculateIncrementalChange = (
  previousVersion: string,
  currentVersion: string
): { oldValue: string; newValue: string } => {
  if (previousVersion === currentVersion) {
    return { oldValue: '', newValue: '' };
  }

  // Handle empty strings
  if (!previousVersion) {
    return { oldValue: '', newValue: currentVersion };
  }
  if (!currentVersion) {
    return { oldValue: previousVersion, newValue: '' };
  }

  const prevWords = previousVersion.split(/\s+/).filter(w => w !== '');
  const currWords = currentVersion.split(/\s+/).filter(w => w !== '');

  const segments = wordLcsDiff(prevWords, currWords);

  // Group adjacent changes, separated by 'equal' segments
  type ChangeGroup = { deleted: string[]; inserted: string[] };
  const changeGroups: ChangeGroup[] = [];
  let currentGroup: ChangeGroup | null = null;

  for (const seg of segments) {
    if (seg.type === 'equal') {
      if (currentGroup) {
        changeGroups.push(currentGroup);
        currentGroup = null;
      }
    } else if (seg.type === 'delete') {
      if (!currentGroup) currentGroup = { deleted: [], inserted: [] };
      currentGroup.deleted.push(...seg.words);
    } else {
      if (!currentGroup) currentGroup = { deleted: [], inserted: [] };
      currentGroup.inserted.push(...seg.words);
    }
  }
  if (currentGroup) changeGroups.push(currentGroup);

  const oldValue = changeGroups
    .map(g => g.deleted.join(' '))
    .filter(s => s)
    .join(' \u2026 ');
  const newValue = changeGroups
    .map(g => g.inserted.join(' '))
    .filter(s => s)
    .join(' \u2026 ');

  return { oldValue, newValue };
};

// Get the latest proposed version for a field
export const getLatestProposedVersion = async (
  submissionId: string,
  field: string,
  env: Env
): Promise<string | null> => {
  try {
    const changes = await getTrackedChanges(submissionId, env);
    
    // Get the most recent pending or approved change for this field
    const fieldChanges = changes
      .filter(change => change.field === field && change.status !== 'rejected')
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
    if (fieldChanges.length === 0) {
      return null;
    }
    
    // For incremental changes, return the complete proposed version
    // For non-incremental changes, return the newValue
    const latestChange = fieldChanges[0];
    if (latestChange.isIncremental && latestChange.completeProposedVersion) {
      return latestChange.completeProposedVersion;
    } else {
      return latestChange.newValue;
    }
  } catch (error) {
    console.error('Error getting latest proposed version:', error);
    return null;
  }
};

// Create a new tracked change with incremental changes
export const createTrackedChange = async (
  submissionId: string,
  field: string,
  oldValue: string,
  newValue: string,
  changedBy: string,
  changedByName: string,
  env: Env,
  richTextOldValue?: string,
  richTextNewValue?: string,
  regionMap?: RegionMap
): Promise<TrackedChange> => {
  try {
    const changeId = uuidv4();
    const timestamp = new Date().toISOString();
    
    // Get the latest proposed version to calculate incremental changes
    const latestProposedVersion = await getLatestProposedVersion(submissionId, field, env);
    
    let incrementalOldValue = oldValue;
    let incrementalNewValue = newValue;
    let previousVersionId: string | undefined;
    let isIncremental = false;
    
    if (latestProposedVersion && latestProposedVersion !== oldValue) {
      // Calculate incremental changes from the latest proposed version
      const incrementalChange = calculateIncrementalChange(latestProposedVersion, newValue);
      incrementalOldValue = incrementalChange.oldValue;
      incrementalNewValue = incrementalChange.newValue;
      isIncremental = true;
      
      // Find the ID of the previous version
      const changes = await getTrackedChanges(submissionId, env);
      const previousChange = changes
        .filter(change => change.field === field && change.status !== 'rejected')
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
      
      if (previousChange) {
        previousVersionId = previousChange.id;
      }
    } else {
      // For the first change or when there's no previous version, calculate diff from original
      const incrementalChange = calculateIncrementalChange(oldValue, newValue);
      incrementalOldValue = incrementalChange.oldValue;
      incrementalNewValue = incrementalChange.newValue;
      isIncremental = true;
    }
    
    // Create the tracked change object
    // For incremental changes, store the incremental differences in oldValue/newValue
    // and the complete proposed version in a separate field
    const newChange: TrackedChange = {
      id: changeId,
      submissionId,
      field,
      oldValue: incrementalOldValue,
      newValue: incrementalNewValue,
      changedBy,
      changedByName,
      timestamp,
      status: 'pending',
      isIncremental,
      previousVersionId,
      completeProposedVersion: isIncremental ? newValue : undefined,
      richTextOldValue,
      richTextNewValue,
      regionMap
    };

    // Store the change in R2 and cache
    const changeKey = `tracked-changes/submission/${submissionId}/${changeId}`;
    await putObject(changeKey, newChange, env);
    
    // Also cache it individually
    const cacheKey = `change:${changeKey}`;
    await putObject(cacheKey, newChange, env, undefined, 3600); // Cache for 1 hour
    
    // Invalidate the submission's tracked changes cache
    await deleteObject(`tracked_changes:submission:${submissionId}`, env);
    
    return newChange;
  } catch (error) {
    console.error('Error creating tracked change:', error);
    throw error;
  }
};

// Update the status of a tracked change
export const updateChangeStatus = async (
  submissionId: string,
  changeId: string,
  status: 'approved' | 'rejected',
  env: Env,
  approvedBy?: string,
  approvedByName?: string,
  rejectedBy?: string,
  rejectedByName?: string
): Promise<TrackedChange | null> => {
  try {
    // Direct R2 key lookup instead of scanning all objects
    const changeKey = `tracked-changes/submission/${submissionId}/${changeId}`;
    const change = await getObject<TrackedChange>(changeKey, env);

    if (!change) {
      return null;
    }
    
    // Update the change
    const timestamp = new Date().toISOString();
    const updatedChange: TrackedChange = {
      ...change,
      status,
      approvedBy: status === 'approved' ? approvedBy : change.approvedBy,
      approvedByName: status === 'approved' ? approvedByName : change.approvedByName,
      approvedAt: status === 'approved' ? timestamp : change.approvedAt,
      rejectedBy: status === 'rejected' ? rejectedBy : change.rejectedBy,
      rejectedByName: status === 'rejected' ? rejectedByName : change.rejectedByName,
      rejectedAt: status === 'rejected' ? timestamp : change.rejectedAt,
      richTextOldValue: status === 'approved' ? change.richTextOldValue : change.richTextOldValue,
      richTextNewValue: status === 'approved' ? change.richTextNewValue : change.richTextNewValue
    };
    
    // Store the updated change in R2 and cache
    await putObject(changeKey, updatedChange, env);
    
    // Also cache it individually
    const cacheKey = `change:${changeKey}`;
    await putObject(cacheKey, updatedChange, env, undefined, 3600); // Cache for 1 hour
    
    // Invalidate the submission's tracked changes cache
    await deleteObject(`tracked_changes:submission:${change.submissionId}`, env);

    // Invalidate the cached proposed versions so they're recomputed on next fetch
    await deleteObject(`proposed_versions/${change.submissionId}`, env);

    return updatedChange;
  } catch (error) {
    console.error('Error updating change status:', error);
    return null;
  }
};

// Get comments for a tracked change
export const getChangeComments = async (changeId: string, env: Env): Promise<ChangeComment[]> => {
  try {
    // Cache key for all comments for this change
    const cacheKey = `change_comments:change:${changeId}`;
    
    // Try to get from cache first
    let comments = await getObject<ChangeComment[]>(cacheKey, env);
    
    // If not in cache, fetch from R2
    if (!comments) {
      // List all objects with the change-comments/change/ prefix
      const objects = await listObjects(`change-comments/change/${changeId}/`, env);
      
      // Create a list of promises to get each comment's content
      const commentPromises = objects.objects.map(async (object: { key: string }) => {
        // Check cache for individual comment
        const commentCacheKey = `comment:${object.key}`;
        const cachedComment = await getObject<ChangeComment>(commentCacheKey, env);
        
        if (cachedComment) {
          return cachedComment;
        }
        
        // If not in cache, get from R2
        const commentObject = await env.R2.get(object.key);
        if (!commentObject) return null;
        
        const comment = await commentObject.json() as ChangeComment;
        
        // Cache individual comment
        await putObject(commentCacheKey, comment, env, undefined, 3600); // Cache for 1 hour
        
        return comment;
      });
      
      // Wait for all promises to resolve and filter out null values
      comments = (await Promise.all(commentPromises)).filter((comment: any): comment is ChangeComment => comment !== null);
      
      // Cache all comments for this change
      await putObject(cacheKey, comments, env, undefined, 300); // Cache for 5 minutes
    }
    
    // Sort comments by creation date (oldest first)
    return comments.sort((a: ChangeComment, b: ChangeComment) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  } catch (error) {
    console.error('Error fetching change comments:', error);
    return [];
  }
};

// Add a comment to a tracked change
export const addChangeComment = async (
  changeId: string,
  submissionId: string,
  content: string,
  authorId: string,
  authorName: string,
  env: Env
): Promise<ChangeComment> => {
  try {
    const commentId = uuidv4();
    const timestamp = new Date().toISOString();
    
    // Create the comment object
    const newComment: ChangeComment = {
      id: commentId,
      changeId,
      submissionId,
      content,
      authorId,
      authorName,
      createdAt: timestamp
    };
    
    // Store the comment in R2 and cache
    const commentKey = `change-comments/change/${changeId}/${commentId}`;
    await putObject(commentKey, newComment, env);
    
    // Also cache it individually
    const cacheKey = `comment:${commentKey}`;
    await putObject(cacheKey, newComment, env, undefined, 3600); // Cache for 1 hour
    
    // Invalidate the change's comments cache
    await deleteObject(`change_comments:change:${changeId}`, env);
    
    return newComment;
  } catch (error) {
    console.error('Error adding change comment:', error);
    throw error;
  }
};

// Find the first occurrence of a word subsequence within an array
function findWordSubsequence(haystack: string[], needle: string[]): number {
  if (needle.length === 0) return -1;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

// Apply a diff (from predecessorCpv → changeCpv) to a running text.
// Extracts change groups (contiguous delete/insert segments) from the diff,
// finds the deleted words in the running text, and replaces them with inserted words.
// Works correctly for non-overlapping changes (guaranteed by cascade rejection).
function applyDiffContribution(
  runningText: string,
  diff: Array<{ type: 'equal' | 'delete' | 'insert'; words: string[] }>
): string {
  // Extract change groups from the diff
  type ChangeGroup = {
    toDelete: string[];   // words to find and remove in running text
    toInsert: string[];   // words to add in their place
    contextBefore: string[]; // preceding equal words (for pure insertions)
  };

  const groups: ChangeGroup[] = [];
  let lastEqual: string[] = [];
  let currentDelete: string[] = [];
  let currentInsert: string[] = [];
  let inChange = false;

  for (const seg of diff) {
    if (seg.type === 'equal') {
      if (inChange) {
        groups.push({
          toDelete: currentDelete,
          toInsert: currentInsert,
          contextBefore: lastEqual.slice(-3)
        });
        currentDelete = [];
        currentInsert = [];
        inChange = false;
      }
      lastEqual = seg.words;
    } else {
      inChange = true;
      if (seg.type === 'delete') {
        currentDelete.push(...seg.words);
      } else {
        currentInsert.push(...seg.words);
      }
    }
  }
  if (inChange) {
    groups.push({
      toDelete: currentDelete,
      toInsert: currentInsert,
      contextBefore: lastEqual.slice(-3)
    });
  }

  // Apply each group to runningText, preserving newline positions.
  // Split into tokens while remembering which separators contain newlines.
  const tokens = runningText.split(/(\s+)/); // odd indices are separators
  const resultWords: string[] = [];
  // Map: resultWords index → separator BEFORE this word (empty for first word)
  const separatorBefore: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (i % 2 === 0) {
      // word token
      if (tokens[i] !== '') {
        resultWords.push(tokens[i]);
        separatorBefore.push(i > 0 ? tokens[i - 1] : '');
      }
    }
  }

  for (const group of groups) {
    if (group.toDelete.length > 0) {
      // Find the deleted words in result and replace with inserted words.
      // Use contextBefore to disambiguate when there are multiple occurrences
      // of the same word. Try progressively shorter contexts since earlier
      // context words may have been modified by rejected changes.
      let idx = -1;
      for (let ctxLen = group.contextBefore.length; ctxLen >= 1; ctxLen--) {
        const ctx = group.contextBefore.slice(-ctxLen);
        const searchSeq = [...ctx, ...group.toDelete];
        const seqIdx = findWordSubsequence(resultWords, searchSeq);
        if (seqIdx >= 0) {
          idx = seqIdx + ctxLen; // offset past the context words
          break;
        }
      }
      // Fallback: search for just the toDelete words (original behavior)
      if (idx < 0) {
        idx = findWordSubsequence(resultWords, group.toDelete);
      }
      if (idx >= 0) {
        resultWords.splice(idx, group.toDelete.length, ...group.toInsert);
        // Preserve the separator before the first deleted word, remove rest
        const keptSep = separatorBefore[idx];
        const newSeps = [keptSep, ...group.toInsert.slice(1).map(() => ' ')];
        separatorBefore.splice(idx, group.toDelete.length, ...newSeps);
      }
    } else if (group.toInsert.length > 0 && group.contextBefore.length > 0) {
      // Pure insertion: find context and insert after it.
      // Try progressively shorter contexts for the same reason.
      let ctxIdx = -1;
      let ctxLen = 0;
      for (let cl = group.contextBefore.length; cl >= 1; cl--) {
        const ctx = group.contextBefore.slice(-cl);
        const found = findWordSubsequence(resultWords, ctx);
        if (found >= 0) {
          ctxIdx = found;
          ctxLen = cl;
          break;
        }
      }
      if (ctxIdx >= 0) {
        const insertAt = ctxIdx + ctxLen;
        resultWords.splice(insertAt, 0, ...group.toInsert);
        separatorBefore.splice(insertAt, 0, ...group.toInsert.map(() => ' '));
      }
    }
  }

  // Rejoin using original separators (preserving newlines)
  let result = '';
  for (let i = 0; i < resultWords.length; i++) {
    if (i > 0) {
      result += separatorBefore[i] || ' ';
    }
    result += resultWords[i];
  }
  return result;
}

// Get the completeProposedVersion that was the state right before a change was
// made. For the first change in a chain this is the original document content.
function getPredecessorCpv(
  change: TrackedChange,
  allFieldChanges: TrackedChange[],
  originalContent: string
): string {
  // Find the change immediately preceding this one (by timestamp)
  const predecessors = allFieldChanges
    .filter(c => new Date(c.timestamp).getTime() < new Date(change.timestamp).getTime())
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  if (predecessors.length > 0) {
    const pred = predecessors[0];
    if (pred.completeProposedVersion) {
      return pred.completeProposedVersion;
    }
    // For non-incremental changes, newValue is the full document
    if (!pred.isIncremental) {
      return pred.newValue || originalContent;
    }
  }
  return originalContent;
}

// Extract plain text from content that may be Lexical JSON
// Preserves paragraph structure by joining top-level nodes with newlines
function extractPlainText(content: string): string {
  if (typeof content === 'string' && content.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(content);
      if (parsed.root && Array.isArray(parsed.root.children)) {
        const extractNodeText = (node: any): string => {
          if (node.text) return node.text;
          if (Array.isArray(node.children)) {
            return node.children.map(extractNodeText).join('');
          }
          return '';
        };
        // Join top-level nodes (paragraphs) with newlines
        return parsed.root.children
          .map((child: any) => extractNodeText(child))
          .join('\n')
          .trim();
      }
    } catch { /* not JSON, use as-is */ }
  }
  return content;
}

// Get the complete proposed version for a field by applying all incremental changes
export const getCompleteProposedVersion = async (
  submissionId: string,
  field: string,
  env: Env
): Promise<string | null> => {
  try {
    const changes = await getTrackedChanges(submissionId, env);

    // All changes for this field, sorted chronologically
    const allFieldChanges = changes
      .filter(change => change.field === field)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Only replay pending changes. Approved changes are already folded into
    // submission.content by the accept handler, so replaying them would
    // double-apply edits and produce garbled text.
    const pendingChanges = allFieldChanges.filter(c => c.status === 'pending');
    if (pendingChanges.length === 0) {
      return null;
    }

    // Fast path: no rejections exist → the last pending change's cpv is correct
    const hasRejections = allFieldChanges.some(c => c.status === 'rejected');
    if (!hasRejections) {
      const latestChange = pendingChanges[pendingChanges.length - 1];
      if (latestChange.isIncremental && latestChange.completeProposedVersion) {
        return latestChange.completeProposedVersion;
      }
      return latestChange.newValue;
    }

    // Slow path: rejections exist → recompute by replaying only pending changes
    const submission = await getObject(`content_submissions/${submissionId}`, env) as any;
    const originalContent = submission ? extractPlainText(submission.content || '') : '';

    // Replay each pending change's individual contribution
    let runningText = originalContent;

    for (const change of allFieldChanges) {
      if (change.status !== 'pending') {
        continue;
      }

      // Get this change's individual contribution by diffing predecessor → changeCpv
      const predecessorCpv = getPredecessorCpv(change, allFieldChanges, originalContent);
      const changeCpv = (change.isIncremental && change.completeProposedVersion)
        ? change.completeProposedVersion
        : change.newValue;

      const predWords = predecessorCpv.split(/\s+/).filter(w => w !== '');
      const changeWords = changeCpv.split(/\s+/).filter(w => w !== '');
      const diffSegments = wordLcsDiff(predWords, changeWords);

      // Apply only the changed parts to the running text
      runningText = applyDiffContribution(runningText, diffSegments);
    }

    return runningText;
  } catch (error) {
    console.error('Error getting complete proposed version:', error);
    return null;
  }
};

// Get the complete rich text proposed version for a field
export const getCompleteRichTextProposedVersion = async (
  submissionId: string,
  field: string,
  env: Env
): Promise<string | null> => {
  try {
    const changes = await getTrackedChanges(submissionId, env);

    const allFieldChanges = changes
      .filter(change => change.field === field)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Only consider pending changes — approved changes are already in submission.content
    const pendingChanges = allFieldChanges.filter(c => c.status === 'pending');
    if (pendingChanges.length === 0) {
      return null;
    }

    // Fast path: no rejections → use last pending change's rich text directly
    const hasRejections = allFieldChanges.some(c => c.status === 'rejected');
    if (!hasRejections) {
      const latestChange = pendingChanges[pendingChanges.length - 1];
      if (latestChange.richTextNewValue) {
        return latestChange.richTextNewValue;
      }
      return latestChange.newValue;
    }

    // Slow path: compute correct plain text first
    const correctPlainText = await getCompleteProposedVersion(submissionId, field, env);
    if (!correctPlainText) {
      return null;
    }

    // Try to find a pending change whose richTextNewValue matches the computed text.
    // This preserves all inline formatting (bold, italic, etc.) instead of losing it
    // through mergeTextIntoLexicalJson.
    const latestPending = pendingChanges[pendingChanges.length - 1];
    if (latestPending?.richTextNewValue) {
      try {
        const parsed = JSON.parse(latestPending.richTextNewValue);
        const richTextPlain = extractPlainTextFromLexical(parsed);
        if (richTextPlain === correctPlainText) {
          return latestPending.richTextNewValue;
        }
      } catch { /* fall through to merge */ }
    }

    // Fallback: merge plain text into original Lexical JSON structure
    const submission = await getObject(`content_submissions/${submissionId}`, env) as any;
    if (submission?.richTextContent) {
      return mergeTextIntoLexicalJson(submission.richTextContent, correctPlainText);
    }

    return correctPlainText;
  } catch (error) {
    console.error('Error getting complete rich text proposed version:', error);
    return null;
  }
};

// Get change history for analytics
export const getChangeHistory = async (
  env: Env,
  startDate?: string,
  endDate?: string,
  userId?: string
): Promise<{ changes: TrackedChange[]; stats: any }> => {
  try {
    // Cache key for change history
    const cacheKey = `change_history:${startDate || 'all'}:${endDate || 'all'}:${userId || 'all'}`;
    
    // Try to get from cache first
    let result = await getObject<{ changes: TrackedChange[]; stats: any }>(cacheKey, env);
    
    // If not in cache, fetch from R2
    if (!result) {
      // List all tracked changes
      const objects = await listObjects('tracked-changes/', env);
      
      // Create a list of promises to get each change's content
      const changePromises = objects.objects.map(async (object: { key: string }) => {
        const changeObject = await env.R2.get(object.key);
        if (!changeObject) return null;
        
        return await changeObject.json() as TrackedChange;
      });
      
      // Wait for all promises to resolve and filter out null values
      let changes = (await Promise.all(changePromises)).filter((change: any): change is TrackedChange => change !== null);
      
      // Apply filters
      if (startDate) {
        changes = changes.filter(change => new Date(change.timestamp) >= new Date(startDate));
      }
      
      if (endDate) {
        changes = changes.filter(change => new Date(change.timestamp) <= new Date(endDate));
      }
      
      if (userId) {
        changes = changes.filter(change => change.changedBy === userId);
      }
      
      // Sort by timestamp (newest first)
      changes = changes.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      
      // Limit to 100 results
      changes = changes.slice(0, 100);
      
      // Calculate statistics
      const stats = {
        totalChanges: changes.length,
        pendingChanges: changes.filter(c => c.status === 'pending').length,
        approvedChanges: changes.filter(c => c.status === 'approved').length,
        rejectedChanges: changes.filter(c => c.status === 'rejected').length,
        uniqueContributors: new Set(changes.map(c => c.changedBy)).size
      };
      
      result = { changes, stats };
      
      // Cache the result
      await putObject(cacheKey, result, env, undefined, 300); // Cache for 5 minutes
    }
    
    return result;
  } catch (error) {
    console.error('Error fetching change history:', error);
    return { changes: [], stats: { totalChanges: 0, pendingChanges: 0, approvedChanges: 0, rejectedChanges: 0, uniqueContributors: 0 } };
  }
};

// Helper: Extract plain text from a parsed Lexical JSON object
function extractPlainTextFromLexical(lexical: any): string {
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

// Helper: Merge plain text into Lexical JSON (replaces text in paragraph/heading nodes)
// IMPORTANT: When a paragraph's text hasn't changed, all child nodes are preserved
// (keeping bold, italic, underline, and other inline formatting intact).
export function mergeTextIntoLexicalJson(originalLexical: string, newText: string): string {
  try {
    const json = JSON.parse(originalLexical);
    if (!json.root || !Array.isArray(json.root.children)) return originalLexical;

    // Split the new text into lines to distribute across paragraphs
    const lines = newText.split('\n');

    // Find all paragraph/heading nodes
    const textNodes = json.root.children.filter(
      (child: any) => child.type === 'paragraph' || child.type === 'heading'
    );

    // Replace text in each paragraph, matching by index.
    for (let i = 0; i < textNodes.length; i++) {
      const node = textNodes[i];
      if (!Array.isArray(node.children) || node.children.length === 0) continue;

      const lineText = i < lines.length ? lines[i] : '';

      // Get the current concatenated text from all text-type children
      const currentText = node.children
        .filter((n: any) => n.type === 'text')
        .map((n: any) => n.text || '')
        .join('');

      // If text is unchanged, skip this paragraph entirely — this preserves
      // all inline formatting (bold, italic, underline, strikethrough, etc.)
      if (lineText === currentText) continue;

      // Text changed — we need to update. Try to distribute text across
      // existing nodes to preserve as much formatting as possible.
      const textChildren = node.children.filter((n: any) => n.type === 'text');
      const nonTextChildren = node.children.filter((n: any) => n.type !== 'text');

      if (textChildren.length <= 1) {
        // Single text node or no text nodes — simple replacement
        const firstTextIdx = node.children.findIndex((n: any) => n.type === 'text');
        if (firstTextIdx >= 0) {
          node.children[firstTextIdx].text = lineText;
        }
      } else {
        // Multiple formatted text nodes. Try to redistribute text across
        // existing nodes by mapping character positions.
        let remaining = lineText;
        let usedNodes = 0;

        for (let j = 0; j < textChildren.length; j++) {
          const origLen = (textChildren[j].text || '').length;
          if (j === textChildren.length - 1) {
            // Last text node gets all remaining text
            textChildren[j].text = remaining;
            usedNodes++;
          } else if (remaining.length === 0) {
            // No more text to distribute — remove excess nodes
            break;
          } else {
            // Distribute proportionally based on original length
            const portion = remaining.substring(0, origLen);
            textChildren[j].text = portion;
            remaining = remaining.substring(origLen);
            usedNodes++;
          }
        }

        // Rebuild children: non-text nodes + used text nodes (remove empty ones)
        const keptTextNodes = textChildren.slice(0, usedNodes).filter(
          (n: any) => n.text !== ''
        );
        // Reconstruct children preserving original order (interleaved non-text nodes)
        const newChildren: any[] = [];
        let textIdx = 0;
        let nonTextIdx = 0;
        for (const child of node.children) {
          if (child.type === 'text') {
            if (textIdx < keptTextNodes.length) {
              newChildren.push(keptTextNodes[textIdx]);
              textIdx++;
            }
          } else {
            newChildren.push(child);
          }
        }
        node.children = newChildren;
      }
    }

    // If there are more lines than paragraphs, add new paragraph nodes
    for (let i = textNodes.length; i < lines.length; i++) {
      if (!lines[i] && lines[i] !== '') continue;
      json.root.children.push({
        children: [{ detail: 0, format: 0, mode: "normal", style: "", text: lines[i], type: "text", version: 1 }],
        direction: "ltr",
        format: "",
        indent: 0,
        type: "paragraph",
        version: 1,
        textFormat: 0,
        textStyle: ""
      });
    }

    return JSON.stringify(json);
  } catch (e) {
    return originalLexical;
  }
}

// Undo a change decision (reset status back to pending)
export const undoChange = async (
  submissionId: string,
  changeId: string,
  env: Env
): Promise<TrackedChange | null> => {
  try {
    // Direct R2 key lookup instead of scanning all objects
    const changeKey = `tracked-changes/submission/${submissionId}/${changeId}`;
    const targetChange = await getObject<TrackedChange>(changeKey, env);

    if (!targetChange) {
      console.error('Change not found:', changeId);
      return null;
    }
    
    // Only allow undoing if the change is currently approved or rejected
    if (targetChange.status !== 'approved' && targetChange.status !== 'rejected') {
      console.error('Cannot undo change that is not approved or rejected:', targetChange.status);
      return null;
    }
    
    // Reset the change status to pending and clear approval/rejection info
    const updatedChange: TrackedChange = {
      ...targetChange,
      status: 'pending',
      approvedBy: undefined,
      approvedByName: undefined,
      rejectedBy: undefined,
      rejectedByName: undefined,
      approvedAt: undefined,
      rejectedAt: undefined
    };
    
    // Save the updated change
    await putObject(changeKey, updatedChange, env);
    
    // Clear cache for this change
    const changeCacheKey = `change:${changeKey}`;
    await deleteObject(changeCacheKey, env);
    
    // Clear cache for the submission's tracked changes
    const submissionCacheKey = `tracked_changes:submission:${targetChange.submissionId}`;
    await deleteObject(submissionCacheKey, env);

    // Invalidate the cached proposed versions so they're recomputed on next fetch
    await deleteObject(`proposed_versions/${targetChange.submissionId}`, env);

    console.log('Successfully undone change:', changeId);
    return updatedChange;
  } catch (error) {
    console.error('Error undoing change:', error);
    return null;
  }
};

// Permanently delete a tracked change from R2 storage.
// Accepts submissionId to construct the R2 key directly instead of scanning.
export const deleteChange = async (
  submissionId: string,
  changeId: string,
  env: Env
): Promise<{ submissionId: string } | null> => {
  try {
    // Construct the key directly from submissionId + changeId
    const changeKey = `tracked-changes/submission/${submissionId}/${changeId}`;

    // Fetch the change to verify it exists
    const targetChange = await getObject<TrackedChange>(changeKey, env);

    if (!targetChange) {
      return null;
    }

    // Delete the change from R2 and cache
    await deleteObject(changeKey, env);

    // Also remove the individual cache entry
    const changeCacheKey = `change:${changeKey}`;
    await deleteObject(changeCacheKey, env);

    // Invalidate the submission's tracked changes cache
    const submissionCacheKey = `tracked_changes:submission:${submissionId}`;
    await deleteObject(submissionCacheKey, env);

    // Invalidate the cached proposed versions so they're recomputed on next fetch
    await deleteObject(`proposed_versions/${submissionId}`, env);

    console.log('Successfully deleted change:', changeId);
    return { submissionId };
  } catch (error) {
    console.error('Error deleting change:', error);
    return null;
  }
};

// Check if two ranges overlap (inclusive of touching boundaries)
const rangesOverlap = (
  a: { start: number; end: number },
  b: { start: number; end: number }
): boolean => {
  return a.start < b.end && b.start < a.end;
};

// Check if a subsequent change depends on a target change via value chain.
// A change is dependent if its oldValue matches or contains the target's newValue,
// or if the target's newValue matches or contains the change's oldValue.
// This catches cases where regionMap ranges don't numerically overlap because
// they're expressed in different document coordinate spaces.
const hasValueChainDependency = (
  targetChange: TrackedChange,
  subsequentChange: TrackedChange
): boolean => {
  const targetNew = (targetChange.newValue || '').trim();
  const changeOld = (subsequentChange.oldValue || '').trim();

  if (!targetNew || !changeOld) return false;

  // Direct match: the subsequent change operates on exactly what the target produced
  if (targetNew === changeOld) return true;

  // Containment: the subsequent change operates on text that includes the target's output
  if (changeOld.includes(targetNew) || targetNew.includes(changeOld)) return true;

  return false;
};

// Get the cascade dependency chain for a given change
export const getCascadeDependencies = async (
  submissionId: string,
  changeId: string,
  env: Env
): Promise<string[]> => {
  try {
    const changes = await getTrackedChanges(submissionId, env);

    // Find the target change
    const targetChange = changes.find(c => c.id === changeId);
    if (!targetChange) {
      return [];
    }

    // Get all subsequent changes for the same field (pending AND accepted),
    // ordered by timestamp ascending. We need accepted changes to act as
    // cascade boundaries — the chain stops at any accepted change.
    const subsequentChanges = changes
      .filter(c =>
        c.id !== changeId &&
        c.field === targetChange.field &&
        (c.status === 'pending' || c.status === 'approved') &&
        new Date(c.timestamp).getTime() > new Date(targetChange.timestamp).getTime()
      )
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const dependentIds: string[] = [];

    // Track the running "newValue" through the chain so transitive dependencies
    // are detected (A→B→C where C depends on B which depends on A).
    let chainNewValue = targetChange.newValue || '';

    for (const change of subsequentChanges) {
      let isDependent = false;

      // Method 1: regionMap overlap (character-level ranges)
      if (targetChange.regionMap && change.regionMap &&
          change.regionMap.field === targetChange.regionMap.field) {
        for (const targetRange of targetChange.regionMap.ranges) {
          for (const changeRange of change.regionMap.ranges) {
            if (rangesOverlap(targetRange, changeRange)) {
              isDependent = true;
              break;
            }
          }
          if (isDependent) break;
        }
      }

      // Method 2: value chain dependency (catches coordinate-space mismatches)
      if (!isDependent) {
        isDependent = hasValueChainDependency(
          { ...targetChange, newValue: chainNewValue } as TrackedChange,
          change
        );
      }

      if (isDependent) {
        // Accepted changes are immutable boundaries — stop the cascade
        if (change.status === 'approved') {
          break;
        }
        dependentIds.push(change.id);
        // Update chain value for transitive detection
        chainNewValue = change.newValue || chainNewValue;
      }
    }

    return dependentIds;
  } catch (error) {
    console.error('Error getting cascade dependencies:', error);
    return [];
  }
};

// Batch create multiple tracked changes (all-or-nothing)
export const batchCreateTrackedChanges = async (
  submissionId: string,
  changesData: Array<{
    field: string;
    oldValue: string;
    newValue: string;
    changedBy: string;
    changedByName: string;
    richTextOldValue?: string;
    richTextNewValue?: string;
    regionMap?: RegionMap;
    timestamp?: string;
  }>,
  env: Env
): Promise<TrackedChange[]> => {
  const createdChanges: TrackedChange[] = [];
  const createdKeys: string[] = [];

  try {
    for (const changeData of changesData) {
      const changeId = uuidv4();
      const timestamp = changeData.timestamp || new Date().toISOString();

      const newChange: TrackedChange = {
        id: changeId,
        submissionId,
        field: changeData.field,
        oldValue: changeData.oldValue,
        newValue: changeData.newValue,
        changedBy: changeData.changedBy,
        changedByName: changeData.changedByName,
        timestamp,
        status: 'pending',
        richTextOldValue: changeData.richTextOldValue,
        richTextNewValue: changeData.richTextNewValue,
        regionMap: changeData.regionMap,
      };

      const changeKey = `tracked-changes/submission/${submissionId}/${changeId}`;
      await putObject(changeKey, newChange, env);

      // Cache individually
      const cacheKey = `change:${changeKey}`;
      await putObject(cacheKey, newChange, env, undefined, 3600);

      createdChanges.push(newChange);
      createdKeys.push(changeKey);
    }

    // Invalidate the submission's tracked changes cache
    await deleteObject(`tracked_changes:submission:${submissionId}`, env);

    return createdChanges;
  } catch (error) {
    // Rollback: delete any changes that were created before the error
    console.error('Error in batch create, rolling back:', error);
    for (const key of createdKeys) {
      try {
        await deleteObject(key, env);
        await deleteObject(`change:${key}`, env);
      } catch (rollbackError) {
        console.error('Error during rollback:', rollbackError);
      }
    }
    throw error;
  }
};