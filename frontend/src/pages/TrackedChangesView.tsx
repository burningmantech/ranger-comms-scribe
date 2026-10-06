import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { TrackedChangesEditor } from '../components/TrackedChangesEditor';
import ReviewTopBar from '../components/ReviewTopBar';
import { ContentSubmission, User, Comment, Change, Approval, ApprovalGates } from '../types/content';
import { useContent } from '../contexts/ContentContext';
import { API_URL } from '../config';
import { extractTextFromLexical, isLexicalJson } from '../utils/lexicalUtils';
import { useCollabMode } from '../services/collabConfig';
import { useUserDirectory } from '../services/userDirectory';
import { applyChangeStatus, ChangeResolver, ResolvedStatus } from '../utils/changeStatus';
import { countOpenEdits } from '../utils/reviewItems';
import { mergeComment } from '../utils/remoteComments';
import { applyCommentResolution, applyReviewStateMessage, needsReviewStateRefresh } from '../utils/reviewState';
import type { WebSocketMessage } from '../services/websocketService';

/** A stored submission comment in the frontend's shape (resolve fields included). */
export function toFrontendComment(raw: any): Comment {
  return {
    id: raw.id,
    content: raw.content,
    authorId: raw.authorId,
    createdAt: new Date(raw.createdAt),
    type: raw.isSuggestion ? 'SUGGESTION' : 'COMMENT',
    resolved: raw.resolved || false,
    ...(raw.resolved ? { resolvedBy: raw.resolvedBy, resolvedByName: raw.resolvedByName, resolvedAt: raw.resolvedAt } : {}),
  };
}

/** Stored approvals in the frontend's shape. */
const toFrontendApprovals = (approvals: any[] | undefined): Approval[] => (approvals || []).map((approval: any) => ({
  id: approval.id,
  approverId: approval.approverId,
  approverEmail: approval.approverEmail,
  status: approval.status.toUpperCase(),
  comment: approval.comment,
  timestamp: new Date(approval.createdAt)
}));

/** Delay before refetching the status and gates, so a burst of messages makes one request. */
const REVIEW_STATE_REFRESH_MS = 300;

