import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ContentSubmission, User, Comment, Change, Approval } from '../types/content';
import { smartDiff, WordDiff, applyChanges, calculateIncrementalChanges } from '../utils/diffAlgorithm';
import { extractTextFromLexical, isLexicalJson, findAndReplaceInLexical, insertTextInLexical, removeTextFromLexical } from '../utils/lexicalUtils';
import LexicalEditorComponent from './editor/LexicalEditor';
import { CollaborativeEditor } from './CollaborativeEditor';
import { $isImageNode } from './editor/nodes/ImageNode';
import { SubmissionWebSocketClient, WebSocketMessage, WebSocketManager } from '../services/websocketService';
import './TrackedChangesEditor.css';

const webSocketManager = new WebSocketManager();

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
  onRefreshNeeded?: () => void;
}

interface ConnectedUser {
  userId: string;
  userName: string;
  userEmail: string;
  connectedAt: string;
  lastActivity?: string;
  isEditing?: boolean;
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

interface RealtimeNotification {
  id: string;
  type: string;
  message: string;
  userId: string;
  userName: string;
  timestamp: Date;
  changeId?: string;
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
  onRefreshNeeded,
}) => {
  
  // WebSocket state is now managed by CollaborativeEditor
  
  // Existing state
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [showCommentDialog, setShowCommentDialog] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [suggestionText, setSuggestionText] = useState('');
  const [showSuggestionDialog, setShowSuggestionDialog] = useState(false);
  // Always-on collaborative editing - no edit mode toggle needed
  const [editedProposedContent, setEditedProposedContent] = useState('');
  const editedProposedContentRef = useRef(editedProposedContent);
  const initialEditorContentRef = useRef<string>('');
  const [lastSavedProposedContent, setLastSavedProposedContent] = useState<string>('');
  const [showProposedVersionApprovalDialog, setShowProposedVersionApprovalDialog] = useState(false);
  const [proposedVersionApprovalComment, setProposedVersionApprovalComment] = useState('');
  const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set());
  const [replyToComment, setReplyToComment] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  
  // Synchronized scrolling refs and state
  const originalDiffTextRef = useRef<HTMLDivElement>(null);
  const proposedDiffTextRef = useRef<HTMLDivElement>(null);
  const isScrollingSyncedRef = useRef(false);
  
  // Auto-save state
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle');
  const [lastAutoSaveTime, setLastAutoSaveTime] = useState<Date | null>(null);
  const [autoSaveCountdown, setAutoSaveCountdown] = useState<number | null>(null);
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const autoSaveCountdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isAutoSaveEnabledRef = useRef(true);
  const hasInitializedContentRef = useRef(false);
  
  // Remote update state
  const [remoteUpdateStatus, setRemoteUpdateStatus] = useState<'none' | 'applying' | 'applied'>('none');
  
  // WebSocket client for sending updates
  const webSocketClientRef = useRef<any>(null);
  const lastCursorPositionRef = useRef<any>(null);
  const remoteUpdateFunctionRef = useRef<((content: string) => void) | null>(null);

  // Real-time character-by-character sync state
  const realTimeUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastRealTimeUpdateRef = useRef<string>('');
  const pendingRealTimeUpdateRef = useRef<boolean>(false);
  const realTimeUpdateIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isApplyingRealTimeUpdateRef = useRef<boolean>(false);

  // Auto-save period change consolidation state
  const autoSavePeriodStartContentRef = useRef<string>('');
  const autoSavePeriodStartTimeRef = useRef<Date | null>(null);
  const hasChangesInCurrentPeriodRef = useRef<boolean>(false);

  // Get effective user ID (fallback to email if id is not available)
  const effectiveUserId = currentUser.id || currentUser.email;

  // Real-time notifications are now handled by CollaborativeEditor

  // Helper function to request refresh from parent
  const requestRefresh = useCallback(() => {
    if (onRefreshNeeded) {
      onRefreshNeeded();
    } else {
      // TODO: Add refresh mechanism - parent component needs to refetch data
      console.log('🔄 Refresh needed but no refresh callback provided');
    }
  }, [onRefreshNeeded, submission.id]);

  // WebSocket connection is now handled by CollaborativeEditor
  // Removed WebSocket connection setup

  // WebSocket connection logic removed - now handled by CollaborativeEditor

  // Update ref when content changes
  useEffect(() => {
    editedProposedContentRef.current = editedProposedContent;
  }, [editedProposedContent]);

  // Stable onChange handler for the editor
  const handleEditorChange = useCallback((editor: any, json: string) => {
    // Skip if we're still initializing content to prevent auto-save on load
    if (!hasInitializedContentRef.current) {
      console.log('🚫 Skipping editor change during initialization');
      return;
    }
    
    // Only update if the content has actually changed
    if (json !== editedProposedContentRef.current) {
      setEditedProposedContent(json);
    }
  }, []);

  // Removed edit mode content state since we only have proposed version editing now

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

  // Helper function to extract images from Lexical content
  const extractImagesFromLexical = useCallback((content: string): Array<{ src: string; alt: string; id?: string }> => {
    if (!content || !isLexicalJson(content)) return [];
    
    try {
      const lexicalData = JSON.parse(content);
      const images: Array<{ src: string; alt: string; id?: string }> = [];
      
      const extractFromChildren = (children: any[]) => {
        for (const child of children) {
          if (child.type === 'image') {
            images.push({
              src: child.src,
              alt: child.altText || '',
              id: child.imageId
            });
          }
          if (child.children) {
            extractFromChildren(child.children);
          }
        }
      };
      
      if (lexicalData.root?.children) {
        extractFromChildren(lexicalData.root.children);
      }
      
      return images;
    } catch (error) {
      console.error('Error extracting images from Lexical content:', error);
      return [];
    }
  }, []);

  // Helper function to render images in diff view
  const renderImageInDiff = useCallback((image: { src: string; alt: string; id?: string }, type: 'added' | 'removed' | 'unchanged') => {
    return (
      <div key={image.id || image.src} className={`diff-image ${type}`}>
        <img 
          src={image.src} 
          alt={image.alt} 
          className="diff-image-content"
          style={{ 
            maxWidth: '200px', 
            maxHeight: '150px',
            objectFit: 'contain',
            border: type === 'added' ? '2px solid #28a745' : 
                   type === 'removed' ? '2px solid #dc3545' : 
                   '2px solid #6c757d',
            borderRadius: '4px',
            margin: '4px'
          }}
        />
        <div className="diff-image-label">
          <span className={`diff-marker ${type}`}>
            {type === 'added' ? '+' : type === 'removed' ? '-' : ''}
          </span>
          <span className="diff-image-alt">{image.alt}</span>
        </div>
      </div>
    );
  }, []);

  // Helper function to get displayable text from change values (with debugging)
  const getChangeDisplayText = useCallback((content: string): string => {
    
    if (!content) return '';
    
    // Check if content is Lexical JSON and extract text
    if (isLexicalJson(content)) {
      const extracted = extractTextFromLexical(content);
      return extracted;
    }
    
    // Handle partial JSON fragments (like the ones you're seeing)
    if (typeof content === 'string' && content.includes('"text":"')) {
      
      // Extract text values from JSON fragments using regex
      const textMatches = content.match(/"text":"([^"]*)"/g);
      if (textMatches && textMatches.length > 0) {
        const extractedTexts = textMatches.map(match => {
          // Remove the "text":" and " parts
          return match.replace(/"text":"/, '').replace(/"$/, '');
        }).filter(text => text.trim() !== '');
        
        if (extractedTexts.length > 0) {
          const result = extractedTexts.join(' ');
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
            return parsed.text;
          }
          if (parsed.content) {
            return parsed.content;
          }
          // If it's a complex object, stringify it for display
          const stringified = JSON.stringify(parsed, null, 2);
          return stringified.substring(0, 200) + (stringified.length > 200 ? '...' : '');
        }
      } catch (e) {
        console.log('getChangeDisplayText: Failed to parse as JSON, treating as plain text');
      }
    }
    
    return content;
  }, []);

  // Helper function to get the correct rich text content for display/editing
  const getRichTextContent = useCallback((content: string): string => {

    if (!content) {
      return '';
    }
    
    // If it's already Lexical JSON, return as is
    if (isLexicalJson(content)) {
      return content;
    }
    
    // Check if content contains HTML or rich text formatting
    // Only treat as HTML if it starts with HTML tags, not if it just contains them
    const isHtml = typeof content === 'string' && 
                   content.trim().startsWith('<') && 
                   !isLexicalJson(content);
    
    if (isHtml) {
      console.log('🔄 getRichTextContent: Processing HTML content');
      
      // For HTML content, let the CollaborativeEditor handle the conversion
      // Just return the HTML content as-is and let the editor parse it
      return content;
    }
    
    // If it's plain text, create a basic Lexical structure
    if (typeof content === 'string' && content.trim()) {
      // For plain text with line breaks, create multiple paragraphs
      const lines = content.split('\n').filter(line => line.trim() !== '');
      
      if (lines.length === 0) {
        return '';
      }
      
      // Create a Lexical JSON structure with multiple paragraphs for multi-line content
      const children = lines.map(line => ({
        children: [
          {
            detail: 0,
            format: 0,
            mode: "normal",
            style: "",
            text: line,
            type: "text",
            version: 1
          }
        ],
        direction: "ltr",
        format: "",
        indent: 0,
        type: "paragraph",
        version: 1
      }));
      
      const basicLexicalStructure = {
        root: {
          children: children,
          direction: "ltr",
          format: "",
          indent: 0,
          type: "root",
          version: 1
        }
      };
      
      const result = JSON.stringify(basicLexicalStructure);
      return result;
    }
    
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
    
    console.log('🔍 Content initialization with source data:', {
      proposedVersionsRichTextContent: !!submission.proposedVersions?.richTextContent,
      proposedVersionsRichTextContentLength: submission.proposedVersions?.richTextContent?.length,
      proposedVersionsRichTextContentPreview: submission.proposedVersions?.richTextContent?.substring(0, 100),
      proposedVersionsContent: !!submission.proposedVersions?.content,
      richTextContent: !!submission.richTextContent,
      content: !!submission.content,
      finalContentLength: content?.length,
      finalContentPreview: content?.substring(0, 100),
      isLexicalJson: isLexicalJson(content)
    });
    
    // If content looks like a comment, skip it and use empty content
    if (typeof content === 'string' && content.includes('@change:')) {
      content = '';
    }
    
    // DEFENSE: If we have editedProposedContent that's richer than what we're getting from backend,
    // and the new content is plain text while the current content is Lexical JSON, preserve the current content
    const isCurrentContentRich = editedProposedContent && isLexicalJson(editedProposedContent);
    const isNewContentPlain = content && !isLexicalJson(content);
    
    if (isCurrentContentRich && isNewContentPlain && editedProposedContent) {
      console.log('🛡️ DEFENSE: Preserving rich content over plain text from backend');
      console.log('🛡️ Current content length:', editedProposedContent.length, 'chars (rich)');
      console.log('🛡️ New content length:', content.length, 'chars (plain)');
      // Keep the current rich content instead of overwriting with plain text
      return;
    }
    
    const richTextContent = getRichTextContent(content);
    
    console.log('🔍 After getRichTextContent conversion:', {
      inputLength: content?.length,
      outputLength: richTextContent?.length,
      inputPreview: content?.substring(0, 100),
      outputPreview: richTextContent?.substring(0, 100),
      inputIsLexical: isLexicalJson(content),
      outputIsLexical: isLexicalJson(richTextContent)
    });
    
    // Always update the edited content and last saved content during initialization
    setEditedProposedContent(richTextContent);
    setLastSavedProposedContent(richTextContent);
    
    // Always update the initial content reference for fresh data
    // This ensures the editor gets the latest content when entering edit mode
    initialEditorContentRef.current = richTextContent;
    
    // Mark as initialized after a short delay to ensure all state is set
    setTimeout(() => {
      hasInitializedContentRef.current = true;
      console.log('✅ Content initialization complete');
      
      // Reset auto-save period tracking on initialization
      hasChangesInCurrentPeriodRef.current = false;
      autoSavePeriodStartContentRef.current = '';
      autoSavePeriodStartTimeRef.current = null;
    }, 100);
  }, [submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, submission.richTextContent, submission.content, getRichTextContent]);

  // Synchronized scrolling handlers
  const handleOriginalScroll = useCallback(() => {
    if (isScrollingSyncedRef.current || !originalDiffTextRef.current || !proposedDiffTextRef.current) return;
    
    isScrollingSyncedRef.current = true;
    requestAnimationFrame(() => {
      if (proposedDiffTextRef.current && originalDiffTextRef.current) {
        proposedDiffTextRef.current.scrollTop = originalDiffTextRef.current.scrollTop;
      }
      isScrollingSyncedRef.current = false;
    });
  }, []);

  const handleProposedScroll = useCallback(() => {
    if (isScrollingSyncedRef.current || !originalDiffTextRef.current || !proposedDiffTextRef.current) return;
    
    isScrollingSyncedRef.current = true;
    requestAnimationFrame(() => {
      if (originalDiffTextRef.current && proposedDiffTextRef.current) {
        originalDiffTextRef.current.scrollTop = proposedDiffTextRef.current.scrollTop;
      }
      isScrollingSyncedRef.current = false;
    });
  }, []);

  // Add scroll event listeners
  useEffect(() => {
    const originalElement = originalDiffTextRef.current;
    const proposedElement = proposedDiffTextRef.current;
    
    if (originalElement && proposedElement) {
      originalElement.addEventListener('scroll', handleOriginalScroll);
      proposedElement.addEventListener('scroll', handleProposedScroll);
      
      return () => {
        originalElement.removeEventListener('scroll', handleOriginalScroll);
        proposedElement.removeEventListener('scroll', handleProposedScroll);
      };
    }
  }, [handleOriginalScroll, handleProposedScroll]);

  // Convert changes to tracked changes with status
  const trackedChanges: TrackedChange[] = useMemo(() => {
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
      
      return {
        ...change,
        status: status, // Use status from tracked changes data
        approvedBy: (change as any).approvedBy,
        rejectedBy: (change as any).rejectedBy,
        comments: changeComments
      };
    });
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
    
    return canMake;
  }, [currentUser, submission.submittedBy, submission.requiredApprovers, submission.assignedCouncilManagers, submission.approvals]);

  // Get current content (proposed version or original)
  const currentContent = useMemo(() => {
    return getDisplayableText(submission.proposedVersions?.content || submission.content);
  }, [submission.proposedVersions?.content, submission.content, getDisplayableText]);

  // Memoize the proposedContentToDisplay to avoid unnecessary re-renders
  const proposedContentToDisplay = useMemo(() => {
    // Always return the edited content for collaborative editing
    return editedProposedContent || getDisplayableText(
      submission.proposedVersions?.richTextContent || 
      submission.proposedVersions?.content || 
      currentContent
    );
  }, [editedProposedContent, submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, currentContent, getDisplayableText]);

  const handleTextSelection = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
    }
  }, []);

  const handleProposedEditModeChange = useCallback((newEditMode: boolean) => {
    // Remove edit mode toggle - always collaborative
    console.log('Edit mode change requested but collaborative editing is always on');
  }, []);

  // Dedicated save function for reverted content that bypasses change detection
  const saveRevertedContent = useCallback(async (revertedContent: string) => {
    console.log('💾 Saving reverted content directly to backend:', {
      revertedContentLength: revertedContent?.length,
      revertedContentPreview: revertedContent?.substring(0, 100)
    });

    try {
      setAutoSaveStatus('saving');
      
      // Update the submission with the reverted content
      const updatedSubmission = {
        ...submission,
        proposedVersions: {
          ...submission.proposedVersions,
          richTextContent: revertedContent,
          lastModified: new Date().toISOString(),
          lastModifiedBy: currentUser.id || currentUser.email
        }
      };
      
      console.log('💾 Calling onSave with reverted submission:', {
        submissionId: updatedSubmission.id,
        proposedVersionsRichTextContentLength: updatedSubmission.proposedVersions?.richTextContent?.length
      });
      
      await onSave(updatedSubmission);
      
      // Update the last saved content after successful save
      setLastSavedProposedContent(revertedContent);
      setAutoSaveStatus('saved');
      setLastAutoSaveTime(new Date());
      
      console.log('✅ Reverted content saved successfully');
      
      // Reset to idle after 3 seconds
      setTimeout(() => {
        setAutoSaveStatus('idle');
      }, 3000);
      
    } catch (error) {
      console.error('❌ Failed to save reverted content:', error);
      setAutoSaveStatus('error');
      
      // Reset to idle after 5 seconds
      setTimeout(() => {
        setAutoSaveStatus('idle');
      }, 5000);
    }
  }, [submission, currentUser.id, currentUser.email, onSave]);

  const handleProposedEditSubmit = useCallback(async () => {
    console.log('📝 Submitting proposed edit:', {
      editedProposedContentLength: editedProposedContent?.length,
      editedProposedContentPreview: editedProposedContent?.substring(0, 100)
    });
    
    const currentContent = submission.proposedVersions?.richTextContent || submission.richTextContent || submission.content || '';
    const hasActualChanges = editedProposedContent !== currentContent;
    
    console.log('📝 Checking for changes:', {
      hasActualChanges,
      currentContentLength: currentContent?.length,
      editedContentLength: editedProposedContent?.length,
      currentContentPreview: currentContent?.substring(0, 100),
      editedContentPreview: editedProposedContent?.substring(0, 100),
      hasChangesInCurrentPeriod: hasChangesInCurrentPeriodRef.current
    });
    
    if (!hasActualChanges) {
      console.log('No changes to submit');
      setAutoSaveStatus('idle');
      // Reset auto-save period tracking
      hasChangesInCurrentPeriodRef.current = false;
      autoSavePeriodStartContentRef.current = '';
      autoSavePeriodStartTimeRef.current = null;
      return;
    }

    // Create a consolidated tracked change for manual save if there are changes in the current period
    if (hasChangesInCurrentPeriodRef.current && autoSavePeriodStartContentRef.current) {
      const periodStartContent = autoSavePeriodStartContentRef.current;
      const periodStartTime = autoSavePeriodStartTimeRef.current;
      
      // Create a single consolidated change for the entire period
      const periodStartText = getDisplayableText(periodStartContent);
      const currentText = getDisplayableText(editedProposedContent);
      
      if (periodStartText !== currentText) {
        const consolidatedChange: Change = {
          id: `manual-save-${Date.now()}`,
          field: 'content' as const,
          oldValue: periodStartText,
          newValue: currentText,
          changedBy: currentUser.id,
          timestamp: periodStartTime || new Date(),
          isIncremental: false, // This is a consolidated change, not incremental
          richTextOldValue: periodStartContent,
          richTextNewValue: editedProposedContent
        };
        
        console.log('📝 Creating consolidated tracked change for manual save:', {
          changeId: consolidatedChange.id,
          oldLength: periodStartText.length,
          newLength: currentText.length,
          periodDuration: periodStartTime ? new Date().getTime() - periodStartTime.getTime() : 0
        });
        
        // Add the consolidated change to the tracked changes sidebar
        onSuggestion(consolidatedChange);
      }
      
      // Reset auto-save period tracking
      hasChangesInCurrentPeriodRef.current = false;
      autoSavePeriodStartContentRef.current = '';
      autoSavePeriodStartTimeRef.current = null;
    }

    try {
      // Update the submission with the changes
      const updatedSubmission = {
        ...submission,
        proposedVersions: {
          ...submission.proposedVersions,
          richTextContent: editedProposedContent,
          lastModified: new Date().toISOString(),
          lastModifiedBy: currentUser.id || currentUser.email
        }
      };
      
      console.log('📝 Calling onSave with updated submission:', {
        submissionId: updatedSubmission.id,
        proposedVersionsRichTextContentLength: updatedSubmission.proposedVersions?.richTextContent?.length
      });
      
      console.log('🔍 About to call onSave with content details:', {
        richTextContentLength: updatedSubmission.proposedVersions?.richTextContent?.length,
        richTextContentIsLexical: isLexicalJson(updatedSubmission.proposedVersions?.richTextContent || ''),
        richTextContentPreview: updatedSubmission.proposedVersions?.richTextContent?.substring(0, 150)
      });
      
      await onSave(updatedSubmission);
      
      console.log('🔍 onSave completed, content after save:', {
        editedProposedContentLength: editedProposedContent?.length,
        editedProposedContentIsLexical: isLexicalJson(editedProposedContent || ''),
        editedProposedContentPreview: editedProposedContent?.substring(0, 150)
      });
      
      // Update the last saved content after successful save
      setLastSavedProposedContent(editedProposedContent);
      setAutoSaveStatus('saved');
      setLastAutoSaveTime(new Date());
      
      // Reset auto-save period tracking after successful manual save
      hasChangesInCurrentPeriodRef.current = false;
      autoSavePeriodStartContentRef.current = '';
      autoSavePeriodStartTimeRef.current = null;
      
      // Reset to idle after 3 seconds
      setTimeout(() => {
        setAutoSaveStatus('idle');
      }, 3000);
      
    } catch (error) {
      console.error('❌ Save failed:', error);
      setAutoSaveStatus('error');
      
      // Reset auto-save period tracking on error (changes will be tracked again on next edit)
      hasChangesInCurrentPeriodRef.current = false;
      autoSavePeriodStartContentRef.current = '';
      autoSavePeriodStartTimeRef.current = null;
      
      // Reset to idle after 5 seconds
      setTimeout(() => {
        setAutoSaveStatus('idle');
      }, 5000);
    }
  }, [editedProposedContent, submission, onSave, currentUser.id, currentUser.email, getDisplayableText, onSuggestion]);

  // Helper function to revert a change in the content
  const revertChangeInContent = useCallback((change: TrackedChange) => {
    console.log('🔄 Reverting change:', {
      changeId: change.id,
      oldValue: change.oldValue,
      newValue: change.newValue,
      richTextOldValue: change.richTextOldValue,
      richTextNewValue: change.richTextNewValue,
      isIncremental: change.isIncremental
    });

    // Get current content
    const currentContent = editedProposedContent || 
                          submission.proposedVersions?.richTextContent || 
                          submission.richTextContent || 
                          submission.content || '';

    // Try to revert using rich text values first, then fall back to plain text
    const valueToRevert = change.richTextNewValue !== undefined ? change.richTextNewValue : change.newValue;
    const revertToValue = change.richTextOldValue !== undefined ? change.richTextOldValue : change.oldValue;

    if (valueToRevert === undefined || revertToValue === undefined) {
      console.warn('⚠️ Cannot revert change: missing old or new value', {
        oldValue: change.oldValue,
        newValue: change.newValue,
        richTextOldValue: change.richTextOldValue,
        richTextNewValue: change.richTextNewValue,
        valueToRevert,
        revertToValue
      });
      return;
    }

    // For incremental changes, find and replace the specific part
    if (change.isIncremental) {
      // Work directly with Lexical JSON to preserve formatting
      if (isLexicalJson(currentContent)) {
        // Use Lexical utilities to preserve formatting
        const newText = getDisplayableText(valueToRevert);
        const oldText = getDisplayableText(revertToValue);
        
        let revertedContent = currentContent;
        
        // Handle deletion case where newValue is empty (text was deleted)
        if (newText === '') {
          // This is a deletion - restore the deleted text
          console.log('🔄 Handling deletion reversion with Lexical preservation:', {
            oldText,
            currentContentType: 'Lexical JSON'
          });
          
          // Insert the deleted text back into the Lexical structure
          revertedContent = insertTextInLexical(currentContent, oldText);
          
          console.log('✅ Reverted deletion in Lexical JSON:', {
            restoredText: oldText,
            preservedFormatting: true
          });
        } else {
          // Handle replacement case - replace newText with oldText
          console.log('🔄 Handling replacement reversion with Lexical preservation:', {
            searchingFor: newText,
            replacingWith: oldText
          });
          
          revertedContent = findAndReplaceInLexical(currentContent, newText, oldText);
          
          console.log('✅ Reverted replacement in Lexical JSON:', {
            searchText: newText,
            replaceText: oldText,
            preservedFormatting: true
          });
        }
        
        setEditedProposedContent(revertedContent);
        
        if (remoteUpdateFunctionRef.current) {
          remoteUpdateFunctionRef.current(revertedContent);
        }
        
        // Immediately save the reverted content to ensure backend persistence
        console.log('💾 Triggering immediate save for reverted content');
        setTimeout(() => {
          saveRevertedContent(revertedContent);
        }, 100);
      } else {
        // Fallback to plain text handling for non-Lexical content
        const currentText = getDisplayableText(currentContent);
        const newText = getDisplayableText(valueToRevert);
        const oldText = getDisplayableText(revertToValue);
        
        // Handle deletion case where newValue is empty (text was deleted)
        if (newText === '') {
          console.log('🔄 Handling deletion reversion (plain text):', {
            oldText,
            currentTextLength: currentText.length
          });
          
          // Simple append for plain text (could be improved with better positioning)
          const revertedText = currentText + (currentText.endsWith(' ') ? '' : ' ') + oldText;
          const revertedRichContent = getRichTextContent(revertedText);
          
                     console.log('✅ Reverted deletion (plain text):', {
             restoredText: oldText,
             newContentLength: revertedText.length
           });
           
           setEditedProposedContent(revertedRichContent);
           
           if (remoteUpdateFunctionRef.current) {
             remoteUpdateFunctionRef.current(revertedRichContent);
           }
           
           // Immediately save the reverted content to ensure backend persistence
           console.log('💾 Triggering immediate save for reverted content (plain text deletion)');
           setTimeout(() => {
             saveRevertedContent(revertedRichContent);
           }, 100);
        } else {
          // Handle replacement case
          const index = currentText.indexOf(newText);
          if (index !== -1) {
            const revertedText = currentText.substring(0, index) + 
                                oldText + 
                                currentText.substring(index + newText.length);
            
            const revertedRichContent = getRichTextContent(revertedText);
            
            console.log('✅ Reverted replacement (plain text):', {
              originalText: currentText.substring(Math.max(0, index - 10), index + newText.length + 10),
              revertedText: revertedText.substring(Math.max(0, index - 10), index + oldText.length + 10)
            });
            
            setEditedProposedContent(revertedRichContent);
            
            if (remoteUpdateFunctionRef.current) {
              remoteUpdateFunctionRef.current(revertedRichContent);
            }
            
            // Immediately save the reverted content to ensure backend persistence
            console.log('💾 Triggering immediate save for reverted content (plain text replacement)');
            setTimeout(() => {
              saveRevertedContent(revertedRichContent);
            }, 100);
          } else {
            console.warn('⚠️ Could not find text to revert in incremental change', {
              searchingFor: newText,
              inContent: currentText.substring(0, 200) + '...'
            });
          }
        }
      }
    } else {
      // For non-incremental changes, check if the current content matches the new value
      // and if so, revert it to the old value
      const currentText = getDisplayableText(currentContent);
      const newText = getDisplayableText(valueToRevert);
      
      if (currentText === newText) {
        // Content matches the new value, revert to old value
        const revertedRichContent = getRichTextContent(revertToValue);
        
        console.log('✅ Reverted non-incremental change:', {
          wasContent: currentText.substring(0, 100),
          nowContent: getDisplayableText(revertToValue).substring(0, 100)
        });
        
        // Update the editor content
        setEditedProposedContent(revertedRichContent);
        
        // If we have a remote update function, use it to update the editor
        if (remoteUpdateFunctionRef.current) {
          remoteUpdateFunctionRef.current(revertedRichContent);
        }
        
        // Immediately save the reverted content to ensure backend persistence
        console.log('💾 Triggering immediate save for reverted content (non-incremental)');
        setTimeout(() => {
          saveRevertedContent(revertedRichContent);
        }, 100);
      } else {
        console.warn('⚠️ Current content does not match expected new value for non-incremental change');
        console.log('Current:', currentText.substring(0, 100));
        console.log('Expected:', newText.substring(0, 100));
      }
    }

    // Auto-save will be triggered by the content change
  }, [editedProposedContent, submission, getDisplayableText, getRichTextContent, saveRevertedContent]);

  // Handle change decision (approve/reject)
  const handleChangeDecision = useCallback((changeId: string, decision: 'approve' | 'reject') => {
    if (decision === 'approve') {
      onApprove(changeId);
    } else {
      // Find the change to revert
      const changeToRevert = trackedChanges.find(change => change.id === changeId);
      if (changeToRevert) {
        // Revert the change in the proposed content
        revertChangeInContent(changeToRevert);
      }
      onReject(changeId);
    }
    
    // Real-time approvals are now handled by CollaborativeEditor
  }, [onApprove, onReject, trackedChanges, revertChangeInContent]);

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
      
      // Real-time comments are now handled by CollaborativeEditor
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
    
    // Real-time status changes are now handled by CollaborativeEditor
  }, [currentUser.id, proposedVersionApprovalComment, onApproveProposedVersion]);

  // Handle proposed version rejection
  const handleProposedVersionRejection = useCallback(() => {
    onRejectProposedVersion(currentUser.id, proposedVersionApprovalComment);
    setProposedVersionApprovalComment('');
    setShowProposedVersionApprovalDialog(false);
    
    // Real-time status changes are now handled by CollaborativeEditor
  }, [currentUser.id, proposedVersionApprovalComment, onRejectProposedVersion]);

  // Auto-save functionality with countdown timer
  const performAutoSave = useCallback(async () => {
    if (!isAutoSaveEnabledRef.current) {
      console.log('🚫 Auto-save disabled, skipping');
      return;
    }

    // Clear countdown timer
    if (autoSaveCountdownIntervalRef.current) {
      clearInterval(autoSaveCountdownIntervalRef.current);
      autoSaveCountdownIntervalRef.current = null;
    }
    setAutoSaveCountdown(null);

    // Get the most current content from the editor state
    const currentEditorContent = editedProposedContentRef.current || editedProposedContent;
    const currentContent = submission.proposedVersions?.richTextContent || submission.richTextContent || submission.content || '';
    const hasActualChanges = currentEditorContent !== currentContent;
    
    console.log('💾 Auto-save check:', {
      currentEditorContentLength: currentEditorContent?.length || 0,
      currentContentLength: currentContent?.length || 0,
      hasActualChanges,
      editedProposedContentLength: editedProposedContent?.length || 0,
      hasChangesInCurrentPeriod: hasChangesInCurrentPeriodRef.current
    });
    
    if (!hasActualChanges) {
      console.log('🔄 No changes detected, skipping auto-save');
      setAutoSaveStatus('idle');
      // Reset auto-save period tracking
      hasChangesInCurrentPeriodRef.current = false;
      autoSavePeriodStartContentRef.current = '';
      autoSavePeriodStartTimeRef.current = null;
      return;
    }

    console.log('💾 Performing auto-save with current content...');
    setAutoSaveStatus('saving');

    // Create a consolidated tracked change for this auto-save period
    if (hasChangesInCurrentPeriodRef.current && autoSavePeriodStartContentRef.current) {
      const periodStartContent = autoSavePeriodStartContentRef.current;
      const periodStartTime = autoSavePeriodStartTimeRef.current;
      
      // Create a single consolidated change for the entire auto-save period
      const periodStartText = getDisplayableText(periodStartContent);
      const currentText = getDisplayableText(currentEditorContent);
      
      if (periodStartText !== currentText) {
        const consolidatedChange: Change = {
          id: `autosave-${Date.now()}`,
          field: 'content' as const,
          oldValue: periodStartText,
          newValue: currentText,
          changedBy: currentUser.id,
          timestamp: periodStartTime || new Date(),
          isIncremental: false, // This is a consolidated change, not incremental
          richTextOldValue: periodStartContent,
          richTextNewValue: currentEditorContent
        };
        
        console.log('📝 Creating consolidated tracked change for auto-save period:', {
          changeId: consolidatedChange.id,
          oldLength: periodStartText.length,
          newLength: currentText.length,
          periodDuration: periodStartTime ? new Date().getTime() - periodStartTime.getTime() : 0
        });
        
        // Add the consolidated change to the tracked changes sidebar
        onSuggestion(consolidatedChange);
      }
      
      // Reset auto-save period tracking
      hasChangesInCurrentPeriodRef.current = false;
      autoSavePeriodStartContentRef.current = '';
      autoSavePeriodStartTimeRef.current = null;
    }
    
    try {
      // Create the updated submission using the current editor content
      const updatedSubmission = {
        ...submission,
        proposedVersions: {
          ...submission.proposedVersions,
          richTextContent: currentEditorContent,
          lastModified: new Date().toISOString(),
          lastModifiedBy: currentUser.id || currentUser.email
        }
      };
      
      // Send WebSocket notification with lexical updates
      if (webSocketClientRef.current) {
        const updateMessage = {
          type: 'content_updated' as const,
          data: {
            field: 'proposedVersions.richTextContent',
            oldValue: currentContent,
            newValue: currentEditorContent,
            lexicalContent: currentEditorContent,
            isAutoSave: true,
            timestamp: new Date().toISOString(),
            changeSummary: generateChangeSummary(currentContent, currentEditorContent),
            // Include current cursor/selection position for other users
            cursorPosition: lastCursorPositionRef.current,
            preserveEditingState: true // Flag to help other users maintain their editing state
          }
        };
        
        console.log('📡 Sending WebSocket update for auto-save:', updateMessage);
        if (webSocketClientRef.current) {
          try {
            webSocketClientRef.current.send(updateMessage);
          } catch (error) {
            console.error('❌ Failed to send WebSocket update for auto-save:', error);
          }
        } else {
          console.log('⚠️ Cannot send WebSocket update - client not available');
        }
      }
      
      console.log('🔍 Auto-save about to call onSave with content details:', {
        richTextContentLength: updatedSubmission.proposedVersions?.richTextContent?.length,
        richTextContentIsLexical: isLexicalJson(updatedSubmission.proposedVersions?.richTextContent || ''),
        richTextContentPreview: updatedSubmission.proposedVersions?.richTextContent?.substring(0, 150)
      });
      
      // Call the save function
      await onSave(updatedSubmission);
      
      console.log('🔍 Auto-save onSave completed, content after save:', {
        currentEditorContentLength: currentEditorContent?.length,
        currentEditorContentIsLexical: isLexicalJson(currentEditorContent || ''),
        currentEditorContentPreview: currentEditorContent?.substring(0, 150)
      });
      
      // Update state with the content that was actually saved
      setLastSavedProposedContent(currentEditorContent);
      setEditedProposedContent(currentEditorContent); // Ensure state is in sync
      setAutoSaveStatus('saved');
      setLastAutoSaveTime(new Date());
      
      console.log('✅ Auto-save completed successfully');
      
      // Reset auto-save period tracking after successful save
      hasChangesInCurrentPeriodRef.current = false;
      autoSavePeriodStartContentRef.current = '';
      autoSavePeriodStartTimeRef.current = null;
      
      // Reset to idle after 3 seconds
      setTimeout(() => {
        setAutoSaveStatus('idle');
      }, 3000);
      
    } catch (error) {
      console.error('❌ Auto-save failed:', error);
      setAutoSaveStatus('error');
      
      // Reset auto-save period tracking on error (changes will be tracked again on next edit)
      hasChangesInCurrentPeriodRef.current = false;
      autoSavePeriodStartContentRef.current = '';
      autoSavePeriodStartTimeRef.current = null;
      
      // Reset to idle after 5 seconds
      setTimeout(() => {
        setAutoSaveStatus('idle');
      }, 5000);
    }
  }, [editedProposedContent, submission, currentUser.id, currentUser.email, onSave, getDisplayableText, onSuggestion]);

  // Generate a summary of changes for WebSocket notifications
  const generateChangeSummary = useCallback((oldContent: string, newContent: string) => {
    const oldText = getDisplayableText(oldContent);
    const newText = getDisplayableText(newContent);
    
    if (oldText === newText) {
      return 'No text changes';
    }
    
    const wordDiff = smartDiff(oldText, newText);
    const additions = wordDiff.filter(d => d.type === 'insert').length;
    const deletions = wordDiff.filter(d => d.type === 'delete').length;
    
    if (additions > 0 && deletions > 0) {
      return `Modified content (+${additions} additions, -${deletions} deletions)`;
    } else if (additions > 0) {
      return `Added content (+${additions} additions)`;
    } else if (deletions > 0) {
      return `Removed content (-${deletions} deletions)`;
    } else {
      return 'Content updated';
    }
  }, [getDisplayableText]);

  // Send real-time character-by-character updates
  const sendRealTimeUpdate = useCallback((content: string, cursorPosition?: any) => {
    console.log('🚀 sendRealTimeUpdate called:', {
      hasContent: !!content,
      contentLength: content?.length,
      hasWebSocketClient: !!webSocketClientRef.current,
      hasCursorPosition: !!cursorPosition,
      contentPreview: content?.substring(0, 100)
    });

    if (!webSocketClientRef.current) {
      console.log('⚠️ Cannot send real-time update: WebSocket not connected');
      return;
    }

    // Ensure we're sending valid Lexical JSON content
    if (!content || !isLexicalJson(content)) {
      console.error('❌ Cannot send real-time update: Invalid Lexical content:', {
        hasContent: !!content,
        contentType: typeof content,
        isLexicalJson: content ? isLexicalJson(content) : false,
        contentPreview: content?.substring(0, 200)
      });
      return;
    }

    // Extract plain text for the content field (for backwards compatibility)
    const plainTextContent = getDisplayableText(content);

    const updateMessage = {
      type: 'realtime_content_update' as const,
      data: {
        content: plainTextContent, // Plain text for display/compatibility
        lexicalContent: content,   // Full Lexical JSON for editor updates
        cursorPosition: cursorPosition || lastCursorPositionRef.current,
        timestamp: new Date().toISOString(),
        userId: effectiveUserId,
        userName: currentUser.name || currentUser.email,
        isRealTime: true
      }
    };

    console.log('📤 About to send real-time update message:', {
      messageType: updateMessage.type,
      plainTextLength: plainTextContent.length,
      lexicalContentLength: content.length,
      userId: updateMessage.data.userId,
      userName: updateMessage.data.userName,
      hasCursorPosition: !!updateMessage.data.cursorPosition
    });

    try {
      webSocketClientRef.current.send(updateMessage);
      console.log('✅ Successfully sent real-time update:', {
        contentLength: plainTextContent.length,
        lexicalContentLength: content.length,
        hasCursorPosition: !!updateMessage.data.cursorPosition,
        isValidLexical: isLexicalJson(content)
      });
    } catch (error) {
      console.error('❌ Failed to send real-time update:', error);
    }
  }, [effectiveUserId, currentUser.name, currentUser.email, getDisplayableText]);

  // Throttled real-time update sender (sends updates every 150ms max)
  const throttledRealTimeUpdate = useCallback((content: string, cursorPosition?: any) => {
    console.log('⏱️ throttledRealTimeUpdate called:', {
      hasContent: !!content,
      contentLength: content?.length,
      isApplyingRealTimeUpdate: isApplyingRealTimeUpdateRef.current,
      isPendingUpdate: pendingRealTimeUpdateRef.current,
      hasCursorPosition: !!cursorPosition
    });

    // Skip if we're applying a real-time update
    if (isApplyingRealTimeUpdateRef.current) {
      console.log('🔄 Skipping throttled real-time update - applying remote update');
      return;
    }
    
    // Store the latest content and cursor position
    lastRealTimeUpdateRef.current = content;
    lastCursorPositionRef.current = cursorPosition;
    
    // If we're not already pending an update, schedule one
    if (!pendingRealTimeUpdateRef.current) {
      console.log('⏰ Scheduling real-time update in 150ms...');
      pendingRealTimeUpdateRef.current = true;
      
      realTimeUpdateTimeoutRef.current = setTimeout(() => {
        console.log('⏰ Real-time update timeout triggered');
        
        // Double-check we're not applying a remote update before sending
        if (isApplyingRealTimeUpdateRef.current) {
          console.log('🔄 Skipping scheduled real-time update - applying remote update');
          pendingRealTimeUpdateRef.current = false;
          return;
        }
        
        console.log('📤 Executing scheduled real-time update');
        // Send the most recent content
        sendRealTimeUpdate(lastRealTimeUpdateRef.current, lastCursorPositionRef.current);
        pendingRealTimeUpdateRef.current = false;
      }, 150); // 150ms throttle - fast enough to feel real-time but not overwhelming
    } else {
      console.log('⏰ Real-time update already pending, updating content for next send');
    }
  }, [sendRealTimeUpdate]);

  // Debounced auto-save (7 seconds after typing stops) with countdown timer
  const scheduleAutoSave = useCallback(() => {
    if (!isAutoSaveEnabledRef.current) {
      console.log('🚫 Auto-save disabled, not scheduling');
      return;
    }

    // Clear existing timeout and countdown
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
      console.log('🔄 Cleared previous auto-save timeout');
    }
    
    if (autoSaveCountdownIntervalRef.current) {
      clearInterval(autoSaveCountdownIntervalRef.current);
      autoSaveCountdownIntervalRef.current = null;
    }
    
    // Set status to pending and start countdown
    setAutoSaveStatus('pending');
    setAutoSaveCountdown(7);
    
    // Start countdown timer
    autoSaveCountdownIntervalRef.current = setInterval(() => {
      setAutoSaveCountdown(prev => {
        if (prev === null || prev <= 1) {
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    
    // Schedule auto-save for 7 seconds later
    autoSaveTimeoutRef.current = setTimeout(() => {
      console.log('⏰ Auto-save timeout triggered');
      performAutoSave();
    }, 7000);
    
    console.log('⏰ Auto-save scheduled for 7 seconds with countdown...');
  }, [performAutoSave]);

  // Fallback auto-save check - ensures auto-save happens even if scheduling is missed
  useEffect(() => {
    if (!isAutoSaveEnabledRef.current) return;
    
    const fallbackInterval = setInterval(() => {
      const currentContent = submission.proposedVersions?.richTextContent || submission.richTextContent || submission.content || '';
      const hasChanges = editedProposedContent !== currentContent;
      const hasUnsavedChanges = editedProposedContent !== lastSavedProposedContent;
      
      // Only auto-save if there are changes and we're not already saving
      if (hasChanges && hasUnsavedChanges && autoSaveStatus === 'idle') {
        console.log('🔍 Fallback auto-save check detected unsaved changes');
        performAutoSave();
      }
    }, 10000); // Check every 10 seconds as fallback
    
    return () => clearInterval(fallbackInterval);
  }, [editedProposedContent, submission.proposedVersions?.richTextContent, submission.richTextContent, submission.content, lastSavedProposedContent, autoSaveStatus, performAutoSave]);

  // Handle incoming WebSocket updates
  const handleWebSocketUpdate = useCallback((message: WebSocketMessage) => {
    // Don't process our own updates
    if (message.userId === (currentUser.id || currentUser.email)) {
      console.log('📨 Ignoring own WebSocket update');
      return;
    }
    
    console.log('📨 TrackedChangesEditor: Received remote WebSocket update:', message);
    
    // Handle real-time content updates (character-by-character)
    if (message.type === 'realtime_content_update' && message.data) {
      const { content, lexicalContent, cursorPosition, isRealTime, userId, userName } = message.data;
      
      console.log('⚡ TrackedChangesEditor: Processing real-time update from', userName, {
        contentLength: content?.length,
        lexicalContentLength: lexicalContent?.length,
        hasCursorPosition: !!cursorPosition,
        isRealTime,
        lexicalContentType: typeof lexicalContent,
        isLexicalJson: lexicalContent ? isLexicalJson(lexicalContent) : false,
        lexicalPreview: lexicalContent?.substring(0, 200)
      });
      
      // Ensure we have valid Lexical content
      if (!lexicalContent || !isLexicalJson(lexicalContent)) {
        console.error('❌ TrackedChangesEditor: Invalid Lexical content in real-time update:', {
          hasLexicalContent: !!lexicalContent,
          lexicalContentType: typeof lexicalContent,
          isLexicalJson: lexicalContent ? isLexicalJson(lexicalContent) : false
        });
        return; // Skip invalid content
      }
      
      // Apply the real-time update immediately
      // Try to use the specialized real-time update function first
      if (webSocketClientRef.current && webSocketClientRef.current.applyRealTimeUpdate) {
        console.log('⚡ TrackedChangesEditor: Applying real-time update via specialized function');
        try {
          // Set flag to prevent feedback loop
          isApplyingRealTimeUpdateRef.current = true;
          
          webSocketClientRef.current.applyRealTimeUpdate(lexicalContent);
          
          // Update our state to match
          setEditedProposedContent(lexicalContent);
          
          // Show brief visual feedback
          setRemoteUpdateStatus('applied');
          setTimeout(() => {
            setRemoteUpdateStatus('none');
          }, 1000);
          
          console.log('✅ TrackedChangesEditor: Real-time update applied successfully via specialized function');
          
          // Reset flag after a short delay to ensure the change event is processed
          setTimeout(() => {
            isApplyingRealTimeUpdateRef.current = false;
          }, 100);
        } catch (error) {
          console.error('❌ TrackedChangesEditor: Error applying real-time update via specialized function:', error);
          isApplyingRealTimeUpdateRef.current = false;
        }
      } else if (remoteUpdateFunctionRef.current) {
        console.log('⚡ TrackedChangesEditor: Applying real-time update via fallback remote update function');
        try {
          // Set flag to prevent feedback loop
          isApplyingRealTimeUpdateRef.current = true;
          
          remoteUpdateFunctionRef.current(lexicalContent);
          
          // Update our state to match
          setEditedProposedContent(lexicalContent);
          
          // Show brief visual feedback
          setRemoteUpdateStatus('applied');
          setTimeout(() => {
            setRemoteUpdateStatus('none');
          }, 1000);
          
          console.log('✅ TrackedChangesEditor: Real-time update applied successfully via fallback function');
          
          // Reset flag after a short delay to ensure the change event is processed
          setTimeout(() => {
            isApplyingRealTimeUpdateRef.current = false;
          }, 100);
        } catch (error) {
          console.error('❌ TrackedChangesEditor: Error applying real-time update via fallback function:', error);
          isApplyingRealTimeUpdateRef.current = false;
        }
      } else {
        console.log('⚠️ TrackedChangesEditor: No remote update function available for real-time update');
        // Fallback to state update - but only if we have valid Lexical content
        if (lexicalContent && isLexicalJson(lexicalContent)) {
          // Set flag to prevent feedback loop
          isApplyingRealTimeUpdateRef.current = true;
          
          setEditedProposedContent(lexicalContent);
          console.log('✅ TrackedChangesEditor: Applied real-time update via state fallback');
          
          // Reset flag after a short delay
          setTimeout(() => {
            isApplyingRealTimeUpdateRef.current = false;
          }, 100);
        } else {
          console.error('❌ TrackedChangesEditor: Cannot apply real-time update - invalid Lexical content');
        }
      }
      
      return; // Exit early for real-time updates
    }
    
    // Handle regular content updates (auto-save, manual save)
    if (message.type === 'content_updated' && message.data) {
      const { field, newValue, lexicalContent, isAutoSave, cursorPosition, preserveEditingState } = message.data;
      
      if (field === 'proposedVersions.richTextContent' && lexicalContent) {
        console.log('🔄 TrackedChangesEditor: Processing remote lexical update...', {
          isAutoSave,
          preserveEditingState,
          hasCursorPosition: !!cursorPosition,
          hasRemoteUpdateFunction: !!remoteUpdateFunctionRef.current,
          lexicalContentLength: lexicalContent?.length
        });
        
        // More intelligent handling of when to apply updates
        const now = Date.now();
        const timeSinceLastAutoSave = lastAutoSaveTime ? now - lastAutoSaveTime.getTime() : Infinity;
        
        // Determine if the user is actively editing
        const isActivelyEditing = timeSinceLastAutoSave < 15000; // 15 seconds since last auto-save
        const shouldPreserveEditing = preserveEditingState && isActivelyEditing;
        
        if (!shouldPreserveEditing) {
          console.log('🔄 TrackedChangesEditor: Applying remote update (user not actively editing)');
          
          // Show visual feedback that a remote update is being applied
          setRemoteUpdateStatus('applying');
          
          // Apply the content update through the CollaborativeEditor
          if (remoteUpdateFunctionRef.current) {
            console.log('🔄 TrackedChangesEditor: Triggering editor update via remote update function');
            try {
              remoteUpdateFunctionRef.current(lexicalContent);
              console.log('✅ TrackedChangesEditor: Remote update function called successfully');
            } catch (error) {
              console.error('❌ TrackedChangesEditor: Error calling remote update function:', error);
            }
          } else {
            console.log('⚠️ TrackedChangesEditor: No remote update function available, falling back to state update');
            setEditedProposedContent(lexicalContent);
          }
          
          // Also update our state
          setEditedProposedContent(lexicalContent);
          setLastSavedProposedContent(lexicalContent);
          
          // If the update included cursor position information, we can use it
          // to better position other users' cursors
          if (cursorPosition) {
            console.log('📍 TrackedChangesEditor: Remote update includes cursor position:', cursorPosition);
            // The CollaborativeEditor will handle cursor positioning
          }
          
          // Show applied status briefly
          setRemoteUpdateStatus('applied');
          setTimeout(() => {
            setRemoteUpdateStatus('none');
          }, 2000);
          
          // Show a notification about the update
          if (onRefreshNeeded) {
            onRefreshNeeded();
          }
        } else {
          console.log('⚠️ TrackedChangesEditor: User is actively editing, deferring remote update');
          
          // In a production system, you would:
          // 1. Queue this update for later application
          // 2. Use operational transforms to merge changes
          // 3. Show a notification that updates are pending
          
          // For now, we'll just log and potentially show a warning
          console.log('💾 TrackedChangesEditor: Remote changes available but deferred due to active editing');
        }
      }
    }
  }, [currentUser.id, currentUser.email, lastAutoSaveTime, onRefreshNeeded]);

  // Store WebSocket client reference
  const handleWebSocketClientRef = useCallback((client: any) => {
    console.log('🔗 handleWebSocketClientRef called with client:', {
      hasClient: !!client,
      clientType: typeof client,
      clientConnected: client?.isConnected
    });

    webSocketClientRef.current = client;
    
    if (client) {
      console.log('🔌 Setting up WebSocket event listeners...');
      
      // Listen for content updates
      client.on('content_updated', handleWebSocketUpdate);
      console.log('👂 Listening for content_updated messages');
      
      // Listen for real-time content updates (character-by-character)
      client.on('realtime_content_update', handleWebSocketUpdate);
      console.log('👂 Listening for realtime_content_update messages');
      
      // Listen for cursor position updates to track current user's position
      client.on('cursor_position', (message: any) => {
        if (message.userId === (currentUser.id || currentUser.email)) {
          // Store our own cursor position for use in auto-save messages
          lastCursorPositionRef.current = message.data;
          console.log('📍 Updated current user cursor position:', message.data);
        }
      });
      console.log('👂 Listening for cursor_position messages');
      
      console.log('✅ WebSocket client fully connected for auto-save, real-time sync, and cursor tracking');
      
      // Test the WebSocket connection
      if (client.isConnected) {
        console.log('🧪 WebSocket client reports as connected, testing send functionality');
      } else {
        console.log('⚠️ WebSocket client reports as not connected');
      }
    } else {
      console.log('❌ No WebSocket client provided to handleWebSocketClientRef');
    }
  }, [handleWebSocketUpdate, currentUser.id, currentUser.email]);

  // Cleanup auto-save timeout on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
      if (autoSaveCountdownIntervalRef.current) {
        clearInterval(autoSaveCountdownIntervalRef.current);
      }
      if (realTimeUpdateTimeoutRef.current) {
        clearTimeout(realTimeUpdateTimeoutRef.current);
      }
      if (realTimeUpdateIntervalRef.current) {
        clearInterval(realTimeUpdateIntervalRef.current);
      }
      
      // Reset auto-save period tracking on unmount
      hasChangesInCurrentPeriodRef.current = false;
      autoSavePeriodStartContentRef.current = '';
      autoSavePeriodStartTimeRef.current = null;
    };
  }, []);

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
      
      // Real-time comment replies are now handled by CollaborativeEditor
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
            className="btn btn-sm btn-tertiary reply-button"
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
                className="btn btn-sm btn-neutral"
                onClick={() => {
                  setReplyToComment(null);
                  setReplyText('');
                }}
              >
                Cancel
              </button>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => handleCommentReply(comment.id)}
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

  const createTrackedChangeWithContext = useCallback((
    oldValue: string,
    newValue: string,
    changeType: 'add' | 'remove' | 'modify',
    context: string
  ) => {
    const trackedChange = {
      id: Date.now().toString(),
      oldValue,
      newValue,
      changeType,
      isIncremental: false,
      willUpdateEditedContent: true,
      context
    };

    console.log('📋 Creating tracked change:', trackedChange);

    // Always update the edited content for collaborative editing
    if (trackedChange.willUpdateEditedContent) {
      setEditedProposedContent(newValue);
    }

    return trackedChange;
  }, []);

  const proposedEditorContent = useMemo(() => {
    const content = submission.proposedVersions?.richTextContent || 
                   submission.proposedVersions?.content || 
                   submission.richTextContent || 
                   submission.content || '';
    
    console.log('📝 proposedEditorContent: Content source analysis:', {
      hasProposedVersionsRichTextContent: !!submission.proposedVersions?.richTextContent,
      proposedVersionsRichTextContentLength: submission.proposedVersions?.richTextContent?.length,
      proposedVersionsRichTextContentType: typeof submission.proposedVersions?.richTextContent,
      proposedVersionsRichTextContentIsLexical: submission.proposedVersions?.richTextContent ? isLexicalJson(submission.proposedVersions.richTextContent) : false,
      proposedVersionsRichTextContentPreview: submission.proposedVersions?.richTextContent?.substring(0, 100),
      
      hasProposedVersionsContent: !!submission.proposedVersions?.content,
      proposedVersionsContentLength: submission.proposedVersions?.content?.length,
      proposedVersionsContentType: typeof submission.proposedVersions?.content,
      proposedVersionsContentIsLexical: submission.proposedVersions?.content ? isLexicalJson(submission.proposedVersions.content) : false,
      proposedVersionsContentPreview: submission.proposedVersions?.content?.substring(0, 100),
      
      hasRichTextContent: !!submission.richTextContent,
      richTextContentLength: submission.richTextContent?.length,
      richTextContentType: typeof submission.richTextContent,
      richTextContentIsLexical: submission.richTextContent ? isLexicalJson(submission.richTextContent) : false,
      richTextContentPreview: submission.richTextContent?.substring(0, 100),
      
      hasContent: !!submission.content,
      contentLength: submission.content?.length,
      contentType: typeof submission.content,
      contentIsLexical: submission.content ? isLexicalJson(submission.content) : false,
      contentPreview: submission.content?.substring(0, 100),
      
      finalContentLength: content?.length,
      finalContentType: typeof content,
      finalContentIsLexical: content ? isLexicalJson(content) : false,
      finalContentPreview: content?.substring(0, 100)
    });
    
    // Pass the content directly to the CollaborativeEditor
    // The CollaborativeEditor will handle the proper conversion based on content type:
    // - Lexical JSON: use as-is
    // - HTML: parse and preserve formatting
    // - Plain text: create proper paragraph structure
    let result = content;
    
    // If content is empty, provide a default
    if (!result || result.trim() === '') {
      result = 'Start typing your content here...';
    }
    
    console.log('📝 proposedEditorContent result:', {
      resultLength: result?.length,
      resultType: typeof result,
      resultPreview: result?.substring(0, 200),
      isLexicalJson: isLexicalJson(result),
      isHtml: typeof result === 'string' && result.trim().startsWith('<') && !isLexicalJson(result)
    });
    
    return result;
  }, [submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, submission.richTextContent, submission.content]);

  return (
    <div className="tracked-changes-editor">
      {/* Collaborative Editor handles its own WebSocket status and user presence */}

      <div className="editor-toolbar">
        <div className="toolbar-left">
          <span className="toolbar-label">Viewing:</span>
          <span className="toolbar-value">
            Proposed version with tracked changes
          </span>
        </div>
        <div className="toolbar-right">
          <div className="auto-save-status">
            {/* Remote update status */}
            {remoteUpdateStatus === 'applying' && (
              <span className="save-status applying">
                🔄 Applying remote changes...
              </span>
            )}
            {remoteUpdateStatus === 'applied' && (
              <span className="save-status applied">
                ✅ Remote changes applied
              </span>
            )}
            
            {/* Auto-save status with countdown */}
            {autoSaveStatus === 'pending' && remoteUpdateStatus === 'none' && (
              <span className="save-status pending">
                ⏰ Auto-save in {autoSaveCountdown}s...
              </span>
            )}
            {autoSaveStatus === 'saving' && (
              <span className="save-status saving">
                💾 Saving...
              </span>
            )}
            {autoSaveStatus === 'saved' && remoteUpdateStatus === 'none' && (
              <span className="save-status saved">
                ✅ Saved{lastAutoSaveTime && ` at ${lastAutoSaveTime.toLocaleTimeString()}`}
              </span>
            )}
            {autoSaveStatus === 'error' && (
              <span className="save-status error">
                ❌ Save failed
              </span>
            )}
            
            {/* Manual save button */}
            <button
              className="btn btn-sm btn-primary manual-save-button"
              onClick={() => {
                console.log('💾 Manual save requested');
                
                // Cancel auto-save and perform immediate save
                if (autoSaveTimeoutRef.current) {
                  clearTimeout(autoSaveTimeoutRef.current);
                }
                if (autoSaveCountdownIntervalRef.current) {
                  clearInterval(autoSaveCountdownIntervalRef.current);
                  autoSaveCountdownIntervalRef.current = null;
                }
                setAutoSaveCountdown(null);
                
                performAutoSave();
              }}
              disabled={autoSaveStatus === 'saving' || editedProposedContent === lastSavedProposedContent}
              title="Save changes now"
            >
              💾 Save Now
            </button>
          </div>
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
          
          <div className="document-body">
            {/* Always show proposed version at the top */}
            <div className="proposed-version-section">
              <div className="section-header">
                <h2 className="section-title">Proposed Version</h2>
                <div className="section-actions">
                  {canApproveProposedVersion() && !isProposedVersionApproved && (
                    <button
                      className="btn btn-primary approve-button"
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
                </div>
              </div>
              <div className="proposed-content">
                <div className="rich-text-editor-container">
                  <CollaborativeEditor
                    key="proposed-collaborative-editor"
                    documentId={submission.id}
                    currentUser={currentUser}
                    initialContent={proposedEditorContent}
                    onContentChange={(json, cursorPosition) => {
                      // Skip processing if we're still initializing content to prevent auto-save on load
                      if (!hasInitializedContentRef.current) {
                        console.log('🚫 Skipping content change during initialization');
                        return;
                      }
                      
                      setEditedProposedContent(json);
                      console.log('📝 Proposed editor content changed:', {
                        contentLength: json.length,
                        isLexical: isLexicalJson(json),
                        hasCursorPosition: !!cursorPosition
                      });
                      
                      // Send real-time character-by-character updates immediately
                      const originalContent = submission.proposedVersions?.richTextContent || submission.richTextContent || submission.content || '';
                      const hasChanges = json !== originalContent;
                      const hasChangesFromLastSaved = json !== lastSavedProposedContent;
                      
                      console.log('📝 Content change analysis:', {
                        hasChanges,
                        hasChangesFromLastSaved,
                        jsonLength: json?.length || 0,
                        originalContentLength: originalContent?.length || 0,
                        lastSavedLength: lastSavedProposedContent?.length || 0,
                        autoSaveStatus
                      });
                      
                      if (hasChanges) {
                        // Check if we're applying a real-time update to prevent feedback loops
                        if (isApplyingRealTimeUpdateRef.current) {
                          console.log('🔄 Skipping real-time update - applying remote update');
                        } else {
                          console.log('⚡ Content has changes, sending real-time update');
                          
                          // Send immediate real-time update with cursor position
                          throttledRealTimeUpdate(json, cursorPosition);
                        }
                        
                                              if (hasChangesFromLastSaved) {
                        console.log('📝 Content has changes from last saved, scheduling auto-save');
                        
                        // Start tracking the auto-save period if not already started
                        if (!hasChangesInCurrentPeriodRef.current) {
                          console.log('🔄 Starting new auto-save period tracking');
                          hasChangesInCurrentPeriodRef.current = true;
                          autoSavePeriodStartContentRef.current = originalContent;
                          autoSavePeriodStartTimeRef.current = new Date();
                        }
                        
                        // Schedule auto-save (7 seconds after typing stops)
                        scheduleAutoSave();
                        
                        // Note: Individual character changes are no longer created here
                        // They will be consolidated into a single change during auto-save
                        console.log('📝 Changes being tracked for consolidation in auto-save period');
                      }
                      } else if (!hasChangesFromLastSaved) {
                        console.log('📝 Content matches last saved version, no auto-save needed');
                      } else {
                        console.log('📝 Content change detected but no action needed');
                      }
                    }}
                    onSave={(content) => {
                      console.log('💾 Save button clicked with content:', content);
                      // Update the edited content with the saved content
                      setEditedProposedContent(content);
                      
                      // Cancel auto-save since user is manually saving
                      if (autoSaveTimeoutRef.current) {
                        clearTimeout(autoSaveTimeoutRef.current);
                      }
                      if (autoSaveCountdownIntervalRef.current) {
                        clearInterval(autoSaveCountdownIntervalRef.current);
                        autoSaveCountdownIntervalRef.current = null;
                      }
                      setAutoSaveCountdown(null);
                      setAutoSaveStatus('saving');
                      
                      handleProposedEditSubmit();
                    }}
                    onWebSocketClientReady={handleWebSocketClientRef}
                    onRemoteContentUpdate={(updateFn) => {
                      remoteUpdateFunctionRef.current = updateFn;
                      console.log('🔗 Remote update function registered');
                    }}
                    placeholder="Edit the proposed version..."
                    readOnly={false}
                    showToolbar={true}
                    className="proposed-collaborative-editor"
                    useSubmissionWebSocket={true}
                  />
                </div>
              </div>
            </div>

            {/* Always show diff with tracked changes below */}
            <div className="diff-section">
              <h2 className="section-title">Content Comparison</h2>
              <div className="diff-content">
                {(() => {
                  // Get the original and proposed content for comparison
                  const originalContent = submission.richTextContent || submission.content || '';
                  const proposedContent = editedProposedContent || submission.proposedVersions?.richTextContent || submission.richTextContent || submission.content || '';
                  
                  const originalText = getDisplayableText(originalContent);
                  const proposedText = getDisplayableText(proposedContent);
                  
                  // Extract images from both versions
                  const originalImages = extractImagesFromLexical(originalContent);
                  const proposedImages = extractImagesFromLexical(proposedContent);
                  
                  // Check if content is the same (text and images)
                  const textSame = originalText === proposedText;
                  const imagesSame = JSON.stringify(originalImages) === JSON.stringify(proposedImages);
                  
                  if (textSame && imagesSame) {
                    return (
                      <div className="no-changes">
                        <p>No changes detected between original and proposed versions.</p>
                      </div>
                    );
                  }
                  
                  // Generate word-level diff for text
                  const diff = smartDiff(originalText, proposedText);
                  
                  // Compare images
                  const addedImages = proposedImages.filter(pImg => 
                    !originalImages.some(oImg => oImg.src === pImg.src)
                  );
                  const removedImages = originalImages.filter(oImg => 
                    !proposedImages.some(pImg => pImg.src === oImg.src)
                  );
                  const unchangedImages = originalImages.filter(oImg => 
                    proposedImages.some(pImg => pImg.src === oImg.src)
                  );
                  
                  return (
                    <div className="diff-comparison">
                      <div className="diff-legend">
                        <span className="legend-item">
                          <span className="legend-color unchanged"></span> Unchanged
                        </span>
                        <span className="legend-item">
                          <span className="legend-color added"></span> Added
                        </span>
                        <span className="legend-item">
                          <span className="legend-color removed"></span> Removed
                        </span>
                      </div>
                      
                      <div className="diff-view">
                        <div className="diff-column">
                          <h4>Original Version</h4>
                          <div className="diff-text" ref={originalDiffTextRef}>
                            {/* Text content */}
                            {diff.map((segment, index) => {
                              if (segment.type === 'delete' || segment.type === 'equal') {
                                return (
                                  <span
                                    key={index}
                                    className={`diff-segment ${segment.type === 'delete' ? 'removed' : 'unchanged'}`}
                                  >
                                    {segment.value}
                                  </span>
                                );
                              }
                              return null;
                            })}
                            
                            {/* Images */}
                            <div className="diff-images">
                              {unchangedImages.map(image => renderImageInDiff(image, 'unchanged'))}
                              {removedImages.map(image => renderImageInDiff(image, 'removed'))}
                            </div>
                          </div>
                        </div>
                        
                        <div className="diff-column">
                          <h4>Proposed Version</h4>
                          <div className="diff-text" ref={proposedDiffTextRef}>
                            {/* Text content */}
                            {diff.map((segment, index) => {
                              if (segment.type === 'insert' || segment.type === 'equal') {
                                return (
                                  <span
                                    key={index}
                                    className={`diff-segment ${segment.type === 'insert' ? 'added' : 'unchanged'}`}
                                  >
                                    {segment.value}
                                  </span>
                                );
                              }
                              return null;
                            })}
                            
                            {/* Images */}
                            <div className="diff-images">
                              {unchangedImages.map(image => renderImageInDiff(image, 'unchanged'))}
                              {addedImages.map(image => renderImageInDiff(image, 'added'))}
                            </div>
                          </div>
                        </div>
                      </div>
                      
                      {/* Unified diff view */}
                      <div className="unified-diff">
                        <h4>Unified Diff View</h4>
                        <div className="unified-diff-content">
                          {/* Text changes */}
                          {diff.map((segment, index) => (
                            <span
                              key={index}
                              className={`diff-segment ${segment.type}`}
                            >
                              {segment.type === 'delete' && <span className="diff-marker">-</span>}
                              {segment.type === 'insert' && <span className="diff-marker">+</span>}
                              {segment.value}
                            </span>
                          ))}
                          
                          {/* Image changes */}
                          <div className="unified-diff-images">
                            {removedImages.map(image => (
                              <div key={`removed-${image.src}`} className="unified-diff-image removed">
                                <span className="diff-marker">-</span>
                                {renderImageInDiff(image, 'removed')}
                              </div>
                            ))}
                            {addedImages.map(image => (
                              <div key={`added-${image.src}`} className="unified-diff-image added">
                                <span className="diff-marker">+</span>
                                {renderImageInDiff(image, 'added')}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Always show original version at the bottom */}
            <div className="original-version-section">
              <h2 className="section-title">Original Version</h2>
              <div className="original-content">
                <div className="rich-text-display">
                  <LexicalEditorComponent
                    key="original-display-editor"
                    initialContent={getRichTextContent(submission.richTextContent || submission.content || '')}
                    readOnly={true}
                    showToolbar={false}
                    className="original-display-editor"
                  />
                </div>
              </div>
            </div>
          </div>
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
                        className="btn btn-icon btn-sm btn-secondary action-button approve"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleChangeDecision(change.id, 'approve');
                        }}
                        title="Approve this change"
                        disabled={change.status !== 'pending'}
                        style={{ 
                          opacity: change.status !== 'pending' ? 0.4 : 1
                        }}
                      >
                        ✓
                      </button>
                      <button
                        className="btn btn-icon btn-sm btn-danger action-button reject"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleChangeDecision(change.id, 'reject');
                        }}
                        title="Reject this change"
                        disabled={change.status !== 'pending'}
                        style={{ 
                          opacity: change.status !== 'pending' ? 0.4 : 1
                        }}
                      >
                        ✗
                      </button>
                      {(change.status === 'approved' || change.status === 'rejected') && (
                        <button
                          className="btn btn-icon btn-sm btn-neutral action-button undo"
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
                    className="btn btn-icon btn-sm btn-tertiary action-button comment"
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
                        className="btn btn-icon btn-sm btn-neutral expand-comments-button"
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
              <button className="btn btn-neutral" onClick={() => setShowCommentDialog(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCommentSubmit}>
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
              <button className="btn btn-neutral" onClick={() => setShowSuggestionDialog(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSuggestionSubmit}>
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
              <button className="btn btn-neutral" onClick={() => setShowProposedVersionApprovalDialog(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleProposedVersionRejection}>
                Reject
              </button>
              <button className="btn btn-primary" onClick={handleProposedVersionApproval}>
                Approve
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};