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
        comments: (data.comments || []).map((comment: any) => ({
          id: comment.id,
          content: comment.content,
          authorId: comment.authorId,
          createdAt: new Date(comment.createdAt),
          type: comment.isSuggestion ? 'SUGGESTION' : 'COMMENT',
          resolved: comment.resolved || false
        })),
        approvals: (data.approvals || []).map((approval: any) => ({
          id: approval.id,
          approverId: approval.approverId,
          status: approval.status.toUpperCase(),
          comment: approval.comment,
          timestamp: new Date(approval.createdAt)
        })),
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
      const body: Record<string, unknown> = { id: backendSubmission.id };
      for (const key of Object.keys(backendSubmission) as Array<keyof typeof backendSubmission>) {
        if (key !== 'id' && changed(key as keyof ContentSubmission)) body[key] = backendSubmission[key];
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
      const newComment: Comment = {
        id: saved?.id || comment.id,
        content: saved?.content ?? comment.content,
        authorId: saved?.authorId || comment.authorId,
        createdAt: saved?.createdAt ? new Date(saved.createdAt) : new Date(comment.createdAt),
        type: saved ? (saved.isSuggestion ? 'SUGGESTION' : 'COMMENT') : comment.type,
        resolved: saved?.resolved || false,
      };
      setSubmission(prev => {
        if (!prev || prev.comments.some(c => c.id === newComment.id)) return prev;
        return { ...prev, comments: [...prev.comments, newComment] };
      });
    } catch (err) {
      console.error('Error adding comment:', err);
    }
  };

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
          comments: (data.comments || []).map((comment: any) => ({
            id: comment.id,
            content: comment.content,
            authorId: comment.authorId,
            createdAt: new Date(comment.createdAt),
            type: comment.isSuggestion ? 'SUGGESTION' : 'COMMENT',
            resolved: comment.resolved || false
          })),
          approvals: (data.approvals || []).map((approval: any) => ({
            id: approval.id,
            approverId: approval.approverId,
            status: approval.status.toUpperCase(),
            comment: approval.comment,
            timestamp: new Date(approval.createdAt)
          })),
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

  const handleSubmissionApprove = async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) return;
    await fetch(`${API_URL}/content/submissions/${submission.id}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionId}`,
      },
      body: JSON.stringify({ status: 'approved' })
    });
    await fetchSubmission();
  };

  const handleSubmissionReject = async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) return;
    await fetch(`${API_URL}/content/submissions/${submission.id}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionId}`,
      },
      body: JSON.stringify({ status: 'rejected' })
    });
    await fetchSubmission();
  };

  const handleRequestChanges = async (comment: string) => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) return;
    try {
      await fetch(`${API_URL}/content/submissions/${submission.id}/request-changes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ comment })
      });
      await fetchSubmission();
    } catch (err) {
      console.error('Error requesting changes:', err);
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

interface ReviewLayoutProps {
  submission: ContentSubmission;
  currentUser: User;
  canApprove: boolean;
  isReviewer: boolean;
  isUrgent: boolean;
  onBack: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRequestChanges: (comment: string) => void;
  onNavigate: (submissionId: string) => void;
  children: React.ReactNode;
}

const ReviewLayout: React.FC<ReviewLayoutProps> = ({
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
  const [showRequestChanges, setShowRequestChanges] = useState(false);
  const [requestChangesComment, setRequestChangesComment] = useState('');
  const requestChangesInputRef = useRef<HTMLTextAreaElement>(null);

  // Focus the comment box when the dialog opens. autoFocus alone loses: the dialog opens
  // from the Finish review menu, which returns focus to its button as it closes (in an
  // effect inside ReviewTopBar, which runs before this one).
  useEffect(() => {
    if (showRequestChanges) requestChangesInputRef.current?.focus();
  }, [showRequestChanges]);

  const handleSubmitRequestChanges = () => {
    if (!requestChangesComment.trim()) return;
    onRequestChanges(requestChangesComment.trim());
    setRequestChangesComment('');
    setShowRequestChanges(false);
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
        canApprove={canApprove}
        isReviewer={isReviewer}
        onBack={onBack}
        onApprove={onApprove}
        onRequestChanges={() => setShowRequestChanges(true)}
        onReject={onReject}
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
    </div>
  );
}; 