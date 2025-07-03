import { Env } from '../utils/sessionManager';
import { getObject, putObject, deleteObject, listObjects } from './cacheService';
import { v4 as uuidv4 } from 'uuid';

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

// Create a new tracked change
export const createTrackedChange = async (
  submissionId: string,
  field: string,
  oldValue: string,
  newValue: string,
  changedBy: string,
  changedByName: string,
  env: Env
): Promise<TrackedChange> => {
  try {
    const changeId = uuidv4();
    const timestamp = new Date().toISOString();
    
    // Create the tracked change object
    const newChange: TrackedChange = {
      id: changeId,
      submissionId,
      field,
      oldValue,
      newValue,
      changedBy,
      changedByName,
      timestamp,
      status: 'pending'
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
  changeId: string,
  status: 'approved' | 'rejected',
  env: Env,
  approvedBy?: string,
  approvedByName?: string,
  rejectedBy?: string,
  rejectedByName?: string
): Promise<TrackedChange | null> => {
  try {
    // Find the change by listing all tracked changes and finding the one with matching ID
    const allChanges = await listObjects('tracked-changes/', env);
    
    let change: TrackedChange | null = null;
    let changeKey: string | null = null;
    
    // Find the change with the matching ID
    for (const object of allChanges.objects) {
      const changeObject = await env.R2.get(object.key);
      if (changeObject) {
        const candidateChange = await changeObject.json() as TrackedChange;
        if (candidateChange.id === changeId) {
          change = candidateChange;
          changeKey = object.key;
          break;
        }
      }
    }
    
    if (!change || !changeKey) {
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
      rejectedAt: status === 'rejected' ? timestamp : change.rejectedAt
    };
    
    // Store the updated change in R2 and cache
    await putObject(changeKey, updatedChange, env);
    
    // Also cache it individually
    const cacheKey = `change:${changeKey}`;
    await putObject(cacheKey, updatedChange, env, undefined, 3600); // Cache for 1 hour
    
    // Invalidate the submission's tracked changes cache
    await deleteObject(`tracked_changes:submission:${change.submissionId}`, env);
    
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