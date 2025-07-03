import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ContentSubmission, User, Comment, Change, Approval } from '../types/content';
import { smartDiff, WordDiff, applyChanges, calculateIncrementalChanges } from '../utils/diffAlgorithm';
import { extractTextFromLexical, isLexicalJson } from '../utils/lexicalUtils';
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
  const [showDiffOnRight, setShowDiffOnRight] = useState(true);

  // Helper to get the latest version for editing
  const getLatestEditableContent = useCallback(() => {
    return submission.proposedVersions?.content
      ?? (isLexicalJson(submission.content)
          ? extractTextFromLexical(submission.content)
          : submission.content);
  }, [submission]);

  // State for edit mode content
  const [editedContent, setEditedContent] = useState(() => getLatestEditableContent());

  // When toggling edit mode on, reset editedContent to latest version
  useEffect(() => {
    if (editMode) {
      setEditedContent(getLatestEditableContent());
    }
    // Only run when editMode toggles or submission changes
  }, [editMode, getLatestEditableContent]);

  const editorRef = useRef<HTMLDivElement>(null);

  // Helper function to get displayable text from content
  const getDisplayableText = useCallback((content: string): string => {
    if (!content) return '';
    
    // Check if content is Lexical JSON and extract text
    if (isLexicalJson(content)) {
      return extractTextFromLexical(content);
    }
    
    return content;
  }, []);

  // Convert changes to tracked changes with status
  const trackedChanges: TrackedChange[] = useMemo(() => {
    console.log('TrackedChangesEditor: Processing changes:', submission.changes);
    const result = submission.changes.map(change => ({
      ...change,
      status: (change as any).status || 'pending', // Use status from tracked changes data
      approvedBy: (change as any).approvedBy,
      rejectedBy: (change as any).rejectedBy,
      comments: submission.comments.filter((c: Comment) => c.content.includes(`@change:${change.id}`))
    }));
    console.log('TrackedChangesEditor: Processed tracked changes:', result);
    return result;
  }, [submission.changes, submission.comments]);

  // Check if user can make editorial decisions
  const canMakeEditorialDecisions = useCallback(() => {
    return currentUser.roles.includes('CommsCadre') ||
           currentUser.roles.includes('CouncilManager') ||
           currentUser.roles.includes('REVIEWER') ||
           currentUser.id === submission.submittedBy;
  }, [currentUser, submission.submittedBy]);

  // Get the current version of the text with approved changes applied
  const currentContent = useMemo(() => {
    // If we have a proposed version for content, use it
    if (submission.proposedVersions?.content) {
      return submission.proposedVersions.content;
    }
    
    const approvedChanges = trackedChanges
      .filter(change => change.status === 'approved' && change.field === 'content')
      .map(change => ({
        oldValue: change.oldValue,
        newValue: change.newValue,
        timestamp: change.timestamp
      }));
    
    // Extract text from submission content if it's Lexical JSON
    const baseContent = isLexicalJson(submission.content) 
      ? extractTextFromLexical(submission.content) 
      : submission.content;
    
    return applyChanges(baseContent, approvedChanges);
  }, [submission.content, submission.proposedVersions, trackedChanges]);

  // Process text to show tracked changes using diff algorithm
  const processedSegments: TextSegment[] = useMemo(() => {
    if (showOriginal) {
      return [{
        id: 'original',
        text: getDisplayableText(submission.content),
        type: 'unchanged'
      }];
    }

    const segments: TextSegment[] = [];
    let segmentId = 0;

    // Use the original and proposed version for diff
    const originalText = getDisplayableText(submission.content);
    const proposedText = submission.proposedVersions?.content || currentContent;

    // Find the latest tracked change for status
    const latestChange = trackedChanges
      .filter(change => change.field === 'content')
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

    const status = latestChange?.status || 'pending';

    // Use smartDiff to get word-level changes
    const diff = smartDiff(originalText, proposedText);

    diff.forEach((segment: WordDiff) => {
      if (segment.type === 'equal') {
        segments.push({
          id: `equal-${segmentId++}`,
          text: segment.value,
          type: 'unchanged'
        });
      } else if (segment.type === 'delete') {
        segments.push({
          id: `del-${segmentId++}`,
          text: segment.value,
          type: 'deletion',
          status
        });
      } else if (segment.type === 'insert') {
        segments.push({
          id: `add-${segmentId++}`,
          text: segment.value,
          type: 'addition',
          status
        });
      }
    });

    return segments;
  }, [showOriginal, submission.content, submission.proposedVersions, currentContent, trackedChanges]);

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
      console.log('TrackedChangesEditor: Submitting suggestion:', { selectedText, suggestionText });
      const newChange: Change = {
        id: crypto.randomUUID(),
        field: 'content',
        oldValue: selectedText,
        newValue: suggestionText,
        changedBy: currentUser.id,
        timestamp: new Date()
      };
      console.log('TrackedChangesEditor: Created change object:', newChange);
      onSuggestion(newChange);
      setShowSuggestionDialog(false);
      setSuggestionText('');
      setSelectedText('');
    }
  }, [selectedText, suggestionText, currentUser.id, onSuggestion]);

  // Handle direct edit submission
  const handleEditSubmit = useCallback(() => {
    if (editedContent !== currentContent) {
      console.log('TrackedChangesEditor: Submitting edit:', { 
        oldContent: currentContent, 
        newContent: editedContent 
      });
      const newChange: Change = {
        id: crypto.randomUUID(),
        field: 'content',
        oldValue: currentContent,
        newValue: editedContent,
        changedBy: currentUser.id,
        timestamp: new Date()
      };
      console.log('TrackedChangesEditor: Created edit change object:', newChange);
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
          <button
            className={`toolbar-button ${showDiffOnRight ? 'active' : ''}`}
            onClick={() => setShowDiffOnRight(!showDiffOnRight)}
            disabled={showOriginal || editMode}
          >
            {showDiffOnRight ? 'Show Full' : 'Show Diff'}
          </button>
          <div className="toolbar-separator" />
          <span className="toolbar-label">Viewing mode:</span>
          <span className="toolbar-value">
            {showOriginal ? 'Original' : editMode ? 'Edit mode' : showDiffOnRight ? 'With tracked changes' : 'Full proposed version'}
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
              {showDiffOnRight ? (
                // Show diff with tracked changes
                processedSegments.map(segment => (
                  <span
                    key={segment.id}
                    className={`text-segment ${segment.type} ${segment.status || ''}`}
                    onClick={() => segment.changeId && setSelectedChange(segment.changeId)}
                    title={segment.author ? `Changed by ${segment.author}` : ''}
                  >
                    {segment.text}
                  </span>
                ))
              ) : (
                // Show full proposed version
                <span className="text-segment unchanged">
                  {getDisplayableText(submission.proposedVersions?.content || currentContent)}
                </span>
              )}
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
                    {change.isIncremental ? (
                      <>
                        <div className="change-type-indicator">
                          <span className="incremental-badge">Incremental Change</span>
                        </div>
                        {change.oldValue && (
                          <span className="diff-old">
                            {getDisplayableText(change.oldValue).substring(0, 50)}...
                          </span>
                        )}
                        {change.newValue && (
                          <span className="diff-new">
                            {getDisplayableText(change.newValue).substring(0, 50)}...
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        {change.oldValue && (
                          <span className="diff-old">
                            {getDisplayableText(change.oldValue).substring(0, 50)}...
                          </span>
                        )}
                        {change.newValue && (
                          <span className="diff-new">
                            {getDisplayableText(change.newValue).substring(0, 50)}...
                          </span>
                        )}
                      </>
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