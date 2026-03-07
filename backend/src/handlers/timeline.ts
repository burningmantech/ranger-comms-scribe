import { AutoRouter } from 'itty-router';
import { CustomRequest, ContentSubmission, TimelineEvent } from '../types';
import { getObject } from '../services/cacheService';
import { getTrackedChanges, TrackedChange } from '../services/trackedChangesService';
import { v4 as uuidv4 } from 'uuid';

// GET /submission/:submissionId — returns merged, chronologically sorted timeline events
async function getTimelineHandler(request: CustomRequest, env: any): Promise<Response> {
  const { submissionId } = request.params!;

  if (!request.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Load the submission from cache
    const submission = await getObject<ContentSubmission>('content_submissions/' + submissionId, env);

    if (!submission) {
      return new Response('Submission not found', { status: 404 });
    }

    const events: TimelineEvent[] = [];

    // 1. Submission created event
    events.push({
      id: uuidv4(),
      type: 'submission_created',
      timestamp: submission.submittedAt,
      actorId: submission.submittedBy,
      actorName: '', // submittedBy is a user ID; name not stored on submission
      actorEmail: '',
      summary: `Submission "${submission.title}" was created`,
    });

    // 2. Approval events — from submission.approvals array
    if (submission.approvals && submission.approvals.length > 0) {
      for (const approval of submission.approvals) {
        events.push({
          id: uuidv4(),
          type: 'approval_decision',
          timestamp: approval.createdAt,
          actorId: approval.approverId,
          actorName: approval.approverName,
          actorEmail: approval.approverEmail,
          summary: `${approval.approverName} ${approval.status} the submission`,
          details: {
            status: approval.status,
            approverType: approval.approverType,
            comment: approval.comment,
          },
        });
      }
    }

    // 3. Comment events — from submission.comments array
    if (submission.comments && submission.comments.length > 0) {
      for (const comment of submission.comments) {
        const snippet = comment.content.length > 150
          ? comment.content.substring(0, 150) + '...'
          : comment.content;
        events.push({
          id: uuidv4(),
          type: 'comment_added',
          timestamp: comment.createdAt,
          actorId: comment.authorId,
          actorName: comment.authorName,
          actorEmail: '',
          summary: `${comment.authorName} commented: "${snippet}"`,
          details: {
            commentId: comment.id,
            isSuggestion: comment.isSuggestion,
            resolved: comment.resolved,
          },
        });
      }
    }

    // 4. Tracked change events — load from trackedChangesService
    try {
      const trackedChanges = await getTrackedChanges(submissionId, env);

      if (trackedChanges && trackedChanges.length > 0) {
        for (const change of trackedChanges) {
          const changeTimestamp = new Date(change.timestamp).getTime();
          const groupKey = `${change.changedBy}-${Math.floor(changeTimestamp / 120000)}`;

          events.push({
            id: uuidv4(),
            type: 'tracked_changes_made',
            timestamp: change.timestamp,
            actorId: change.changedBy,
            actorName: change.changedByName,
            actorEmail: '',
            summary: `${change.changedByName} made a tracked change to "${change.field}"`,
            details: {
              changeId: change.id,
              field: change.field,
              status: change.status,
            },
            groupKey,
          });

          // 5. Tracked change review events — for changes with status 'approved' or 'rejected'
          if (change.status === 'approved' && change.approvedBy) {
            events.push({
              id: uuidv4(),
              type: 'tracked_change_reviewed',
              timestamp: change.approvedAt || change.timestamp,
              actorId: change.approvedBy,
              actorName: change.approvedByName || '',
              actorEmail: '',
              summary: `${change.approvedByName || 'A reviewer'} approved a tracked change to "${change.field}"`,
              details: {
                changeId: change.id,
                field: change.field,
                decision: 'approved',
              },
            });
          } else if (change.status === 'rejected' && change.rejectedBy) {
            events.push({
              id: uuidv4(),
              type: 'tracked_change_reviewed',
              timestamp: change.rejectedAt || change.timestamp,
              actorId: change.rejectedBy,
              actorName: change.rejectedByName || '',
              actorEmail: '',
              summary: `${change.rejectedByName || 'A reviewer'} rejected a tracked change to "${change.field}"`,
              details: {
                changeId: change.id,
                field: change.field,
                decision: 'rejected',
              },
            });
          }
        }
      }
    } catch (err) {
      console.error('Error loading tracked changes for timeline:', err);
      // Continue without tracked changes rather than failing the entire timeline
    }

    // 6. Override approval event — if submission.approvalOverride is true
    if (submission.approvalOverride) {
      events.push({
        id: uuidv4(),
        type: 'override_approval',
        timestamp: submission.approvalOverrideAt || submission.submittedAt,
        actorId: submission.approvalOverrideBy || '',
        actorName: submission.approvalOverrideBy || '',
        actorEmail: '',
        summary: `Approval was overridden${submission.approvalOverrideReason ? ': ' + submission.approvalOverrideReason : ''}`,
        details: {
          reason: submission.approvalOverrideReason,
          overrideBy: submission.approvalOverrideBy,
        },
      });
    }

    // Sort events by timestamp descending (newest first)
    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return new Response(JSON.stringify(events), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error building timeline:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// Create the router
export const timelineRouter = AutoRouter({ base: '/api/timeline' })
  .get('/submission/:submissionId', getTimelineHandler);
