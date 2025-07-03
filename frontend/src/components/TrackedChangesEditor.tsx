import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ContentSubmission, User, Comment, Change, Approval } from '../types/content';
import { smartDiff, WordDiff, applyChanges, calculateIncrementalChanges } from '../utils/diffAlgorithm';
import { extractTextFromLexical, isLexicalJson } from '../utils/lexicalUtils';
import LexicalEditorComponent from './editor/LexicalEditor';
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
    richTextContent: submission.richTextContent,
    richTextContentType: typeof submission.richTextContent,
    richTextContentLength: submission.richTextContent?.length,
    contentLength: submission.content?.length,
    contentPreview: submission.content?.substring(0, 100),
    isContentLexical: isLexicalJson(submission.content),
    isRichTextContentLexical: submission.richTextContent ? isLexicalJson(submission.richTextContent) : false,
    proposedVersions: submission.proposedVersions,
    proposedVersionsRichTextContent: submission.proposedVersions?.richTextContent
  });
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [showCommentDialog, setShowCommentDialog] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [suggestionText, setSuggestionText] = useState('');
  const [showSuggestionDialog, setShowSuggestionDialog] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [isEditingProposed, setIsEditingProposed] = useState(false);
  const [editedProposedContent, setEditedProposedContent] = useState('');

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

  // Helper function to get the correct rich text content for display/editing
  const getRichTextContent = useCallback((content: string): string => {
    console.log('getRichTextContent called with:', {
      content,
      contentType: typeof content,
      contentLength: content?.length,
      isLexical: isLexicalJson(content)
    });

    if (!content) {
      console.log('getRichTextContent: No content provided');
      return '';
    }
    
    // If it's already Lexical JSON, return as is
    if (isLexicalJson(content)) {
      console.log('getRichTextContent: Content is already Lexical JSON');
      return content;
    }
    
    // If it's plain text, create a basic Lexical structure
    if (typeof content === 'string' && content.trim()) {
      console.log('getRichTextContent: Creating Lexical structure for plain text');
      // Create a basic Lexical JSON structure for plain text
      const basicLexicalStructure = {
        root: {
          children: [
            {
              children: [
                {
                  detail: 0,
                  format: 0,
                  mode: "normal",
                  style: "",
                  text: content,
                  type: "text",
                  version: 1
                }
              ],
              direction: "ltr",
              format: "",
              indent: 0,
              type: "paragraph",
              version: 1
            }
          ],
          direction: "ltr",
          format: "",
          indent: 0,
          type: "root",
          version: 1
        }
      };
      const result = JSON.stringify(basicLexicalStructure);
      console.log('getRichTextContent: Created Lexical structure:', result.substring(0, 200) + '...');
      return result;
    }
    
    console.log('getRichTextContent: Returning empty string');
    return '';
  }, []);

  // Initialize edited proposed content when component mounts or submission changes
  useEffect(() => {
    // Prioritize rich text content from proposed versions, then fall back to other sources
    const content = submission.proposedVersions?.richTextContent || 
                   submission.proposedVersions?.content || 
                   submission.richTextContent || 
                   submission.content || '';
    setEditedProposedContent(getRichTextContent(content));
  }, [submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, submission.richTextContent, submission.content, getRichTextContent]);

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

  // Get current content (proposed version or original)
  const currentContent = useMemo(() => {
    return getDisplayableText(submission.proposedVersions?.content || submission.content);
  }, [submission.proposedVersions?.content, submission.content, getDisplayableText]);

  // Get the content to display in the proposed version section
  const proposedContentToDisplay = useMemo(() => {
    return isEditingProposed ? editedProposedContent : getDisplayableText(
      submission.proposedVersions?.richTextContent || 
      submission.proposedVersions?.content || 
      currentContent
    );
  }, [isEditingProposed, editedProposedContent, submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, currentContent, getDisplayableText]);

  // Memoize the rich text content for the proposed version editor
  const proposedEditorContent = useMemo(() => {
    const content = getRichTextContent(
      submission.proposedVersions?.richTextContent || 
      submission.proposedVersions?.content || 
      submission.richTextContent || 
      submission.content || 
      ''
    );
    console.log('proposedEditorContent memoized:', {
      contentLength: content?.length,
      isLexical: isLexicalJson(content),
      proposedVersionsRichTextContent: submission.proposedVersions?.richTextContent ? 'present' : 'not present'
    });
    return content;
  }, [submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, submission.richTextContent, submission.content, getRichTextContent]);

  // Memoize the rich text content for the proposed version display
  const proposedDisplayContent = useMemo(() => {
    return getRichTextContent(
      submission.proposedVersions?.richTextContent || 
      submission.proposedVersions?.content || 
      submission.richTextContent || 
      submission.content || 
      ''
    );
  }, [submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, submission.richTextContent, submission.content, getRichTextContent]);

  // Memoize the rich text content for the original version
  const originalDisplayContent = useMemo(() => {
    return getRichTextContent(
      submission.richTextContent || 
      submission.content || 
      ''
    );
  }, [submission.richTextContent, submission.content, getRichTextContent]);

  // Process text to show tracked changes using diff algorithm
  const processedSegments: TextSegment[] = useMemo(() => {
    const segments: TextSegment[] = [];
    let segmentId = 0;

    // Use the original and proposed version for diff
    // Extract plain text for diff comparison while preserving rich text structure
    const originalText = getDisplayableText(submission.content);
    const proposedText = getDisplayableText(
      submission.proposedVersions?.richTextContent || 
      submission.proposedVersions?.content || 
      submission.content
    );

    // Find the latest tracked change for status
    const latestChange = trackedChanges
      .filter(change => change.field === 'content')
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

    const status = latestChange?.status || 'pending';

    // Use smartDiff to get word-level changes
    const diff = smartDiff(originalText, proposedText);

    // Helper function to find the most recent change that affects this text
    const findMostRecentChangeForText = (text: string, type: 'addition' | 'deletion'): string | undefined => {
      const relevantChanges = trackedChanges
        .filter(change => change.field === 'content')
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      for (const change of relevantChanges) {
        // Compare plain text versions for matching
        const changeOldText = getDisplayableText(change.oldValue || '');
        const changeNewText = getDisplayableText(change.newValue || '');
        
        if (type === 'addition' && changeNewText && changeNewText.includes(text)) {
          return change.id;
        }
        if (type === 'deletion' && changeOldText && changeOldText.includes(text)) {
          return change.id;
        }
      }
      return undefined;
    };

    diff.forEach((segment: WordDiff) => {
      if (segment.type === 'equal') {
        segments.push({
          id: `equal-${segmentId++}`,
          text: segment.value,
          type: 'unchanged'
        });
      } else if (segment.type === 'delete') {
        const changeId = findMostRecentChangeForText(segment.value, 'deletion');
        segments.push({
          id: `del-${segmentId++}`,
          text: segment.value,
          type: 'deletion',
          status,
          changeId,
          author: changeId ? trackedChanges.find(c => c.id === changeId)?.changedBy : undefined,
          timestamp: changeId ? trackedChanges.find(c => c.id === changeId)?.timestamp : undefined
        });
      } else if (segment.type === 'insert') {
        const changeId = findMostRecentChangeForText(segment.value, 'addition');
        segments.push({
          id: `add-${segmentId++}`,
          text: segment.value,
          type: 'addition',
          status,
          changeId,
          author: changeId ? trackedChanges.find(c => c.id === changeId)?.changedBy : undefined,
          timestamp: changeId ? trackedChanges.find(c => c.id === changeId)?.timestamp : undefined
        });
      }
    });

    return segments;
  }, [submission.content, submission.proposedVersions?.content, trackedChanges, getDisplayableText]);

  // Handle clicking on a changed segment
  const handleSegmentClick = useCallback((segment: TextSegment) => {
    if (segment.changeId) {
      setSelectedChange(segment.changeId);
      // Scroll the sidebar to show the selected change
      const changeElement = document.querySelector(`[data-change-id="${segment.changeId}"]`);
      if (changeElement) {
        changeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, []);

  // Handle text selection for suggestions
  const handleTextSelection = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim() && !editMode && !isEditingProposed) {
      setSelectedText(selection.toString());
      setShowSuggestionDialog(true);
    }
  }, [editMode, isEditingProposed]);

  // Handle edit submission
  const handleEditSubmit = useCallback(() => {
    if (editedContent !== currentContent) {
      const suggestion: Change = {
        id: crypto.randomUUID(),
        field: 'content',
        oldValue: currentContent,
        newValue: editedContent,
        changedBy: currentUser.id,
        timestamp: new Date(),
        isIncremental: true
      };
      onSuggestion(suggestion);
    }
    setEditMode(false);
  }, [editedContent, currentContent, currentUser.id, onSuggestion]);

  // Handle proposed version edit submission
  const handleProposedEditSubmit = useCallback(() => {
    const currentProposedContent = submission.proposedVersions?.richTextContent || 
                                   submission.proposedVersions?.content || 
                                   submission.richTextContent || 
                                   submission.content || '';
    if (editedProposedContent !== currentProposedContent) {
      const suggestion: Change = {
        id: crypto.randomUUID(),
        field: 'content',
        oldValue: currentProposedContent,
        newValue: editedProposedContent,
        changedBy: currentUser.id,
        timestamp: new Date(),
        isIncremental: true
      };
      onSuggestion(suggestion);
    }
    setIsEditingProposed(false);
  }, [editedProposedContent, submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, submission.richTextContent, submission.content, currentUser.id, onSuggestion]);

  // Handle change decision (approve/reject)
  const handleChangeDecision = useCallback((changeId: string, decision: 'approve' | 'reject') => {
    if (decision === 'approve') {
      onApprove(changeId);
    } else {
      onReject(changeId);
    }
  }, [onApprove, onReject]);

  // Handle suggestion submission
  const handleSuggestionSubmit = useCallback(() => {
    if (selectedText && suggestionText) {
      const suggestion: Change = {
        id: crypto.randomUUID(),
        field: 'content',
        oldValue: selectedText,
        newValue: suggestionText,
        changedBy: currentUser.id,
        timestamp: new Date(),
        isIncremental: true
      };
      onSuggestion(suggestion);
      setSuggestionText('');
      setShowSuggestionDialog(false);
    }
  }, [selectedText, suggestionText, currentUser.id, onSuggestion]);

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
            className={`toolbar-button ${editMode ? 'active' : ''}`}
            onClick={() => setEditMode(!editMode)}
          >
            {editMode ? 'Preview' : 'Edit'}
          </button>
          <div className="toolbar-separator" />
          <span className="toolbar-label">Viewing mode:</span>
          <span className="toolbar-value">
            {editMode ? 'Edit mode' : 'Proposed version with tracked changes'}
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
            <div className="document-body">
              {/* Always show proposed version at the top */}
              <div className="proposed-version-section">
                <div className="section-header">
                  <h2 className="section-title">Proposed Version</h2>
                  <div className="section-actions">
                    {!isEditingProposed ? (
                      <button
                        className="edit-button"
                        onClick={() => setIsEditingProposed(true)}
                        title="Edit proposed version"
                      >
                        <i className="fas fa-edit"></i>
                        Edit
                      </button>
                    ) : (
                      <div className="edit-actions">
                        <button
                          className="save-button"
                          onClick={handleProposedEditSubmit}
                          title="Save changes"
                        >
                          <i className="fas fa-save"></i>
                          Save
                        </button>
                        <button
                          className="cancel-button"
                          onClick={() => {
                            setIsEditingProposed(false);
                            const content = submission.proposedVersions?.richTextContent || 
                                           submission.proposedVersions?.content || 
                                           submission.richTextContent || 
                                           submission.content || '';
                            setEditedProposedContent(getRichTextContent(content));
                          }}
                          title="Cancel editing"
                        >
                          <i className="fas fa-times"></i>
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <div className="proposed-content">
                  {isEditingProposed ? (
                    <div className="rich-text-editor-container">
                      <LexicalEditorComponent
                        key="proposed-edit-editor"
                        initialContent={proposedEditorContent}
                        onChange={(editor, json) => {
                          // Only update if the content has actually changed
                          if (json !== editedProposedContent) {
                            setEditedProposedContent(json);
                          }
                        }}
                        placeholder="Edit the proposed version..."
                        readOnly={false}
                        showToolbar={true}
                        className="proposed-edit-editor"
                      />
                    </div>
                  ) : (
                    <div className="rich-text-display">
                      <LexicalEditorComponent
                        key="proposed-display-editor"
                        initialContent={proposedDisplayContent}
                        readOnly={true}
                        showToolbar={false}
                        className="proposed-display-editor"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Always show diff with tracked changes below */}
              <div className="diff-section">
                <h2 className="section-title">Tracked Changes</h2>
                <div 
                  className="diff-content"
                  onMouseUp={handleTextSelection}
                >
                  {processedSegments.map(segment => (
                    <span
                      key={segment.id}
                      className={`text-segment ${segment.type} ${segment.status || ''}`}
                      onClick={() => handleSegmentClick(segment)}
                      title={segment.author ? `Changed by ${segment.author}` : ''}
                    >
                      {segment.text}
                    </span>
                  ))}
                </div>
              </div>

              {/* Always show original version at the bottom */}
              <div className="original-version-section">
                <h2 className="section-title">Original Version</h2>
                <div className="original-content">
                  <div className="rich-text-display">
                    <LexicalEditorComponent
                      key="original-display-editor"
                      initialContent={originalDisplayContent}
                      readOnly={true}
                      showToolbar={false}
                      className="original-display-editor"
                    />
                  </div>
                </div>
              </div>
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
                data-change-id={change.id}
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
                          <span className="incremental-badge" style={{
                            backgroundColor: '#e3f2fd',
                            color: '#1976d2',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            fontWeight: '500'
                          }}>
                            Incremental Change
                          </span>
                        </div>
                        {change.oldValue && (
                          <span className="diff-old" style={{fontSize: '13px', lineHeight: '1.4'}}>
                            <strong>Removed:</strong> {getDisplayableText(change.oldValue)}
                          </span>
                        )}
                        {change.newValue && (
                          <span className="diff-new" style={{fontSize: '13px', lineHeight: '1.4'}}>
                            <strong>Added:</strong> {getDisplayableText(change.newValue)}
                          </span>
                        )}

                      </>
                    ) : (
                      <>
                        {change.oldValue && (
                          <span className="diff-old" style={{fontSize: '13px', lineHeight: '1.4'}}>
                            <strong>Previous:</strong> {getDisplayableText(change.oldValue).substring(0, 100)}...
                          </span>
                        )}
                        {change.newValue && (
                          <span className="diff-new" style={{fontSize: '13px', lineHeight: '1.4'}}>
                            <strong>New:</strong> {getDisplayableText(change.newValue).substring(0, 100)}...
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