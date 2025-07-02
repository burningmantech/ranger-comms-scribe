import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ContentSubmission, User, Comment, Change, Approval } from '../types/content';
import { smartDiff, WordDiff, applyChanges } from '../utils/diffAlgorithm';
import './TrackedChangesEditor.css';

interface TrackedChangesEditorProps {
  submission: ContentSubmission;
  currentUser: User;
  onSave: (submission: ContentSubmission) => void;
  onComment: (comment: Comment) => void;
  onApprove: (changeId: string) => void;
  onReject: (changeId: string) => void;
  onSuggestion: (suggestion: Change) => void;
}

interface TrackedChange extends Change {
  status: 'pending' | 'approved' | 'rejected';
  approvedBy?: string;
  rejectedBy?: string;
  comments: Comment[];
}

interface TextSegment {
  id: string;
  text: string;
  type: 'original' | 'addition' | 'deletion' | 'unchanged';
  changeId?: string;
  author?: string;
  timestamp?: Date;
  status?: 'pending' | 'approved' | 'rejected';
}

export const TrackedChangesEditor: React.FC<TrackedChangesEditorProps> = ({
  submission,
  currentUser,
  onSave,
  onComment,
  onApprove,
  onReject,
  onSuggestion,
}) => {
  // Debug: Log the submission content
  console.log('TrackedChangesEditor received submission:', {
    id: submission.id,
    title: submission.title,
    content: submission.content,
    contentLength: submission.content?.length,
    contentPreview: submission.content?.substring(0, 100)
  });
  const [showOriginal, setShowOriginal] = useState(false);
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [showCommentDialog, setShowCommentDialog] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [suggestionText, setSuggestionText] = useState('');
  const [showSuggestionDialog, setShowSuggestionDialog] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editedContent, setEditedContent] = useState(submission.content);
  const editorRef = useRef<HTMLDivElement>(null);

  // Convert changes to tracked changes with status
  const trackedChanges: TrackedChange[] = useMemo(() => {
    return submission.changes.map(change => ({
      ...change,
      status: submission.approvals.find((a: Approval) => a.id === change.id)?.status === 'APPROVED' 
        ? 'approved' 
        : submission.approvals.find((a: Approval) => a.id === change.id)?.status === 'REJECTED'
        ? 'rejected'
        : 'pending',
      approvedBy: submission.approvals.find((a: Approval) => a.id === change.id && a.status === 'APPROVED')?.approverId,
      rejectedBy: submission.approvals.find((a: Approval) => a.id === change.id && a.status === 'REJECTED')?.approverId,
      comments: submission.comments.filter((c: Comment) => c.content.includes(`@change:${change.id}`))
    }));
  }, [submission.changes, submission.approvals, submission.comments]);

  // Check if user can make editorial decisions
  const canMakeEditorialDecisions = useCallback(() => {
    return currentUser.roles.includes('CommsCadre') ||
           currentUser.roles.includes('CouncilManager') ||
           currentUser.roles.includes('REVIEWER') ||
           currentUser.id === submission.submittedBy;
  }, [currentUser, submission.submittedBy]);

  // Get the current version of the text with approved changes applied
  const currentContent = useMemo(() => {
    const approvedChanges = trackedChanges
      .filter(change => change.status === 'approved' && change.field === 'content')
      .map(change => ({
        oldValue: change.oldValue,
        newValue: change.newValue,
        timestamp: change.timestamp
      }));
    
    return applyChanges(submission.content, approvedChanges);
  }, [submission.content, trackedChanges]);

  // Process text to show tracked changes using diff algorithm
  const processedSegments: TextSegment[] = useMemo(() => {
    if (showOriginal) {
      return [{
        id: 'original',
        text: submission.content,
        type: 'unchanged'
      }];
    }

    const segments: TextSegment[] = [];
    let segmentId = 0;

    // Get all changes that affect content
    const contentChanges = trackedChanges.filter(change => change.field === 'content');
    
    if (contentChanges.length === 0) {
      return [{
        id: 'original',
        text: currentContent,
        type: 'unchanged'
      }];
    }

    // For each change, create diff segments
    let workingText = submission.content;
    
    contentChanges.forEach(change => {
      const diff = smartDiff(change.oldValue, change.newValue);
      
      // Find where this change occurs in the working text
      const changeIndex = workingText.indexOf(change.oldValue);
      
      if (changeIndex !== -1) {
        // Add text before the change
        if (changeIndex > 0) {
          segments.push({
            id: `unchanged-${segmentId++}`,
            text: workingText.substring(0, changeIndex),
            type: 'unchanged'
          });
        }
        
        // Add the diff segments
        diff.forEach((segment: WordDiff) => {
          if (segment.type === 'equal') {
            segments.push({
              id: `equal-${segmentId++}`,
              text: segment.value,
              type: 'unchanged'
            });
          } else if (segment.type === 'delete') {
            segments.push({
              id: `del-${change.id}-${segmentId++}`,
              text: segment.value,
              type: 'deletion',
              changeId: change.id,
              author: change.changedBy,
              timestamp: change.timestamp,
              status: change.status
            });
          } else if (segment.type === 'insert') {
            segments.push({
              id: `add-${change.id}-${segmentId++}`,
              text: segment.value,
              type: 'addition',
              changeId: change.id,
              author: change.changedBy,
              timestamp: change.timestamp,
              status: change.status
            });
          }
        });
        
        // Update working text for next iteration
        workingText = workingText.substring(0, changeIndex) + 
                     change.newValue + 
                     workingText.substring(changeIndex + change.oldValue.length);
      }
    });

    // Add any remaining text
    if (workingText.length > 0) {
      const remainingStart = segments.reduce((acc, seg) => acc + seg.text.length, 0);
      if (remainingStart < workingText.length) {
        segments.push({
          id: `remaining-${segmentId++}`,
          text: workingText.substring(remainingStart),
          type: 'unchanged'
        });
      }
    }

    return segments;
  }, [submission.content, trackedChanges, showOriginal, currentContent]);

  // Handle text selection for suggestions
  const handleTextSelection = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim() && !editMode) {
      setSelectedText(selection.toString());
      setShowSuggestionDialog(true);
    }
  }, [editMode]);

  // Handle suggestion submission
  const handleSuggestionSubmit = useCallback(() => {
    if (selectedText && suggestionText) {
      const newChange: Change = {
        id: crypto.randomUUID(),
        field: 'content',
        oldValue: selectedText,
        newValue: suggestionText,
        changedBy: currentUser.id,
        timestamp: new Date()
      };
      onSuggestion(newChange);
      setShowSuggestionDialog(false);
      setSuggestionText('');
      setSelectedText('');
    }
  }, [selectedText, suggestionText, currentUser.id, onSuggestion]);

  // Handle direct edit submission
  const handleEditSubmit = useCallback(() => {
    if (editedContent !== currentContent) {
      const newChange: Change = {
        id: crypto.randomUUID(),
        field: 'content',
        oldValue: currentContent,
        newValue: editedContent,
        changedBy: currentUser.id,
        timestamp: new Date()
      };
      onSuggestion(newChange);
      setEditMode(false);
    }
  }, [editedContent, currentContent, currentUser.id, onSuggestion]);

  // Handle change approval/rejection
  const handleChangeDecision = useCallback((changeId: string, decision: 'approve' | 'reject') => {
    if (canMakeEditorialDecisions()) {
      if (decision === 'approve') {
        onApprove(changeId);
      } else {
        onReject(changeId);
      }
    }
  }, [canMakeEditorialDecisions, onApprove, onReject]);

  // Handle comment on change
  const handleCommentSubmit = useCallback(() => {
    if (selectedChange && commentText) {
      const comment: Comment = {
        id: crypto.randomUUID(),
        content: `@change:${selectedChange} ${commentText}`,
        authorId: currentUser.id,
        createdAt: new Date(),
        type: 'COMMENT',
        resolved: false
      };
      onComment(comment);
      setCommentText('');
      setShowCommentDialog(false);
    }
  }, [selectedChange, commentText, currentUser.id, onComment]);

  return (
    <div className="tracked-changes-editor">
      <div className="editor-toolbar">
        <div className="toolbar-left">
          <button
            className={`toolbar-button ${showOriginal ? 'active' : ''}`}
            onClick={() => setShowOriginal(!showOriginal)}
          >
            {showOriginal ? 'Show Changes' : 'Show Original'}
          </button>
          <div className="toolbar-separator" />
          <button
            className={`toolbar-button ${editMode ? 'active' : ''}`}
            onClick={() => setEditMode(!editMode)}
            disabled={showOriginal}
          >
            {editMode ? 'Preview' : 'Edit'}
          </button>
          <div className="toolbar-separator" />
          <span className="toolbar-label">Viewing mode:</span>
          <span className="toolbar-value">
            {showOriginal ? 'Original' : editMode ? 'Edit mode' : 'With tracked changes'}
          </span>
        </div>
        <div className="toolbar-right">
          <div className="change-stats">
            <span className="stat pending">
              {trackedChanges.filter(c => c.status === 'pending').length} pending
            </span>
            <span className="stat approved">
              {trackedChanges.filter(c => c.status === 'approved').length} approved
            </span>
            <span className="stat rejected">
              {trackedChanges.filter(c => c.status === 'rejected').length} rejected
            </span>
          </div>
        </div>
      </div>

      <div className="editor-container">
        <div className="editor-content" ref={editorRef}>
          <h1 className="document-title">{submission.title}</h1>
          <div className="document-meta">
            <span>Submitted by {submission.submittedBy}</span>
            <span className="separator">•</span>
            <span>{new Date(submission.submittedAt).toLocaleDateString()}</span>
          </div>
          
          {editMode ? (
            <div className="edit-mode-container">
              <textarea
                className="edit-textarea"
                value={editedContent}
                onChange={(e) => setEditedContent(e.target.value)}
                placeholder="Enter your content..."
              />
              <div className="edit-actions">
                <button onClick={handleEditSubmit} className="primary">
                  Submit Changes
                </button>
                <button onClick={() => {
                  setEditMode(false);
                  setEditedContent(currentContent);
                }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div 
              className="document-body"
              onMouseUp={handleTextSelection}
            >
              {processedSegments.map(segment => (
                <span
                  key={segment.id}
                  className={`text-segment ${segment.type} ${segment.status || ''}`}
                  onClick={() => segment.changeId && setSelectedChange(segment.changeId)}
                  title={segment.author ? `Changed by ${segment.author}` : ''}
                >
                  {segment.text}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="editor-sidebar">
          <h3>Changes & Comments</h3>
          <div className="changes-list">
            {trackedChanges.map(change => (
              <div 
                key={change.id} 
                className={`change-item ${change.status} ${selectedChange === change.id ? 'selected' : ''}`}
                onClick={() => setSelectedChange(change.id)}
              >
                <div className="change-header">
                  <span className="change-author">{change.changedBy}</span>
                  <span className="change-time">
                    {new Date(change.timestamp).toLocaleString()}
                  </span>
                </div>
                <div className="change-content">
                  <div className="change-diff">
                    {change.oldValue && (
                      <span className="diff-old">{change.oldValue.substring(0, 50)}...</span>
                    )}
                    {change.newValue && (
                      <span className="diff-new">{change.newValue.substring(0, 50)}...</span>
                    )}
                  </div>
                </div>
                {canMakeEditorialDecisions() && change.status === 'pending' && (
                  <div className="change-actions">
                    <button
                      className="action-button approve"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleChangeDecision(change.id, 'approve');
                      }}
                    >
                      ✓ Approve
                    </button>
                    <button
                      className="action-button reject"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleChangeDecision(change.id, 'reject');
                      }}
                    >
                      ✗ Reject
                    </button>
                    <button
                      className="action-button comment"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedChange(change.id);
                        setShowCommentDialog(true);
                      }}
                    >
                      💬 Comment
                    </button>
                  </div>
                )}
                {change.status !== 'pending' && (
                  <div className="change-status">
                    {change.status === 'approved' && (
                      <span className="status-label approved">
                        ✓ Approved by {change.approvedBy}
                      </span>
                    )}
                    {change.status === 'rejected' && (
                      <span className="status-label rejected">
                        ✗ Rejected by {change.rejectedBy}
                      </span>
                    )}
                  </div>
                )}
                {change.comments.length > 0 && (
                  <div className="change-comments">
                    {change.comments.map(comment => (
                      <div key={comment.id} className="comment-item">
                        <span className="comment-author">{comment.authorId}</span>
                        <span className="comment-text">
                          {comment.content.replace(`@change:${change.id}`, '').trim()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Comment Dialog */}
      {showCommentDialog && (
        <div className="dialog-overlay" onClick={() => setShowCommentDialog(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h3>Add Comment</h3>
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Enter your comment..."
              autoFocus
            />
            <div className="dialog-actions">
              <button onClick={() => setShowCommentDialog(false)}>Cancel</button>
              <button onClick={handleCommentSubmit} className="primary">
                Add Comment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Suggestion Dialog */}
      {showSuggestionDialog && (
        <div className="dialog-overlay" onClick={() => setShowSuggestionDialog(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h3>Suggest Edit</h3>
            <div className="suggestion-preview">
              <label>Selected text:</label>
              <div className="selected-text">{selectedText}</div>
            </div>
            <textarea
              value={suggestionText}
              onChange={(e) => setSuggestionText(e.target.value)}
              placeholder="Enter your suggested replacement..."
              autoFocus
            />
            <div className="dialog-actions">
              <button onClick={() => setShowSuggestionDialog(false)}>Cancel</button>
              <button onClick={handleSuggestionSubmit} className="primary">
                Suggest Edit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};