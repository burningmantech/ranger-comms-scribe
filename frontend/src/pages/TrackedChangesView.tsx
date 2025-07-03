import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { TrackedChangesEditor } from '../components/TrackedChangesEditor';
import { ContentSubmission, User, Comment, Change, Approval } from '../types/content';
import { useContent } from '../contexts/ContentContext';
import { API_URL } from '../config';
import { extractTextFromLexical, isLexicalJson } from '../utils/lexicalUtils';

export const TrackedChangesView: React.FC = () => {
  const { submissionId } = useParams<{ submissionId: string }>();
  const navigate = useNavigate();
  const { currentUser } = useContent();
  const [submission, setSubmission] = useState<ContentSubmission | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
        
        console.log('Raw data from API:', {
          id: data.id,
          title: data.title,
          content: data.content,
          richTextContent: data.richTextContent,
          richTextContentType: typeof data.richTextContent,
          richTextContentLength: data.richTextContent?.length
        });
        
        console.log('Tracked changes from API:', trackedChanges);
        
        // Determine the content to use for the tracked changes editor
        let content = data.content || '';
        console.log('Initial content:', content);
        console.log('Content type:', typeof content);
        
        // Handle different content formats
        let richTextContent = data.richTextContent;
        
        if (content) {
          // If content is an object, it might be Lexical JSON
          if (typeof content === 'object') {
            console.log('Content is an object, checking if it\'s Lexical JSON...');
            if (isLexicalJson(content)) {
              // Preserve the Lexical JSON for rich text display
              richTextContent = content;
              const extractedText = extractTextFromLexical(content);
              if (extractedText) {
                content = extractedText;
                console.log('Using extracted text from object content for plain text fallback:', content);
              }
            }
          }
          // If content is a string that looks like JSON
          else if (typeof content === 'string' && content.trim().startsWith('{') && isLexicalJson(content)) {
            console.log('Content field contains Lexical JSON string, preserving for rich text...');
            // Preserve the Lexical JSON for rich text display
            richTextContent = content;
            const extractedText = extractTextFromLexical(content);
            if (extractedText) {
              content = extractedText;
              console.log('Using extracted text from content field for plain text fallback:', content);
            }
          }
        }
        
        // If we still don't have readable content, try richTextContent
        if (!content || content.trim() === '') {
          if (data.richTextContent) {
            console.log('Checking if richTextContent is Lexical JSON...');
            const isLexical = isLexicalJson(data.richTextContent);
            console.log('Is Lexical JSON:', isLexical);
            
            if (isLexical) {
              // If richTextContent is Lexical JSON, extract plain text from it
              const extractedText = extractTextFromLexical(data.richTextContent);
              console.log('Extracted text from richTextContent:', extractedText);
              if (extractedText) {
                content = extractedText;
                console.log('Using extracted text as content:', content);
              }
            } else {
              console.log('richTextContent is not Lexical JSON');
            }
          } else {
            console.log('No richTextContent found');
          }
        }
        
        // Final fallback
        if (!content || content.trim() === '') {
          content = 'No content available';
          console.log('No content found, using fallback');
        }
        
        // Transform tracked changes to the format expected by the frontend
        const transformedChanges = trackedChanges.changes.map((change: any) => ({
          id: change.id,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          changedBy: change.changedBy,
          timestamp: new Date(change.timestamp),
          status: change.status || 'pending',
          approvedBy: change.approvedBy,
          rejectedBy: change.rejectedBy,
          approvedAt: change.approvedAt,
          rejectedAt: change.rejectedAt,
          isIncremental: change.isIncremental || false,
          previousVersionId: change.previousVersionId,
          completeProposedVersion: change.completeProposedVersion
        }));
        
        // Transform backend data to frontend format
        const transformedSubmission: ContentSubmission = {
          id: data.id,
          title: data.title,
          content: content,
          richTextContent: richTextContent,
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
          requiredApprovers: [],
          commsApprovedBy: data.commsApprovedBy,
          sentBy: data.sentBy,
          sentAt: data.sentAt ? new Date(data.sentAt) : undefined,
          // Add proposed versions with rich text support
          proposedVersions: {
            ...trackedChanges.proposedVersions,
            // If we have rich text proposed versions, use them
            ...(trackedChanges.proposedVersionsRichText && {
              richTextContent: trackedChanges.proposedVersionsRichText.content
            })
          }
        };
        console.log('Final transformed submission:', {
          id: transformedSubmission.id,
          title: transformedSubmission.title,
          content: transformedSubmission.content,
          contentLength: transformedSubmission.content?.length,
          contentPreview: transformedSubmission.content?.substring(0, 100),
          richTextContent: transformedSubmission.richTextContent ? 'present' : 'undefined',
          richTextContentLength: transformedSubmission.richTextContent?.length,
          changesCount: transformedSubmission.changes.length
        });
        setSubmission(transformedSubmission);
      } catch (err) {
        console.error('Error fetching submission:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch submission');
      } finally {
        setLoading(false);
      }
    };

    fetchSubmission();
  }, [submissionId]);

  const handleSave = async (updatedSubmission: ContentSubmission) => {
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) throw new Error('Not authenticated');

      // Transform frontend data to backend format
      const backendSubmission = {
        id: updatedSubmission.id,
        title: updatedSubmission.title,
        content: updatedSubmission.content, // This is now the plain text from tracked changes editor
        richTextContent: updatedSubmission.richTextContent, // Keep the original Lexical data
        status: updatedSubmission.status,
        submittedBy: updatedSubmission.submittedBy,
        submittedAt: updatedSubmission.submittedAt.toISOString(),
        formFields: updatedSubmission.formFields,
        comments: updatedSubmission.comments.map(comment => ({
          id: comment.id,
          content: comment.content,
          authorId: comment.authorId,
          createdAt: comment.createdAt.toISOString(),
          isSuggestion: comment.type === 'SUGGESTION',
          resolved: comment.resolved
        })),
        approvals: updatedSubmission.approvals.map(approval => ({
          id: approval.id,
          approverId: approval.approverId,
          status: approval.status.toLowerCase(),
          comment: approval.comment,
          createdAt: approval.timestamp.toISOString()
        })),
        changes: updatedSubmission.changes.map(change => ({
          id: change.id,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          changedBy: change.changedBy,
          changedAt: change.timestamp.toISOString()
        })),
        assignedCouncilManagers: updatedSubmission.assignedCouncilManagers,
        commsApprovedBy: updatedSubmission.commsApprovedBy,
        sentBy: updatedSubmission.sentBy,
        sentAt: updatedSubmission.sentAt?.toISOString()
      };

      const response = await fetch(`${API_URL}/content/submissions/${submissionId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify(backendSubmission),
      });

      if (!response.ok) {
        throw new Error(`Failed to save submission: ${response.status}`);
      }

      const savedSubmission = await response.json();
      setSubmission(savedSubmission);
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

      const data = await response.json();
      
      // Determine the content to use for the tracked changes editor
      let content = data.content || '';
      
      // Handle different content formats (same logic as above)
      if (content) {
        // If content is an object, it might be Lexical JSON
        if (typeof content === 'object') {
          if (isLexicalJson(content)) {
            const extractedText = extractTextFromLexical(content);
            if (extractedText) {
              content = extractedText;
              console.log('Using extracted text from object content (comment):', content);
            }
          }
        }
        // If content is a string that looks like JSON
        else if (typeof content === 'string' && content.trim().startsWith('{') && isLexicalJson(content)) {
          const extractedText = extractTextFromLexical(content);
          if (extractedText) {
            content = extractedText;
            console.log('Using extracted text from content field (comment):', content);
          }
        }
      }
      
      // If we still don't have readable content, try richTextContent
      if (!content || content.trim() === '') {
        if (data.richTextContent && isLexicalJson(data.richTextContent)) {
          const extractedText = extractTextFromLexical(data.richTextContent);
          if (extractedText) {
            content = extractedText;
            console.log('Using extracted text from richTextContent (comment):', content);
          }
        }
      }
      
      // Transform backend data to frontend format
      const transformedSubmission: ContentSubmission = {
        id: data.id,
        title: data.title,
        content: content,
        richTextContent: data.richTextContent,
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
        changes: (data.changes || []).map((change: any) => ({
          id: change.id,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          changedBy: change.changedBy,
          timestamp: new Date(change.changedAt)
        })),
        assignedReviewers: [],
        assignedCouncilManagers: data.assignedCouncilManagers || [],
        suggestedEdits: [],
        requiredApprovers: [],
        commsApprovedBy: data.commsApprovedBy,
        sentBy: data.sentBy,
        sentAt: data.sentAt ? new Date(data.sentAt) : undefined
      };
      setSubmission(transformedSubmission);
    } catch (err) {
      console.error('Error adding comment:', err);
    }
  };

  const handleApprove = async (changeId: string) => {
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/tracked-changes/change/${changeId}/status`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ status: 'approved' }),
      });

      if (!response.ok) {
        throw new Error(`Failed to approve change: ${response.status}`);
      }

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
        const transformedChanges = trackedChanges.changes.map((change: any) => ({
          id: change.id,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          changedBy: change.changedBy,
          timestamp: new Date(change.timestamp),
          status: change.status || 'pending',
          approvedBy: change.approvedBy,
          rejectedBy: change.rejectedBy,
          approvedAt: change.approvedAt,
          rejectedAt: change.rejectedAt,
          isIncremental: change.isIncremental || false,
          previousVersionId: change.previousVersionId,
          completeProposedVersion: change.completeProposedVersion
        }));
        
        // Transform backend data to frontend format
        const transformedSubmission: ContentSubmission = {
          id: data.id,
          title: data.title,
          content: data.content,
          richTextContent: data.richTextContent,
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
          requiredApprovers: [],
          commsApprovedBy: data.commsApprovedBy,
          sentBy: data.sentBy,
          sentAt: data.sentAt ? new Date(data.sentAt) : undefined,
          proposedVersions: trackedChanges.proposedVersions || {}
        };
        setSubmission(transformedSubmission);
      }
    } catch (err) {
      console.error('Error approving change:', err);
    }
  };

  const handleReject = async (changeId: string) => {
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/tracked-changes/change/${changeId}/status`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ status: 'rejected' }),
      });

      if (!response.ok) {
        throw new Error(`Failed to reject change: ${response.status}`);
      }

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
        const transformedChanges = trackedChanges.changes.map((change: any) => ({
          id: change.id,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          changedBy: change.changedBy,
          timestamp: new Date(change.timestamp),
          status: change.status || 'pending',
          approvedBy: change.approvedBy,
          rejectedBy: change.rejectedBy,
          approvedAt: change.approvedAt,
          rejectedAt: change.rejectedAt,
          isIncremental: change.isIncremental || false,
          previousVersionId: change.previousVersionId,
          completeProposedVersion: change.completeProposedVersion
        }));
        
        // Transform backend data to frontend format
        const transformedSubmission: ContentSubmission = {
          id: data.id,
          title: data.title,
          content: data.content,
          richTextContent: data.richTextContent,
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
            approverEmail: approval.approverEmail || approval.approverId, // Fallback for backward compatibility
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
          proposedVersions: trackedChanges.proposedVersions || {}
        };
        setSubmission(transformedSubmission);
      }
    } catch (err) {
      console.error('Error rejecting change:', err);
    }
  };

  const handleSuggestion = async (suggestion: Change) => {
    try {
      console.log('TrackedChangesView: handleSuggestion called with:', suggestion);
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) throw new Error('Not authenticated');

      console.log('TrackedChangesView: Making API call to create tracked change...');
      const response = await fetch(`${API_URL}/tracked-changes/submission/${submissionId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify(suggestion),
      });

      console.log('TrackedChangesView: API response status:', response.status);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('TrackedChangesView: API error response:', errorText);
        throw new Error(`Failed to create suggestion: ${response.status} - ${errorText}`);
      }

      const createdChange = await response.json();
      console.log('TrackedChangesView: Created change response:', createdChange);

      // Refresh both submission and tracked changes data
      console.log('TrackedChangesView: Refreshing data...');
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

      console.log('TrackedChangesView: Refresh response statuses:', {
        submission: submissionResponse.status,
        trackedChanges: trackedChangesResponse.status
      });

      if (submissionResponse.ok && trackedChangesResponse.ok) {
        const data = await submissionResponse.json();
        const trackedChanges = await trackedChangesResponse.json();
        
        console.log('TrackedChangesView: Refreshed data:', {
          submission: data,
          trackedChanges: trackedChanges
        });
        
        // Transform tracked changes to the format expected by the frontend
        const transformedChanges = trackedChanges.changes.map((change: any) => ({
          id: change.id,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          changedBy: change.changedBy,
          timestamp: new Date(change.timestamp),
          status: change.status || 'pending',
          approvedBy: change.approvedBy,
          rejectedBy: change.rejectedBy,
          approvedAt: change.approvedAt,
          rejectedAt: change.rejectedAt,
          isIncremental: change.isIncremental || false,
          previousVersionId: change.previousVersionId,
          completeProposedVersion: change.completeProposedVersion
        }));
        
        // Transform backend data to frontend format
        const transformedSubmission: ContentSubmission = {
          id: data.id,
          title: data.title,
          content: data.content,
          richTextContent: data.richTextContent,
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
          requiredApprovers: [],
          commsApprovedBy: data.commsApprovedBy,
          sentBy: data.sentBy,
          sentAt: data.sentAt ? new Date(data.sentAt) : undefined,
          proposedVersions: trackedChanges.proposedVersions || {}
        };
        console.log('TrackedChangesView: Setting transformed submission:', transformedSubmission);
        setSubmission(transformedSubmission);
      } else {
        console.error('TrackedChangesView: Failed to refresh data:', {
          submission: submissionResponse.status,
          trackedChanges: trackedChangesResponse.status
        });
      }
    } catch (err) {
      console.error('Error creating suggestion:', err);
    }
  };

  const handleUndo = async (changeId: string) => {
    try {
      console.log('TrackedChangesView: handleUndo called with changeId:', changeId);
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/tracked-changes/${changeId}/undo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to undo change: ${response.status} - ${errorText}`);
      }

      // Refresh the data after undo by refetching
      window.location.reload();
    } catch (err) {
      console.error('Error undoing change:', err);
    }
  };

  const handleApproveProposedVersion = async (approverId: string, comment?: string) => {
    try {
      console.log('TrackedChangesView: handleApproveProposedVersion called with:', { approverId, comment });
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/content/submissions/${submissionId}/approve-proposed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({
          approverId,
          comment
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to approve proposed version: ${response.status} - ${errorText}`);
      }

      // Refresh the data after approval by refetching
      window.location.reload();
    } catch (err) {
      console.error('Error approving proposed version:', err);
    }
  };

  const handleRejectProposedVersion = async (rejecterId: string, comment?: string) => {
    try {
      console.log('TrackedChangesView: handleRejectProposedVersion called with:', { rejecterId, comment });
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/content/submissions/${submissionId}/reject-proposed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({
          rejecterId,
          comment
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to reject proposed version: ${response.status} - ${errorText}`);
      }

      // Refresh the data after rejection by refetching
      window.location.reload();
    } catch (err) {
      console.error('Error rejecting proposed version:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-red-800 mb-2">Error</h3>
          <p className="text-red-700">{error}</p>
          <button
            onClick={() => navigate('/requests')}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
          >
            Back to Requests
          </button>
        </div>
      </div>
    );
  }

  if (!submission || !currentUser) {
    return (
      <div className="p-4">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-yellow-800 mb-2">Not Found</h3>
          <p className="text-yellow-700">Submission not found or you don't have access to it.</p>
          <button
            onClick={() => navigate('/requests')}
            className="mt-4 px-4 py-2 bg-yellow-600 text-white rounded hover:bg-yellow-700"
          >
            Back to Requests
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      <div className="bg-white border-b border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Tracked Changes Editor</h1>
            <p className="text-sm text-gray-600">{submission.title}</p>
          </div>
          <button
            onClick={() => navigate('/requests')}
            className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
          >
            ← Back to Requests
          </button>
        </div>
      </div>
      
      <div className="flex-1">
        <TrackedChangesEditor
          submission={submission}
          currentUser={currentUser}
          onSave={handleSave}
          onComment={handleComment}
          onApprove={handleApprove}
          onReject={handleReject}
          onSuggestion={handleSuggestion}
          onUndo={handleUndo}
          onApproveProposedVersion={handleApproveProposedVersion}
          onRejectProposedVersion={handleRejectProposedVersion}
        />
      </div>
    </div>
  );
}; 