export const TrackedChangesView: React.FC = () => {
  const { submissionId } = useParams<{ submissionId: string }>();
  const navigate = useNavigate();
  const { currentUser, userPermissions, deleteSubmission, sendAnnouncementEmail } = useContent();
  const [submission, setSubmission] = useState<ContentSubmission | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Real-time editing mode from GET /api/config (fetched in parallel with the submission).
  // The editor waits for it so it never switches modes mid-session.
  const collabMode = useCollabMode();

  // Set body background color for this page
  useEffect(() => {
    const originalBackground = document.body.style.backgroundColor;
    document.body.style.backgroundColor = '#f8f9fa';
    return () => {
      document.body.style.backgroundColor = originalBackground;
    };
  }, []);

  const fetchSubmission = async () => {
    if (!submissionId) {
      setError('No submission ID provided');
      setLoading(false);
      return;
    }

    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) {
        setError('Not authenticated');
        setLoading(false);
        return;
      }

      // Fetch both submission data and tracked changes
      const [submissionResponse, trackedChangesResponse] = await Promise.all([
        fetch(`${API_URL}/content/submissions/${submissionId}`, {
          headers: {
            Authorization: `Bearer ${sessionId}`,
          },
        }),
        fetch(`${API_URL}/tracked-changes/submission/${submissionId}`, {
          headers: {
            Authorization: `Bearer ${sessionId}`,
          },
        })
      ]);

      if (!submissionResponse.ok) {
        throw new Error(`Failed to fetch submission: ${submissionResponse.status}`);
      }

      const data = await submissionResponse.json();
      const trackedChanges = trackedChangesResponse.ok ? await trackedChangesResponse.json() : [];

      console.log('[TrackedChangesView] fetchSubmission:', {
        trackedChangesResponseOk: trackedChangesResponse.ok,
        trackedChangesResponseStatus: trackedChangesResponse.status,
        changesCount: trackedChanges?.changes?.length ?? 0,
        changeIds: trackedChanges?.changes?.map((c: any) => c.id)?.slice(0, 5),
      });

      // Determine the content to use for the tracked changes editor
      let content = data.content || '';

      // Handle different content formats
      let richTextContent = data.richTextContent;

      if (content) {
        // If content is an object, it might be Lexical JSON
        if (typeof content === 'object') {
          if (isLexicalJson(content)) {
            // Preserve the Lexical JSON for rich text display
            richTextContent = content;
            const extractedText = extractTextFromLexical(content);
            if (extractedText) {
              content = extractedText;
            }
          }
        }
        // If content is a string that looks like JSON
        else if (typeof content === 'string' && content.trim().startsWith('{') && isLexicalJson(content)) {
          // Preserve the Lexical JSON for rich text display
          richTextContent = content;
          const extractedText = extractTextFromLexical(content);
          if (extractedText) {
            content = extractedText;
          }
        }
      }

      // If we still don't have readable content, try richTextContent
      if (!content || content.trim() === '') {
        if (data.richTextContent) {
          const isLexical = isLexicalJson(data.richTextContent);

          if (isLexical) {
            // If richTextContent is Lexical JSON, extract plain text from it
            const extractedText = extractTextFromLexical(data.richTextContent);
            if (extractedText) {
              content = extractedText;
            }
          }
        }
      }

      // Final fallback
      if (!content || content.trim() === '') {
        content = 'No content available';
      }

      // Transform tracked changes to the format expected by the frontend
      const transformedChanges = (trackedChanges.changes || []).map((change: any) => ({
        id: change.id,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        changedBy: change.changedBy,
        timestamp: new Date(change.timestamp),
        status: change.status || 'pending',
        approvedBy: change.approvedBy,
        approvedByName: change.approvedByName,
        rejectedBy: change.rejectedBy,
        rejectedByName: change.rejectedByName,
        approvedAt: change.approvedAt,
        rejectedAt: change.rejectedAt,
        isIncremental: change.isIncremental || false,
        previousVersionId: change.previousVersionId,
        completeProposedVersion: change.completeProposedVersion,
        richTextOldValue: change.richTextOldValue,
        richTextNewValue: change.richTextNewValue,
        regionMap: change.regionMap,
      }));

      // Transform backend data to frontend format
      const transformedSubmission: ContentSubmission = {
        id: data.id,
        title: data.title,
        content: content,
        richTextContent: richTextContent,
        originalContent: data.originalContent,
        originalRichTextContent: data.originalRichTextContent,
        status: data.status,
        submittedBy: data.submittedBy,
        submittedAt: new Date(data.submittedAt),
        formFields: data.formFields || [],
        comments: (data.comments || []).map(toFrontendComment),
        approvals: toFrontendApprovals(data.approvals),
        changes: transformedChanges, // Use the tracked changes from the separate API
        assignedReviewers: [],
        assignedCouncilManagers: data.assignedCouncilManagers || [],
        suggestedEdits: [],
        requiredApprovers: data.requiredApprovers || [],
        commsApprovedBy: data.commsApprovedBy,
        sentBy: data.sentBy,
        sentAt: data.sentAt ? new Date(data.sentAt) : undefined,
        approvalGates: data.approvalGates,
        // Add proposed versions with rich text support
        proposedVersions: {
          // Start with base proposed versions (plain text)
          ...trackedChanges.proposedVersions,
          // Override with rich text content if available (prioritize rich text)
          ...(trackedChanges.proposedVersionsRichText && {
            richTextContent: trackedChanges.proposedVersionsRichText.content
          }),
          // Also set content field from plain text versions if not already set
          ...(trackedChanges.proposedVersions && {
            content: trackedChanges.proposedVersions.content
          })
        }
      };

      console.log(`[FETCH-SUBMISSION] proposedVersions.richTextContent first 150 chars:`, transformedSubmission.proposedVersions?.richTextContent?.substring(0, 150));
      console.log(`[FETCH-SUBMISSION] trackedChanges.proposedVersionsRichText:`, trackedChanges.proposedVersionsRichText ? `type=${typeof trackedChanges.proposedVersionsRichText}, has .content=${!!trackedChanges.proposedVersionsRichText?.content}` : 'null/undefined');

      setSubmission(transformedSubmission);
    } catch (err) {
      console.error('Error fetching submission:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch submission');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSubmission();
  }, [submissionId]);

  // Refresh function for WebSocket-triggered updates
  const handleRefreshNeeded = async () => {
    try {
      await fetchSubmission();
    } catch (error) {
      console.error('TrackedChangesView: Refresh failed:', error);
    }
  };

  const handleSave = async (updatedSubmission: ContentSubmission) => {
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) throw new Error('Not authenticated');

      // Safely convert date-like values (Date objects or strings) to ISO strings
      const toISO = (val: any): string => {
        if (!val) return new Date().toISOString();
        if (val instanceof Date) return val.toISOString();
        if (typeof val === 'string') return val;
        try { return new Date(val).toISOString(); } catch { return new Date().toISOString(); }
      };

      // Transform frontend data to backend format
      const backendSubmission = {
        id: updatedSubmission.id,
        title: updatedSubmission.title,
        content: updatedSubmission.content, // This is now the plain text from tracked changes editor
        richTextContent: updatedSubmission.richTextContent, // Keep the original Lexical data
        status: updatedSubmission.status,
        submittedBy: updatedSubmission.submittedBy,
        submittedAt: toISO(updatedSubmission.submittedAt),
        formFields: updatedSubmission.formFields,
        comments: updatedSubmission.comments.map(comment => ({
          id: comment.id,
          content: comment.content,
          authorId: comment.authorId,
          createdAt: toISO(comment.createdAt),
          isSuggestion: comment.type === 'SUGGESTION',
          resolved: comment.resolved
        })),
        approvals: updatedSubmission.approvals.map(approval => ({
          id: approval.id,
          approverId: approval.approverId,
          status: approval.status.toLowerCase(),
          comment: approval.comment,
          createdAt: toISO(approval.timestamp)
        })),
        changes: updatedSubmission.changes.map(change => ({
          id: change.id,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          changedBy: change.changedBy,
          changedAt: toISO(change.timestamp)
        })),
        assignedCouncilManagers: updatedSubmission.assignedCouncilManagers,
        requiredApprovers: updatedSubmission.requiredApprovers,
        commsApprovedBy: updatedSubmission.commsApprovedBy,
        sentBy: updatedSubmission.sentBy,
        sentAt: updatedSubmission.sentAt ? toISO(updatedSubmission.sentAt) : undefined,
        // Include the proposed versions data
        proposedVersions: updatedSubmission.proposedVersions
      };

      // Send only the fields this save changed. The rest of the loaded copy may be stale
      // (another user accepted a change, approved, ...) and the backend merges the body
      // over the stored submission, so sending it would undo their work. In particular an
      // unchanged proposedVersions would overwrite the proposed document with the one
      // loaded with the page, hiding every edit made since.
      const loaded = submission;
      const changed = (key: keyof ContentSubmission) =>
        !loaded || JSON.stringify(updatedSubmission[key]) !== JSON.stringify(loaded[key]);
      // Never the status, comments or approvals: the server owns them (they follow the
      // tracked changes, the comment and resolve endpoints, and the approve endpoint), and
      // they change under this page from the submission room.
      const serverOwned = new Set<string>(['id', 'status', 'comments', 'approvals']);
      const body: Record<string, unknown> = { id: backendSubmission.id };
      for (const key of Object.keys(backendSubmission) as Array<keyof typeof backendSubmission>) {
        if (!serverOwned.has(key) && changed(key as keyof ContentSubmission)) body[key] = backendSubmission[key];
      }
      const proposedVersionsChanged = !!updatedSubmission.proposedVersions && changed('proposedVersions');

      // Save to both submission and tracked changes APIs
      const [submissionResponse, trackedChangesResponse] = await Promise.all([
        fetch(`${API_URL}/content/submissions/${submissionId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionId}`,
          },
          body: JSON.stringify(body),
        }),
        // Save proposed versions to tracked changes API
        proposedVersionsChanged && updatedSubmission.proposedVersions ? (() => {
          const trackedChangesPayload = {
            proposedVersionsRichText: updatedSubmission.proposedVersions.richTextContent,
            proposedVersionsContent: updatedSubmission.proposedVersions.content
          };



          return fetch(`${API_URL}/tracked-changes/submission/${submissionId}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${sessionId}`,
            },
            body: JSON.stringify(trackedChangesPayload),
          });
        })() : Promise.resolve({ ok: true })
      ]);

      if (!submissionResponse.ok) {
        throw new Error(`Failed to save submission: ${submissionResponse.status}`);
      }

      if (!trackedChangesResponse.ok) {
        console.warn('Failed to save tracked changes, but submission was saved');
      }

      // Keep the frontend-shaped copy with this save applied. The response is the raw
      // backend record (other shapes, no approvalGates, and a proposedVersions that is
      // stale when this save didn't send one).
      await submissionResponse.json().catch(() => null);
      setSubmission(updatedSubmission);


    } catch (err) {
      console.error('Error saving submission:', err);
      // You might want to show an error message to the user here
    }
  };

  const handleComment = async (comment: Comment) => {
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/content/submissions/${submissionId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify(comment),
      });

      if (!response.ok) {
        throw new Error(`Failed to add comment: ${response.status}`);
      }

      // The endpoint returns the new comment (not the submission). Add it to the current
      // submission with a functional update and keep everything else as it is: rebuilding
      // the submission from this response would drop the changes' status (and who
      // resolved them), the proposed versions and the other comments, and an accept or
      // reject that arrived while the POST was in flight must not be overwritten.
      const saved = await response.json();
      const newComment: Comment = saved?.id
        ? toFrontendComment({ ...saved, content: saved.content ?? comment.content, authorId: saved.authorId || comment.authorId, createdAt: saved.createdAt || comment.createdAt })
        : { ...comment, resolved: false };
      setSubmission(prev => {
        if (!prev || prev.comments.some(c => c.id === newComment.id)) return prev;
        return { ...prev, comments: [...prev.comments, newComment] };
      });
    } catch (err) {
      console.error('Error adding comment:', err);
    }
  };

  // A comment another session posted (over the submission room): into the Open list now.
  const handleRemoteComment = useCallback((comment: Comment) => {
    setSubmission(prev => {
      if (!prev) return prev;
      const comments = mergeComment(prev.comments, comment);
      return comments === prev.comments ? prev : { ...prev, comments };
    });
  }, []);

  // ---- The status, approval gates and comment resolutions, kept current from the room ----
  // Messages are applied as they come (they carry the server's state); a refetch of just the
  // status, gates and approvals covers messages without them and reconnects. Never a full
  // fetchSubmission: that replaces the change list and proposed versions under the editor.
  const submissionRef = useRef(submission);
  submissionRef.current = submission;
  const reviewStateVersionRef = useRef(0);
  const reviewStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshReviewState = useCallback(async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId || !submissionId) return;
    const version = reviewStateVersionRef.current;
    try {
      const response = await fetch(`${API_URL}/content/submissions/${submissionId}`, {
        headers: { Authorization: `Bearer ${sessionId}` },
      });
      if (!response.ok) return;
      const data = await response.json();
      // A message applied meanwhile is newer than this response
      if (version !== reviewStateVersionRef.current) return;
      setSubmission(prev => {
        if (!prev || prev.id !== data.id) return prev;
        return {
          ...prev,
          status: data.status ?? prev.status,
          approvalGates: data.approvalGates ?? prev.approvalGates,
          approvals: toFrontendApprovals(data.approvals),
        };
      });
    } catch (err) {
      console.error('TrackedChangesView: could not refresh the review state:', err);
    }
  }, [submissionId]);
  const scheduleReviewStateRefresh = useCallback(() => {
    if (reviewStateTimerRef.current) clearTimeout(reviewStateTimerRef.current);
    reviewStateTimerRef.current = setTimeout(() => {
      reviewStateTimerRef.current = null;
      refreshReviewState();
    }, REVIEW_STATE_REFRESH_MS);
  }, [refreshReviewState]);
  useEffect(() => () => {
    if (reviewStateTimerRef.current) clearTimeout(reviewStateTimerRef.current);
  }, []);

  const handleReviewStateMessage = useCallback((message: WebSocketMessage) => {
    if (message.submissionId && submissionId && message.submissionId !== submissionId) return;
    reviewStateVersionRef.current++;
    setSubmission(prev => (prev ? applyReviewStateMessage(prev, message) : prev));
    if (needsReviewStateRefresh(message)) scheduleReviewStateRefresh();
  }, [submissionId, scheduleReviewStateRefresh]);

  // Resolve (true) or reopen (false) a comment thread: shown at once, undone if the server refuses.
  const handleResolveComment = useCallback(async (commentId: string, resolved: boolean): Promise<boolean> => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId || !submissionId) return false;
    const before = submissionRef.current?.comments.find(c => c.id === commentId);
    setSubmission(prev => {
      if (!prev) return prev;
      const comments = applyCommentResolution(prev.comments, {
        commentId,
        resolved,
        resolvedBy: currentUser?.email || currentUser?.id,
        resolvedByName: currentUser?.name,
        resolvedAt: new Date().toISOString(),
      });
      return comments === prev.comments ? prev : { ...prev, comments };
    });
    try {
      const response = await fetch(`${API_URL}/content/submissions/${submissionId}/comments/${commentId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionId}` },
        body: JSON.stringify({ resolved }),
      });
      if (!response.ok) throw new Error(`the server answered ${response.status}`);
      const saved = await response.json().catch(() => null);
      if (saved?.id) {
        setSubmission(prev => {
          if (!prev) return prev;
          const comments = applyCommentResolution(prev.comments, {
            commentId, resolved: !!saved.resolved, resolvedBy: saved.resolvedBy, resolvedByName: saved.resolvedByName, resolvedAt: saved.resolvedAt,
          });
          return comments === prev.comments ? prev : { ...prev, comments };
        });
      }
      return true;
    } catch (err) {
      console.error(`Could not ${resolved ? 'resolve' : 'reopen'} comment ${commentId}:`, err);
      const previous = before;
      if (previous) {
        setSubmission(prev => {
          if (!prev) return prev;
          const comments = applyCommentResolution(prev.comments, {
            commentId, resolved: previous.resolved, resolvedBy: previous.resolvedBy, resolvedByName: previous.resolvedByName, resolvedAt: previous.resolvedAt,
          });
          return comments === prev.comments ? prev : { ...prev, comments };
        });
      }
      return false;
    }
  }, [submissionId, currentUser?.email, currentUser?.id, currentUser?.name]);

  // Functional updates throughout: these run from timers and long-lived socket handlers
  // (and several times in one batch), so they must never write back a stale submission.
  const setChangeStatus = useCallback((changeIds: string[], status: ResolvedStatus, resolver?: ChangeResolver) => {
    setSubmission(prev => {
      if (!prev) return prev;
      const changes = applyChangeStatus(prev.changes, changeIds, status, resolver);
      return changes === prev.changes ? prev : { ...prev, changes };
    });
  }, []);

  const handleApprove = (changeId: string) => {
    // Optimistic-only: editor owns backend sync via syncChangeStatusToBackend
    setChangeStatus([changeId], 'approved', { id: currentUser?.email || currentUser?.id || '', name: currentUser?.name });
  };

  const handleReject = (changeId: string) => {
    // Optimistic-only: editor owns backend sync via syncChangeStatusToBackend
    setChangeStatus([changeId], 'rejected', { id: currentUser?.email || currentUser?.id || '', name: currentUser?.name });
  };

  // Update a change's status locally when another user accepts/rejects it (or when the
  // server cascade-rejects it). In legacy mode this replaces a refetch, which would
  // re-initialize the editor; in collaborative mode the editor also refetches the list.
  const handleRemoteChangeResolved = useCallback((changeId: string, status: string, resolver?: ChangeResolver) => {
    if (status !== 'approved' && status !== 'rejected') return;
    setChangeStatus([changeId], status, resolver);
  }, [setChangeStatus]);

  const handleSuggestion = async (suggestion: Change): Promise<Change | undefined> => {
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) throw new Error('Not authenticated');
      const response = await fetch(`${API_URL}/tracked-changes/submission/${submissionId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify(suggestion),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('TrackedChangesView: API error response:', errorText);
        throw new Error(`Failed to create suggestion: ${response.status} - ${errorText}`);
      }

      const createdChange = await response.json();

      // Refresh both submission and tracked changes data
      const [submissionResponse, trackedChangesResponse] = await Promise.all([
        fetch(`${API_URL}/content/submissions/${submissionId}`, {
          headers: {
            Authorization: `Bearer ${sessionId}`,
          },
        }),
        fetch(`${API_URL}/tracked-changes/submission/${submissionId}`, {
          headers: {
            Authorization: `Bearer ${sessionId}`,
          },
        })
      ]);



      if (submissionResponse.ok && trackedChangesResponse.ok) {
        const data = await submissionResponse.json();
        const trackedChanges = await trackedChangesResponse.json();



        // Transform tracked changes to the format expected by the frontend
        const transformedChanges = (trackedChanges.changes || []).map((change: any) => ({
          id: change.id,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          changedBy: change.changedBy,
          timestamp: new Date(change.timestamp),
          status: change.status || 'pending',
          approvedBy: change.approvedBy,
          approvedByName: change.approvedByName,
          rejectedBy: change.rejectedBy,
          rejectedByName: change.rejectedByName,
          approvedAt: change.approvedAt,
          rejectedAt: change.rejectedAt,
          isIncremental: change.isIncremental || false,
          previousVersionId: change.previousVersionId,
          completeProposedVersion: change.completeProposedVersion,
          richTextOldValue: change.richTextOldValue,
          richTextNewValue: change.richTextNewValue,
          regionMap: change.regionMap,
        }));

        // Transform backend data to frontend format
        const transformedSubmission: ContentSubmission = {
          id: data.id,
          title: data.title,
          content: data.content,
          richTextContent: data.richTextContent,
          originalContent: data.originalContent,
          originalRichTextContent: data.originalRichTextContent,
          status: data.status,
          submittedBy: data.submittedBy,
          submittedAt: new Date(data.submittedAt),
          formFields: data.formFields || [],
          comments: (data.comments || []).map(toFrontendComment),
          approvals: toFrontendApprovals(data.approvals),
          changes: transformedChanges,
          assignedReviewers: [],
          assignedCouncilManagers: data.assignedCouncilManagers || [],
          suggestedEdits: [],
          requiredApprovers: data.requiredApprovers || [],
          commsApprovedBy: data.commsApprovedBy,
          sentBy: data.sentBy,
          sentAt: data.sentAt ? new Date(data.sentAt) : undefined,
          approvalGates: data.approvalGates,
          // Add proposed versions with rich text support
          proposedVersions: {
            // Start with base proposed versions (plain text)
            ...trackedChanges.proposedVersions,
            // Override with rich text content if available (prioritize rich text)
            ...(trackedChanges.proposedVersionsRichText && {
              richTextContent: trackedChanges.proposedVersionsRichText.content
            }),
            // Also set content field from plain text versions if not already set
            ...(trackedChanges.proposedVersions && {
              content: trackedChanges.proposedVersions.content
            })
          }
        };

        setSubmission(transformedSubmission);
      } else {
        console.error('TrackedChangesView: Failed to refresh data:', {
          submission: submissionResponse.status,
          trackedChanges: trackedChangesResponse.status
        });
      }

      return createdChange;
    } catch (err) {
      console.error('Error creating suggestion:', err);
      return undefined;
    }
  };

  const handleSendEmail = async () => {
    if (!submission) return;
    await sendAnnouncementEmail(submission);
    await fetchSubmission();
  };

  const handleDelete = async () => {
    if (!submission) return;
    try {
      await deleteSubmission(submission.id);
      navigate('/requests');
    } catch (err) {
      console.error('Failed to delete submission:', err);
      setError('Failed to delete submission. Please try again.');
    }
  };

  if (loading || !collabMode) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '24rem' }}>
        <div className="loading-container">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '16px' }}>
        <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '16px' }}>
          <h3 style={{ fontSize: '1.125rem', fontWeight: 600, color: '#991b1b', marginBottom: '8px' }}>Error</h3>
          <p style={{ color: '#b91c1c' }}>{error}</p>
          <button
            onClick={() => navigate('/requests')}
            className="btn btn-neutral"
          >
            Back to Requests
          </button>
        </div>
      </div>
    );
  }

  if (!submission || !currentUser) {
    return (
      <div style={{ padding: '16px' }}>
        <div style={{ backgroundColor: '#fefce8', border: '1px solid #fde68a', borderRadius: '8px', padding: '16px' }}>
          <h3 style={{ fontSize: '1.125rem', fontWeight: 600, color: '#854d0e', marginBottom: '8px' }}>Not Found</h3>
          <p style={{ color: '#a16207' }}>Submission not found or you don't have access to it.</p>
          <button
            onClick={() => navigate('/requests')}
            className="btn btn-neutral"
          >
            Back to Requests
          </button>
        </div>
      </div>
    );
  }

  // Determine if current user can approve/reject the submission
  const userRoles = currentUser.roles || [];
  const canApprove = userRoles.includes('CommsCadre') ||
    userRoles.includes('CouncilManager') ||
    userRoles.includes('Admin') ||
    (submission.requiredApprovers || []).includes(currentUser.email) ||
    (submission.assignedCouncilManagers || []).includes(currentUser.email);

  // Works from the review queue: the same check MySubmissions uses to show the
  // ReviewerDashboard (the queue) instead of the SubmitterDashboard.
  const isReviewer = !!userPermissions?.canViewFilteredSubmissions ||
    userRoles.some(r => ['CommsCadre', 'CouncilManager', 'Admin'].includes(r));

  // Check urgency from form fields
  const isUrgent = submission.formFields?.some(
    (f: any) => f.name === 'urgent' && (f.value === 'true' || f.value === true)
  ) || false;

  // The reviewer's vote on the whole request (Finish review). Resolves to whether it was
  // recorded, with the server's message when it wasn't.
  const postSubmissionDecision = async (status: 'approved' | 'rejected'): Promise<DecisionResult> => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) return { ok: false, error: 'You are not signed in' };
    try {
      const response = await fetch(`${API_URL}/content/submissions/${submission.id}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ status })
      });
      const body = response.ok ? null : await response.json().catch(() => null);
      await fetchSubmission();
      return response.ok ? { ok: true } : { ok: false, error: body?.error || `the server answered ${response.status}` };
    } catch (err) {
      console.error(`Error recording the ${status} decision:`, err);
      return { ok: false, error: 'network error' };
    }
  };

  const handleSubmissionApprove = () => postSubmissionDecision('approved');
  const handleSubmissionReject = () => postSubmissionDecision('rejected');

  const handleRequestChanges = async (comment: string): Promise<DecisionResult> => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) return { ok: false, error: 'You are not signed in' };
    try {
      const response = await fetch(`${API_URL}/content/submissions/${submission.id}/request-changes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ comment })
      });
      const body = response.ok ? null : await response.json().catch(() => null);
      await fetchSubmission();
      return response.ok ? { ok: true } : { ok: false, error: body?.error || `the server answered ${response.status}` };
    } catch (err) {
      console.error('Error requesting changes:', err);
      return { ok: false, error: 'network error' };
    }
  };

  return (
    <ReviewLayout
      submission={submission}
      currentUser={currentUser}
      canApprove={canApprove}
      isReviewer={isReviewer}
      isUrgent={isUrgent}
      onBack={() => navigate('/requests')}
      onApprove={handleSubmissionApprove}
      onReject={handleSubmissionReject}
      onRequestChanges={handleRequestChanges}
      onNavigate={(id) => navigate(`/tracked-changes/${id}`)}
    >
      <TrackedChangesEditor
        // A fresh editor (Yjs room, TransactionManager, baseline) per submission when
        // paging between submissions, in both modes: the TransactionManager is created
        // once per mount with the submission id, so reusing the editor would save the
        // next submission's edits against the previous one.
        key={submission.id}
        submission={submission}
        currentUser={currentUser}
        onSave={handleSave}
        onComment={handleComment}
        onApprove={handleApprove}
        onReject={handleReject}
        onSuggestion={handleSuggestion}
        onRefreshNeeded={handleRefreshNeeded}
        onRemoteChangeResolved={handleRemoteChangeResolved}
        onRemoteComment={handleRemoteComment}
        onReviewStateMessage={handleReviewStateMessage}
        onResolveComment={handleResolveComment}
        onBack={() => navigate('/requests')}
        reviewMode={true}
        onDelete={handleDelete}
        onSendEmail={handleSendEmail}
        collabMode={collabMode}
      />
    </ReviewLayout>
  );
};

// ---------------------------------------------------------------------------
// ReviewLayout — wraps TCE with ReviewTopBar + Request Changes modal
// ---------------------------------------------------------------------------

/** Outcome of a Finish-review decision: recorded, or not (with the reason). */
export interface DecisionResult {
  ok: boolean;
  error?: string;
}

/** The reviewer's current vote on the whole request, from the submission's approvals. */
export function reviewerDecision(approvals: Approval[] | undefined, user: Pick<User, 'id' | 'email'>): 'approved' | 'rejected' | null {
  const mine = (approvals || []).find(a =>
    (!!a.approverId && a.approverId === user.id) || (!!a.approverEmail && a.approverEmail === user.email));
  const status = String(mine?.status || '').toUpperCase();
  if (status === 'APPROVED') return 'approved';
  if (status === 'REJECTED') return 'rejected';
  return null;
}

const DECISION_TOAST_MS = 5000;

interface ReviewLayoutProps {
  submission: ContentSubmission;
  currentUser: User;
  canApprove: boolean;
  isReviewer: boolean;
  isUrgent: boolean;
  onBack: () => void;
  onApprove: () => Promise<DecisionResult>;
  onReject: () => Promise<DecisionResult>;
  onRequestChanges: (comment: string) => Promise<DecisionResult>;
  onNavigate: (submissionId: string) => void;
  children: React.ReactNode;
}

export const ReviewLayout: React.FC<ReviewLayoutProps> = ({
  submission,
  currentUser,
  canApprove,
  isReviewer,
  isUrgent,
  onBack,
  onApprove,
  onReject,
  onRequestChanges,
  onNavigate,
  children,
}) => {
  const userName = useUserDirectory();
  // Counted like the review sidebar's Open tab: one per card (a move is one edit).
  const pendingEdits = useMemo(() => countOpenEdits(submission.changes || []), [submission.changes]);
  const [showRequestChanges, setShowRequestChanges] = useState(false);
  const [requestChangesComment, setRequestChangesComment] = useState('');
  const requestChangesInputRef = useRef<HTMLTextAreaElement>(null);
  const [showDeclineConfirm, setShowDeclineConfirm] = useState(false);
  const declineCancelRef = useRef<HTMLButtonElement>(null);
  // Non-blocking feedback after a Finish-review decision
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The decision just recorded here, shown until the refetched approvals agree
  const [recordedDecision, setRecordedDecision] = useState<{ submissionId: string; decision: 'approved' | 'rejected' } | null>(null);

  const decisionFromApprovals = reviewerDecision(submission.approvals, currentUser);
  const myDecision = recordedDecision && recordedDecision.submissionId === submission.id
    ? recordedDecision.decision
    : decisionFromApprovals;
  // Once the approvals agree, they are the source again (another session may change it later)
  useEffect(() => {
    if (recordedDecision && (recordedDecision.submissionId !== submission.id || recordedDecision.decision === decisionFromApprovals)) {
      setRecordedDecision(null);
    }
  }, [recordedDecision, decisionFromApprovals, submission.id]);

  const showToast = useCallback((message: string, error = false) => {
    setToast({ message, error });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, DECISION_TOAST_MS);
  }, []);
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  const reportDecision = (result: DecisionResult, success: string, decision?: 'approved' | 'rejected') => {
    if (result.ok) {
      if (decision) setRecordedDecision({ submissionId: submission.id, decision });
      showToast(success);
    } else {
      showToast(`Couldn't record your decision: ${result.error || 'unknown error'}`, true);
    }
  };

  // Focus the comment box when the dialog opens. autoFocus alone loses: the dialog opens
  // from the Finish review menu, which returns focus to its button as it closes (in an
  // effect inside ReviewTopBar, which runs before this one).
  useEffect(() => {
    if (showRequestChanges) requestChangesInputRef.current?.focus();
  }, [showRequestChanges]);
  // Same for the Decline confirmation: focus its Cancel (the safe choice). Escape closes it.
  useEffect(() => {
    if (!showDeclineConfirm) return;
    declineCancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowDeclineConfirm(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showDeclineConfirm]);

  const handleApprove = async () => {
    reportDecision(await onApprove(), 'You approved this request', 'approved');
  };

  const handleConfirmDecline = async () => {
    setShowDeclineConfirm(false);
    reportDecision(await onReject(), 'You declined this request', 'rejected');
  };

  const handleSubmitRequestChanges = async () => {
    const comment = requestChangesComment.trim();
    if (!comment) return;
    setRequestChangesComment('');
    setShowRequestChanges(false);
    reportDecision(await onRequestChanges(comment), 'You requested changes');
  };

  return (
    <div className="review-layout">
      <ReviewTopBar
        submissionId={submission.id}
        title={submission.title}
        submitterName={userName(submission.submittedBy)}
        submittedAt={submission.submittedAt instanceof Date ? submission.submittedAt : new Date(submission.submittedAt)}
        isUrgent={isUrgent}
        approvalGates={(submission as any).approvalGates}
        pendingEdits={pendingEdits}
        canApprove={canApprove}
        isReviewer={isReviewer}
        myDecision={myDecision}
        onBack={onBack}
        onApprove={handleApprove}
        onRequestChanges={() => setShowRequestChanges(true)}
        onReject={() => setShowDeclineConfirm(true)}
        onNavigate={onNavigate}
      />
      {children}

      {/* Request Changes Modal */}
      {showRequestChanges && (
        <div className="request-changes-overlay" onClick={() => setShowRequestChanges(false)}>
          <div className="request-changes-dialog" onClick={e => e.stopPropagation()}>
            <h3>Request Changes</h3>
            <p style={{ margin: '0 0 12px', color: '#666', fontSize: '0.9em' }}>
              The submitter will be notified and can revise their submission. This does not reject the submission.
            </p>
            <textarea
              ref={requestChangesInputRef}
              value={requestChangesComment}
              onChange={e => setRequestChangesComment(e.target.value)}
              placeholder="Describe the changes needed..."
              autoFocus
            />
            <div className="request-changes-actions">
              <button className="btn btn-neutral" onClick={() => setShowRequestChanges(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSubmitRequestChanges}
                disabled={!requestChangesComment.trim()}
              >
                Submit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Decline confirmation (Finish review -> Decline), in the Request Changes modal's style */}
      {showDeclineConfirm && (
        <div className="request-changes-overlay" onClick={() => setShowDeclineConfirm(false)}>
          <div
            className="request-changes-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="decline-confirm-title"
            onClick={e => e.stopPropagation()}
          >
            <h3 id="decline-confirm-title">Decline this request?</h3>
            <p style={{ margin: '0 0 12px', color: '#666', fontSize: '0.9em' }}>
              The submitter will be notified.
            </p>
            <div className="request-changes-actions">
              <button ref={declineCancelRef} className="btn btn-neutral" onClick={() => setShowDeclineConfirm(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={handleConfirmDecline}>
                Decline
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          className={`review-decision-toast${toast.error ? ' review-decision-toast--error' : ''}`}
          role="status"
          aria-live="polite"
        >
          <span>{toast.message}</span>
          <button
            type="button"
            className="review-decision-toast__close"
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            title="Dismiss"
          >
            <i className="fas fa-times" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
};
