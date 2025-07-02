import { CustomRequest } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { AutoRouter } from 'itty-router';

interface TrackedChange {
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

interface ChangeComment {
  id: string;
  changeId: string;
  submissionId: string;
  content: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

// Get all tracked changes for a submission
export async function getTrackedChanges(request: CustomRequest, env: any): Promise<Response> {
  const { submissionId } = request.params!;
  
  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Get submission to check permissions
    const submission = await env.DB.prepare(
      'SELECT * FROM content_submissions WHERE id = ?'
    ).bind(submissionId).first();

    if (!submission) {
      return new Response('Submission not found', { status: 404 });
    }

    // Check if user has access
    const hasAccess = request.user.userType === 'Admin' ||
                     request.user.userType === 'CommsCadre' ||
                     request.user.userType === 'CouncilManager' ||
                     submission.submittedBy === request.user.id;

    if (!hasAccess) {
      return new Response('Forbidden', { status: 403 });
    }

    // Get all changes for the submission
    const changes = await env.DB.prepare(`
      SELECT 
        tc.*,
        u1.name as changedByName,
        u2.name as approvedByName,
        u3.name as rejectedByName
      FROM tracked_changes tc
      LEFT JOIN users u1 ON tc.changedBy = u1.id
      LEFT JOIN users u2 ON tc.approvedBy = u2.id
      LEFT JOIN users u3 ON tc.rejectedBy = u3.id
      WHERE tc.submissionId = ?
      ORDER BY tc.timestamp DESC
    `).bind(submissionId).all();

    // Get comments for each change
    const changeIds = changes.results.map((c: any) => c.id);
    const comments = changeIds.length > 0 ? await env.DB.prepare(`
      SELECT 
        cc.*,
        u.name as authorName
      FROM change_comments cc
      JOIN users u ON cc.authorId = u.id
      WHERE cc.changeId IN (${changeIds.map(() => '?').join(',')})
      ORDER BY cc.createdAt ASC
    `).bind(...changeIds).all() : { results: [] };

    // Group comments by change ID
    const commentsByChange: Record<string, any[]> = {};
    comments.results.forEach((comment: any) => {
      if (!commentsByChange[comment.changeId]) {
        commentsByChange[comment.changeId] = [];
      }
      commentsByChange[comment.changeId].push(comment);
    });

    // Add comments to changes
    const changesWithComments = changes.results.map((change: any) => ({
      ...change,
      comments: commentsByChange[change.id] || []
    }));

    return new Response(JSON.stringify(changesWithComments), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error fetching tracked changes:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Create a new tracked change (suggestion)
export async function createTrackedChange(request: CustomRequest, env: any): Promise<Response> {
  const { submissionId } = request.params!;
  
  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { field, oldValue, newValue } = await request.json();

    if (!field || !oldValue || !newValue) {
      return new Response('Missing required fields', { status: 400 });
    }

    // Get submission to check permissions
    const submission = await env.DB.prepare(
      'SELECT * FROM content_submissions WHERE id = ?'
    ).bind(submissionId).first();

    if (!submission) {
      return new Response('Submission not found', { status: 404 });
    }

    // Create the tracked change
    const changeId = uuidv4();
    const timestamp = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO tracked_changes (
        id, submissionId, field, oldValue, newValue, 
        changedBy, timestamp, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      changeId,
      submissionId,
      field,
      oldValue,
      newValue,
      request.user.id,
      timestamp,
      'pending'
    ).run();

    // Return the created change
    const change = await env.DB.prepare(`
      SELECT 
        tc.*,
        u.name as changedByName
      FROM tracked_changes tc
      JOIN users u ON tc.changedBy = u.id
      WHERE tc.id = ?
    `).bind(changeId).first();

    return new Response(JSON.stringify(change), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error creating tracked change:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Approve or reject a tracked change
export async function updateChangeStatus(request: CustomRequest, env: any): Promise<Response> {
  const { changeId } = request.params!;
  
  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { status, comment } = await request.json();

    if (!['approved', 'rejected'].includes(status)) {
      return new Response('Invalid status', { status: 400 });
    }

    // Get the change
    const change = await env.DB.prepare(
      'SELECT * FROM tracked_changes WHERE id = ?'
    ).bind(changeId).first();

    if (!change) {
      return new Response('Change not found', { status: 404 });
    }

    // Check permissions
    const hasPermission = request.user.userType === 'Admin' ||
                         request.user.userType === 'CommsCadre' ||
                         request.user.userType === 'CouncilManager';

    if (!hasPermission) {
      // Check if user is the submitter
      const submission = await env.DB.prepare(
        'SELECT submittedBy FROM content_submissions WHERE id = ?'
      ).bind(change.submissionId).first();

      if (!submission || submission.submittedBy !== request.user.id) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    // Update the change status
    const timestamp = new Date().toISOString();
    const updateFields = status === 'approved' 
      ? { approvedBy: request.user.id, approvedAt: timestamp }
      : { rejectedBy: request.user.id, rejectedAt: timestamp };

    await env.DB.prepare(`
      UPDATE tracked_changes 
      SET status = ?, ${status === 'approved' ? 'approvedBy' : 'rejectedBy'} = ?, 
          ${status === 'approved' ? 'approvedAt' : 'rejectedAt'} = ?
      WHERE id = ?
    `).bind(status, request.user.id, timestamp, changeId).run();

    // If there's a comment, add it
    if (comment) {
      const commentId = uuidv4();
      await env.DB.prepare(`
        INSERT INTO change_comments (
          id, changeId, submissionId, content, authorId, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        commentId,
        changeId,
        change.submissionId,
        comment,
        request.user.id,
        timestamp
      ).run();
    }

    // If approved, apply the change to the submission
    if (status === 'approved' && change.field === 'content') {
      const submission = await env.DB.prepare(
        'SELECT content FROM content_submissions WHERE id = ?'
      ).bind(change.submissionId).first();

      if (submission) {
        const newContent = submission.content.replace(change.oldValue, change.newValue);
        await env.DB.prepare(
          'UPDATE content_submissions SET content = ?, updatedAt = ? WHERE id = ?'
        ).bind(newContent, timestamp, change.submissionId).run();
      }
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
export async function addChangeComment(request: CustomRequest, env: any): Promise<Response> {
  const { changeId } = request.params!;
  
  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { content } = await request.json();

    if (!content) {
      return new Response('Missing comment content', { status: 400 });
    }

    // Get the change
    const change = await env.DB.prepare(
      'SELECT * FROM tracked_changes WHERE id = ?'
    ).bind(changeId).first();

    if (!change) {
      return new Response('Change not found', { status: 404 });
    }

    // Create the comment
    const commentId = uuidv4();
    const timestamp = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO change_comments (
        id, changeId, submissionId, content, authorId, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      commentId,
      changeId,
      change.submissionId,
      content,
      request.user.id,
      timestamp
    ).run();

    // Return the created comment
    const comment = await env.DB.prepare(`
      SELECT 
        cc.*,
        u.name as authorName
      FROM change_comments cc
      JOIN users u ON cc.authorId = u.id
      WHERE cc.id = ?
    `).bind(commentId).first();

    return new Response(JSON.stringify(comment), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error adding comment:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Get change history for analytics
export async function getChangeHistory(request: CustomRequest, env: any): Promise<Response> {
  if (!request.user || !['Admin', 'CommsCadre', 'CouncilManager'].includes(request.user.userType)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const { startDate, endDate, userId } = request.params!;
    
    let query = `
      SELECT 
        tc.*,
        cs.title as submissionTitle,
        u1.name as changedByName,
        u2.name as approvedByName,
        u3.name as rejectedByName
      FROM tracked_changes tc
      JOIN content_submissions cs ON tc.submissionId = cs.id
      LEFT JOIN users u1 ON tc.changedBy = u1.id
      LEFT JOIN users u2 ON tc.approvedBy = u2.id
      LEFT JOIN users u3 ON tc.rejectedBy = u3.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (startDate) {
      query += ' AND tc.timestamp >= ?';
      params.push(startDate);
    }
    
    if (endDate) {
      query += ' AND tc.timestamp <= ?';
      params.push(endDate);
    }
    
    if (userId) {
      query += ' AND tc.changedBy = ?';
      params.push(userId);
    }
    
    query += ' ORDER BY tc.timestamp DESC LIMIT 100';
    
    const changes = await env.DB.prepare(query).bind(...params).all();

    // Calculate statistics
    const stats = {
      totalChanges: changes.results.length,
      pendingChanges: changes.results.filter((c: any) => c.status === 'pending').length,
      approvedChanges: changes.results.filter((c: any) => c.status === 'approved').length,
      rejectedChanges: changes.results.filter((c: any) => c.status === 'rejected').length,
      uniqueContributors: new Set(changes.results.map((c: any) => c.changedBy)).size
    };

    return new Response(JSON.stringify({ changes: changes.results, stats }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error fetching change history:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Create the router
export const router = AutoRouter()
  .get('/submission/:submissionId', getTrackedChanges)
  .post('/submission/:submissionId', createTrackedChange)
  .put('/change/:changeId/status', updateChangeStatus)
  .post('/change/:changeId/comment', addChangeComment)
  .get('/history', getChangeHistory);