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
  onUndo: (changeId: string) => void;
  onApproveProposedVersion: (approverId: string, comment?: string) => void;
  onRejectProposedVersion: (rejecterId: string, comment?: string) => void;
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
  showControls?: boolean;
}

interface CommentWithReplies extends Comment {
  replies: CommentWithReplies[];
}

export const TrackedChangesEditor: React.FC<TrackedChangesEditorProps> = ({
  submission,
  currentUser,
  onSave,
  onComment,
  onApprove,
  onReject,
  onSuggestion,
  onUndo,
  onApproveProposedVersion,
  onRejectProposedVersion,
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
  const editedProposedContentRef = useRef(editedProposedContent);
  const initialEditorContentRef = useRef<string>('');
  const [lastSavedProposedContent, setLastSavedProposedContent] = useState<string>('');
  const [showProposedVersionApprovalDialog, setShowProposedVersionApprovalDialog] = useState(false);
  const [proposedVersionApprovalComment, setProposedVersionApprovalComment] = useState('');
  const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set());
  const [replyToComment, setReplyToComment] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');

  // Update ref when content changes
  useEffect(() => {
    editedProposedContentRef.current = editedProposedContent;
  }, [editedProposedContent]);

  // Stable onChange handler for the editor
  const handleEditorChange = useCallback((editor: any, json: string) => {
    // Only update if the content has actually changed
    if (json !== editedProposedContentRef.current) {
      setEditedProposedContent(json);
    }
  }, []);

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

  // Helper function to get displayable text from change values (with debugging)
  const getChangeDisplayText = useCallback((content: string): string => {
    console.log('getChangeDisplayText called with:', {
      content,
      contentType: typeof content,
      contentLength: content?.length,
      contentPreview: content?.substring(0, 100),
      isLexical: isLexicalJson(content)
    });
    
    if (!content) return '';
    
    // Check if content is Lexical JSON and extract text
    if (isLexicalJson(content)) {
      const extracted = extractTextFromLexical(content);
      console.log('getChangeDisplayText: Extracted from Lexical JSON:', extracted);
      return extracted;
    }
    
    // Handle partial JSON fragments (like the ones you're seeing)
    if (typeof content === 'string' && content.includes('"text":"')) {
      console.log('getChangeDisplayText: Detected partial JSON with text field');
      
      // Extract text values from JSON fragments using regex
      const textMatches = content.match(/"text":"([^"]*)"/g);
      if (textMatches && textMatches.length > 0) {
        const extractedTexts = textMatches.map(match => {
          // Remove the "text":" and " parts
          return match.replace(/"text":"/, '').replace(/"$/, '');
        }).filter(text => text.trim() !== '');
        
        if (extractedTexts.length > 0) {
          const result = extractedTexts.join(' ');
          console.log('getChangeDisplayText: Extracted text from JSON fragments:', result);
          return result;
        }
      }
    }
    
    // If it's a string that looks like JSON but isn't Lexical, try to parse it
    if (typeof content === 'string' && content.trim().startsWith('{') && content.trim().endsWith('}')) {
      try {
        const parsed = JSON.parse(content);
        // If it's an object with text-like properties, try to extract text
        if (typeof parsed === 'object' && parsed !== null) {
          if (parsed.text) {
            console.log('getChangeDisplayText: Found text property in JSON:', parsed.text);
            return parsed.text;
          }
          if (parsed.content) {
            console.log('getChangeDisplayText: Found content property in JSON:', parsed.content);
            return parsed.content;
          }
          // If it's a complex object, stringify it for display
          const stringified = JSON.stringify(parsed, null, 2);
          console.log('getChangeDisplayText: Stringified complex JSON:', stringified.substring(0, 100));
          return stringified.substring(0, 200) + (stringified.length > 200 ? '...' : '');
        }
      } catch (e) {
        console.log('getChangeDisplayText: Failed to parse as JSON, treating as plain text');
      }
    }
    
    console.log('getChangeDisplayText: Returning as plain text:', content);
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
    // Skip if the content looks like a comment (contains @change:)
    let content = submission.proposedVersions?.richTextContent || 
                   submission.proposedVersions?.content || 
                   submission.richTextContent || 
                   submission.content || '';
    
    // If content looks like a comment, skip it and use empty content
    if (typeof content === 'string' && content.includes('@change:')) {
      console.log('TrackedChangesEditor: Skipping comment content for editor initialization');
      content = '';
    }
    
    const richTextContent = getRichTextContent(content);
    setEditedProposedContent(richTextContent);
    
    // Update last saved content when submission changes (from parent)
    // Only update if we don't have local changes or if the submission has actually changed
    if (!lastSavedProposedContent || lastSavedProposedContent !== richTextContent) {
      setLastSavedProposedContent(richTextContent);
    }
    
    // Store the initial content for the editor (only set once)
    if (!initialEditorContentRef.current) {
      initialEditorContentRef.current = richTextContent;
    }
  }, [submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, submission.richTextContent, submission.content, getRichTextContent]);

  // Convert changes to tracked changes with status
  const trackedChanges: TrackedChange[] = useMemo(() => {
    console.log('TrackedChangesEditor: Processing changes:', submission.changes);
    const result = submission.changes.map(change => {
      // Get all comments for this change (including replies)
      const changeComments = submission.comments.filter((c: Comment) => {
        // Direct comments to this change
        if (c.content.includes(`@change:${change.id}`)) {
          return true;
        }
        // Reply comments (check if this comment is a reply to a comment on this change)
        if (c.content.includes('@reply:')) {
          const replyMatch = c.content.match(/@reply:([a-f0-9-]+)/);
          if (replyMatch) {
            const replyToCommentId = replyMatch[1];
            // Check if the comment being replied to is on this change
            const parentComment = submission.comments.find(pc => 
              pc.id === replyToCommentId && pc.content.includes(`@change:${change.id}`)
            );
            return !!parentComment;
          }
        }
        return false;
      });
      
      const status = (change as any).status || 'pending';
      console.log(`🔍 Change ${change.id} status:`, status);
      
      return {
        ...change,
        status: status, // Use status from tracked changes data
        approvedBy: (change as any).approvedBy,
        rejectedBy: (change as any).rejectedBy,
        comments: changeComments
      };
    });
    console.log('TrackedChangesEditor: Processed tracked changes:', result);
    return result;
  }, [submission.changes, submission.comments]);

  // Check if user can make editorial decisions
  const canMakeEditorialDecisions = useCallback(() => {
    // Check if user has admin, comms cadre, or council manager roles
    const hasEditorialRole = currentUser.roles.includes('CommsCadre') ||
                            currentUser.roles.includes('CouncilManager') ||
                            currentUser.roles.includes('Admin');
    
    // Check if user is the submitter
    const isSubmitter = currentUser.id === submission.submittedBy ||
                       currentUser.email === submission.submittedBy;
    
    // Check if user is a required approver
    const isRequiredApprover = submission.requiredApprovers?.includes(currentUser.email) || false;
    
    // Check if user is an assigned council manager
    const isAssignedCouncilManager = submission.assignedCouncilManagers?.includes(currentUser.email) || false;
    
    // Check if user has already approved this submission
    const hasApproved = submission.approvals?.some(approval => 
      approval.approverEmail === currentUser.email || approval.approverId === currentUser.email
    ) || false;
    
    const canMake = hasEditorialRole || isSubmitter || isRequiredApprover || isAssignedCouncilManager || hasApproved;
    
    console.log('🔍 canMakeEditorialDecisions check:', {
      currentUserRoles: currentUser.roles,
      currentUserId: currentUser.id,
      currentUserEmail: currentUser.email,
      submissionSubmittedBy: submission.submittedBy,
      hasCommsCadre: currentUser.roles.includes('CommsCadre'),
      hasCouncilManager: currentUser.roles.includes('CouncilManager'),
      hasAdmin: currentUser.roles.includes('Admin'),
      isSubmitter,
      isRequiredApprover,
      isAssignedCouncilManager,
      hasApproved,
      requiredApprovers: submission.requiredApprovers,
      assignedCouncilManagers: submission.assignedCouncilManagers,
      approvals: submission.approvals?.map(a => ({ approverEmail: a.approverEmail, approverId: a.approverId }))
    });
    
    console.log('🔍 canMakeEditorialDecisions result:', canMake);
    return canMake;
  }, [currentUser, submission.submittedBy, submission.requiredApprovers, submission.assignedCouncilManagers, submission.approvals]);

  // Get current content (proposed version or original)
  const currentContent = useMemo(() => {
    return getDisplayableText(submission.proposedVersions?.content || submission.content);
  }, [submission.proposedVersions?.content, submission.content, getDisplayableText]);

  // Get the content to display in the proposed version section
  const proposedContentToDisplay = useMemo(() => {
    return isEditingProposed ? editedProposedContent : getDisplayableText(
      lastSavedProposedContent || 
      submission.proposedVersions?.richTextContent || 
      submission.proposedVersions?.content || 
      currentContent
    );
  }, [isEditingProposed, editedProposedContent, lastSavedProposedContent, submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, currentContent, getDisplayableText]);

  // Memoize the rich text content for the proposed version editor
  const proposedEditorContent = useMemo(() => {
    const content = getRichTextContent(
      lastSavedProposedContent || 
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
  }, [lastSavedProposedContent, submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, submission.richTextContent, submission.content, getRichTextContent]);

  // Memoize the rich text content for the proposed version display
  const proposedDisplayContent = useMemo(() => {
    // Use last saved content if available, otherwise fall back to submission content
    const content = lastSavedProposedContent || 
                   submission.proposedVersions?.richTextContent || 
                   submission.proposedVersions?.content || 
                   submission.richTextContent || 
                   submission.content || 
                   '';
    return getRichTextContent(content);
  }, [lastSavedProposedContent, submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, submission.richTextContent, submission.content, getRichTextContent]);

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
        const changeOldText = getChangeDisplayText(change.oldValue || '');
        const changeNewText = getChangeDisplayText(change.newValue || '');
        
        if (type === 'addition' && changeNewText && changeNewText.includes(text)) {
          return change.id;
        }
        if (type === 'deletion' && changeOldText && changeOldText.includes(text)) {
          return change.id;
        }
      }
      return undefined;
    };

    // Group related deletion and addition segments
    const groupedSegments: { deletions: WordDiff[], additions: WordDiff[] }[] = [];
    let currentGroup = { deletions: [] as WordDiff[], additions: [] as WordDiff[] };
    
    diff.forEach((segment: WordDiff) => {
      if (segment.type === 'equal') {
        // If we have a group with content, save it and start a new one
        if (currentGroup.deletions.length > 0 || currentGroup.additions.length > 0) {
          groupedSegments.push({ ...currentGroup });
          currentGroup = { deletions: [], additions: [] };
        }
      } else if (segment.type === 'delete') {
        currentGroup.deletions.push(segment);
      } else if (segment.type === 'insert') {
        currentGroup.additions.push(segment);
      }
    });
    
    // Don't forget the last group
    if (currentGroup.deletions.length > 0 || currentGroup.additions.length > 0) {
      groupedSegments.push(currentGroup);
    }

    // Process grouped segments
    groupedSegments.forEach((group, groupIndex) => {
      // Find the change ID for this group (use the first deletion or addition)
      let groupChangeId: string | undefined;
      let groupAuthor: string | undefined;
      let groupTimestamp: Date | undefined;
      
      if (group.deletions.length > 0) {
        groupChangeId = findMostRecentChangeForText(group.deletions[0].value, 'deletion');
      }
      if (!groupChangeId && group.additions.length > 0) {
        groupChangeId = findMostRecentChangeForText(group.additions[0].value, 'addition');
      }
      
      if (groupChangeId) {
        const change = trackedChanges.find(c => c.id === groupChangeId);
        groupAuthor = change?.changedBy;
        groupTimestamp = change?.timestamp;
      }

      // Add deletion segments
      group.deletions.forEach((segment, index) => {
        segments.push({
          id: `del-${groupIndex}-${index}`,
          text: segment.value,
          type: 'deletion',
          status,
          changeId: groupChangeId,
          author: groupAuthor,
          timestamp: groupTimestamp,
          // Show controls on the first deletion segment (whether it's part of a replacement or standalone deletion)
          showControls: index === 0
        });
      });

      // Add addition segments
      group.additions.forEach((segment, index) => {
        segments.push({
          id: `add-${groupIndex}-${index}`,
          text: segment.value,
          type: 'addition',
          status,
          changeId: groupChangeId,
          author: groupAuthor,
          timestamp: groupTimestamp,
          // Show controls on the first addition segment only if there are no deletions (standalone addition)
          showControls: group.deletions.length === 0 && index === 0
        });
      });
    });

    // Add unchanged segments
    diff.forEach((segment: WordDiff) => {
      if (segment.type === 'equal') {
        segments.push({
          id: `equal-${segmentId++}`,
          text: segment.value,
          type: 'unchanged'
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
      // Extract plain text for the backend to calculate incremental changes
      const currentText = getDisplayableText(currentProposedContent);
      const editedText = getDisplayableText(editedProposedContent);
      
      const suggestion: Change = {
        id: crypto.randomUUID(),
        field: 'content',
        oldValue: currentText,  // Send plain text for diff calculation
        newValue: editedText,   // Send plain text for diff calculation
        changedBy: currentUser.id,
        timestamp: new Date(),
        isIncremental: true,
        // Store the rich text content separately for preservation
        richTextOldValue: currentProposedContent,
        richTextNewValue: editedProposedContent
      };
      onSuggestion(suggestion);
      
      // Update local state immediately for responsive UI
      setLastSavedProposedContent(editedProposedContent);
    }
    setIsEditingProposed(false);
  }, [editedProposedContent, submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, submission.richTextContent, submission.content, currentUser.id, onSuggestion, getDisplayableText]);

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
      console.log('TrackedChangesEditor: Submitting comment:', comment);
      onComment(comment);
      setCommentText('');
      setShowCommentDialog(false);
    }
  }, [selectedChange, commentText, currentUser.id, onComment]);

  // Handle undo change
  const handleUndoChange = useCallback((changeId: string) => {
    onUndo(changeId);
  }, [onUndo]);

  // Handle proposed version approval
  const handleProposedVersionApproval = useCallback(() => {
    onApproveProposedVersion(currentUser.id, proposedVersionApprovalComment);
    setProposedVersionApprovalComment('');
    setShowProposedVersionApprovalDialog(false);
  }, [currentUser.id, proposedVersionApprovalComment, onApproveProposedVersion]);

  // Handle proposed version rejection
  const handleProposedVersionRejection = useCallback(() => {
    onRejectProposedVersion(currentUser.id, proposedVersionApprovalComment);
    setProposedVersionApprovalComment('');
    setShowProposedVersionApprovalDialog(false);
  }, [currentUser.id, proposedVersionApprovalComment, onRejectProposedVersion]);

  // Handle comment reply
  const handleCommentReply = useCallback((commentId: string) => {
    if (replyText.trim()) {
      const reply: Comment = {
        id: crypto.randomUUID(),
        content: `@reply:${commentId} ${replyText}`,
        authorId: currentUser.id,
        createdAt: new Date(),
        type: 'COMMENT',
        resolved: false
      };
      console.log('TrackedChangesEditor: Submitting reply:', reply);
      onComment(reply);
      setReplyText('');
      setReplyToComment(null);
    }
  }, [replyText, currentUser.id, onComment]);

  // Toggle comment expansion
  const toggleCommentExpansion = useCallback((changeId: string) => {
    setExpandedComments(prev => {
      const newSet = new Set(prev);
      if (newSet.has(changeId)) {
        newSet.delete(changeId);
      } else {
        newSet.add(changeId);
      }
      return newSet;
    });
  }, []);

  // Check if user can approve the proposed version
  const canApproveProposedVersion = useCallback(() => {
    return currentUser.roles.includes('CommsCadre') ||
           currentUser.roles.includes('CouncilManager') ||
           currentUser.roles.includes('REVIEWER');
  }, [currentUser.roles]);

  // Check if proposed version is already approved
  const isProposedVersionApproved = useMemo(() => {
    return submission.approvals?.some(approval => 
      approval.status === 'APPROVED' && 
      approval.approverId !== submission.submittedBy
    ) || false;
  }, [submission.approvals, submission.submittedBy]);

  // Get proposed version approval info
  const proposedVersionApprovalInfo = useMemo(() => {
    const approval = submission.approvals?.find(a => 
      a.status === 'APPROVED' && 
      a.approverId !== submission.submittedBy
    );
    return approval;
  }, [submission.approvals, submission.submittedBy]);

  // Helper function to organize comments into a tree structure
  const organizeCommentsIntoTree = useCallback((comments: Comment[]) => {
    const commentMap = new Map<string, CommentWithReplies>();
    const rootComments: CommentWithReplies[] = [];

    // First pass: create map of all comments
    comments.forEach(comment => {
      commentMap.set(comment.id, { ...comment, replies: [] });
    });

    // Second pass: organize into tree
    comments.forEach(comment => {
      const replyMatch = comment.content.match(/@reply:([a-f0-9-]+)/);
      if (replyMatch) {
        const parentId = replyMatch[1];
        const parent = commentMap.get(parentId);
        if (parent) {
          parent.replies.push({ ...comment, replies: [] });
        }
      } else {
        // This is a root comment
        const commentWithReplies = commentMap.get(comment.id);
        if (commentWithReplies) {
          rootComments.push(commentWithReplies);
        }
      }
    });

    return rootComments;
  }, []);

  // Helper function to render a comment and its replies recursively
  const renderCommentTree = useCallback((comment: CommentWithReplies, changeId: string, depth: number = 0) => {
    const isReply = comment.content.includes('@reply:');
    const displayContent = comment.content
      .replace(`@change:${changeId}`, '')
      .replace(/@reply:[a-f0-9-]+/, '')
      .trim();

    return (
      <div key={comment.id} className={`comment-item ${isReply ? 'comment-reply' : ''}`} style={{ marginLeft: `${depth * 20}px` }}>
        <div className="comment-header">
          <span className="comment-author">{comment.authorId}</span>
          <span className="comment-time">
            {new Date(comment.createdAt).toLocaleString()}
          </span>
        </div>
        <div className="comment-content">
          {displayContent}
        </div>
        <div className="comment-actions">
          <button
            className="reply-button"
            onClick={(e) => {
              e.stopPropagation();
              setReplyToComment(comment.id);
            }}
            title="Reply to this comment"
          >
            ↶ Reply
          </button>
        </div>
        {replyToComment === comment.id && (
          <div className="reply-form">
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Write your reply..."
              autoFocus
            />
            <div className="reply-actions">
              <button
                onClick={() => {
                  setReplyToComment(null);
                  setReplyText('');
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleCommentReply(comment.id)}
                className="primary"
              >
                Reply
              </button>
            </div>
          </div>
        )}
        {comment.replies.length > 0 && (
          <div className="comment-replies">
            {comment.replies.map(reply => renderCommentTree(reply, changeId, depth + 1))}
          </div>
        )}
      </div>
    );
  }, [replyToComment, replyText, handleCommentReply]);

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
                      <>
                        <button
                          className="edit-button"
                          onClick={() => {
                            // Reset the initial content when starting to edit
                            const content = submission.proposedVersions?.richTextContent || 
                                           submission.proposedVersions?.content || 
                                           submission.richTextContent || 
                                           submission.content || '';
                            initialEditorContentRef.current = getRichTextContent(content);
                            setIsEditingProposed(true);
                          }}
                          title="Edit proposed version"
                        >
                          ✏️ Edit
                        </button>
                        {canApproveProposedVersion() && !isProposedVersionApproved && (
                          <button
                            className="approve-button"
                            onClick={() => setShowProposedVersionApprovalDialog(true)}
                            title="Approve proposed version"
                          >
                            ✓ Approve
                          </button>
                        )}
                        {isProposedVersionApproved && proposedVersionApprovalInfo && (
                          <div className="approval-info">
                            <span className="approved-badge">
                              ✅ Approved by {proposedVersionApprovalInfo.approverId}
                            </span>
                            {proposedVersionApprovalInfo.comment && (
                              <span className="approval-comment">
                                "{proposedVersionApprovalInfo.comment}"
                              </span>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="edit-actions">
                        <button
                          className="save-button"
                          onClick={handleProposedEditSubmit}
                          title="Save changes"
                        >
                          💾 Save
                        </button>
                        <button
                          className="cancel-button"
                          onClick={() => {
                            setIsEditingProposed(false);
                            const content = submission.proposedVersions?.richTextContent || 
                                           submission.proposedVersions?.content || 
                                           submission.richTextContent || 
                                           submission.content || '';
                            const richTextContent = getRichTextContent(content);
                            setEditedProposedContent(richTextContent);
                            // Reset last saved content to the original submission content
                            setLastSavedProposedContent(richTextContent);
                          }}
                          title="Cancel editing"
                        >
                          ✕ Cancel
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
                        initialContent={initialEditorContentRef.current}
                        onChange={handleEditorChange}
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
                      {segment.showControls && segment.changeId && segment.status === 'pending' && canMakeEditorialDecisions() && (
                        <div className="segment-actions">
                          <button
                            className="segment-action-button approve"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleChangeDecision(segment.changeId!, 'approve');
                            }}
                            title="Approve this change"
                          >
                            ✓
                          </button>
                          <button
                            className="segment-action-button reject"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleChangeDecision(segment.changeId!, 'reject');
                            }}
                            title="Reject this change"
                          >
                            ✗
                          </button>
                        </div>
                      )}
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
                            <strong>Removed:</strong> <span>{getChangeDisplayText(change.oldValue)}</span>
                          </span>
                        )}
                        {change.newValue && (
                          <span className="diff-new" style={{fontSize: '13px', lineHeight: '1.4'}}>
                            <strong>Added:</strong> {getChangeDisplayText(change.newValue)}
                          </span>
                        )}

                      </>
                    ) : (
                      <>
                        {change.oldValue && (
                          <span className="diff-old" style={{fontSize: '13px', lineHeight: '1.4'}}>
                            <strong>Previous:</strong> {getChangeDisplayText(change.oldValue).substring(0, 100)}...
                          </span>
                        )}
                        {change.newValue && (
                          <span className="diff-new" style={{fontSize: '13px', lineHeight: '1.4'}}>
                            <strong>New:</strong> {getChangeDisplayText(change.newValue).substring(0, 100)}...
                          </span>
                        )}

                      </>
                    )}
                  </div>
                </div>
                <div className="change-actions">
                  {canMakeEditorialDecisions() && (
                    <>
                      <button
                        className="action-button approve"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleChangeDecision(change.id, 'approve');
                        }}
                        title="Approve this change"
                        disabled={change.status !== 'pending'}
                        style={{ 
                          opacity: change.status !== 'pending' ? 0.4 : 1,
                          backgroundColor: change.status !== 'pending' ? '#f5f5f5' : '#fff'
                        }}
                      >
                        ✓
                      </button>
                      <button
                        className="action-button reject"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleChangeDecision(change.id, 'reject');
                        }}
                        title="Reject this change"
                        disabled={change.status !== 'pending'}
                        style={{ 
                          opacity: change.status !== 'pending' ? 0.4 : 1,
                          backgroundColor: change.status !== 'pending' ? '#f5f5f5' : '#fff'
                        }}
                      >
                        ✗
                      </button>
                      {(change.status === 'approved' || change.status === 'rejected') && (
                        <button
                          className="action-button undo"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleUndoChange(change.id);
                          }}
                          title="Undo this decision"
                        >
                          ↩
                        </button>
                      )}
                    </>
                  )}
                  <button
                    className="action-button comment"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedChange(change.id);
                      setShowCommentDialog(true);
                    }}
                    title="Add comment"
                  >
                    💬
                  </button>
                  {/* Debug info */}
                  <div style={{ fontSize: '10px', color: '#666', marginLeft: '8px' }}>
                    Status: {change.status} | CanEdit: {canMakeEditorialDecisions() ? 'Yes' : 'No'}
                  </div>
                </div>
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
                    <div className="comments-header">
                      <span className="comments-count">{change.comments.length} comment{change.comments.length !== 1 ? 's' : ''}</span>
                      <button
                        className="expand-comments-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCommentExpansion(change.id);
                        }}
                      >
                        {expandedComments.has(change.id) ? '▲' : '▼'}
                      </button>
                    </div>
                    {expandedComments.has(change.id) && (
                      <div className="comments-thread">
                        {organizeCommentsIntoTree(change.comments).map(comment => 
                          renderCommentTree(comment, change.id)
                        )}
                      </div>
                    )}
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

      {/* Proposed Version Approval Dialog */}
      {showProposedVersionApprovalDialog && (
        <div className="dialog-overlay" onClick={() => setShowProposedVersionApprovalDialog(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h3>Approve Proposed Version</h3>
            <div className="approval-options">
              <p>Are you sure you want to approve this proposed version?</p>
              <textarea
                value={proposedVersionApprovalComment}
                onChange={(e) => setProposedVersionApprovalComment(e.target.value)}
                placeholder="Add an optional comment about your approval..."
                rows={3}
              />
            </div>
            <div className="dialog-actions">
              <button onClick={() => setShowProposedVersionApprovalDialog(false)}>Cancel</button>
              <button onClick={handleProposedVersionRejection} className="reject">
                Reject
              </button>
              <button onClick={handleProposedVersionApproval} className="primary">
                Approve
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};