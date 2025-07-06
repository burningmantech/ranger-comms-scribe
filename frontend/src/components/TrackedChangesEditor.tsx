import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ContentSubmission, User, Comment, Change, Approval } from '../types/content';
import { smartDiff, WordDiff, applyChanges, calculateIncrementalChanges } from '../utils/diffAlgorithm';
import { extractTextFromLexical, isLexicalJson } from '../utils/lexicalUtils';
import LexicalEditorComponent from './editor/LexicalEditor';
import { CollaborativeEditor } from './CollaborativeEditor';
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
  
  // Auto-save state
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle');
  const [lastAutoSaveTime, setLastAutoSaveTime] = useState<Date | null>(null);
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isAutoSaveEnabledRef = useRef(true);
  
  // Remote update state
  const [remoteUpdateStatus, setRemoteUpdateStatus] = useState<'none' | 'applying' | 'applied'>('none');
  
  // WebSocket client for sending updates
  const webSocketClientRef = useRef<any>(null);
  const lastCursorPositionRef = useRef<any>(null);
  const remoteUpdateFunctionRef = useRef<((content: string) => void) | null>(null);

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
    
    // If it's plain text, create a basic Lexical structure
    if (typeof content === 'string' && content.trim()) {
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
    
    // If content looks like a comment, skip it and use empty content
    if (typeof content === 'string' && content.includes('@change:')) {
      content = '';
    }
    
    const richTextContent = getRichTextContent(content);
    
    // Only update the edited content if we're not currently editing
    // This prevents overwriting user's changes while they're editing
    if (!false) {
      setEditedProposedContent(richTextContent);
    }
    
    // Update last saved content when submission changes (from parent)
    // Only update if we don't have local changes or if the submission has actually changed
    if (!lastSavedProposedContent || lastSavedProposedContent !== richTextContent) {
      setLastSavedProposedContent(richTextContent);
    }
    
    // Always update the initial content reference for fresh data
    // This ensures the editor gets the latest content when entering edit mode
    initialEditorContentRef.current = richTextContent;
  }, [submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, submission.richTextContent, submission.content, getRichTextContent]);

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
      editedContentPreview: editedProposedContent?.substring(0, 100)
    });
    
    if (!hasActualChanges) {
      console.log('No changes to submit');
      setAutoSaveStatus('idle');
      return;
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
      
      await onSave(updatedSubmission);
      
      // Update the last saved content after successful save
      setLastSavedProposedContent(editedProposedContent);
      setAutoSaveStatus('saved');
      setLastAutoSaveTime(new Date());
      
      // Reset to idle after 3 seconds
      setTimeout(() => {
        setAutoSaveStatus('idle');
      }, 3000);
      
    } catch (error) {
      console.error('❌ Save failed:', error);
      setAutoSaveStatus('error');
      
      // Reset to idle after 5 seconds
      setTimeout(() => {
        setAutoSaveStatus('idle');
      }, 5000);
    }
  }, [editedProposedContent, submission, onSave, currentUser.id, currentUser.email]);

  // Handle change decision (approve/reject)
  const handleChangeDecision = useCallback((changeId: string, decision: 'approve' | 'reject') => {
    if (decision === 'approve') {
      onApprove(changeId);
    } else {
      onReject(changeId);
    }
    
    // Real-time approvals are now handled by CollaborativeEditor
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

  // Auto-save functionality
  const performAutoSave = useCallback(async () => {
    if (!isAutoSaveEnabledRef.current) {
      console.log('🚫 Auto-save disabled, skipping');
      return;
    }

    // Get the most current content from the editor state
    const currentEditorContent = editedProposedContentRef.current || editedProposedContent;
    const currentContent = submission.proposedVersions?.richTextContent || submission.richTextContent || submission.content || '';
    const hasActualChanges = currentEditorContent !== currentContent;
    
    console.log('💾 Auto-save check:', {
      currentEditorContentLength: currentEditorContent?.length || 0,
      currentContentLength: currentContent?.length || 0,
      hasActualChanges,
      editedProposedContentLength: editedProposedContent?.length || 0
    });
    
    if (!hasActualChanges) {
      console.log('🔄 No changes detected, skipping auto-save');
      setAutoSaveStatus('idle');
      return;
    }

    console.log('💾 Performing auto-save with current content...');
    setAutoSaveStatus('saving');
    
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
        webSocketClientRef.current.send(updateMessage);
      }
      
      // Call the save function
      await onSave(updatedSubmission);
      
      // Update state with the content that was actually saved
      setLastSavedProposedContent(currentEditorContent);
      setEditedProposedContent(currentEditorContent); // Ensure state is in sync
      setAutoSaveStatus('saved');
      setLastAutoSaveTime(new Date());
      
      console.log('✅ Auto-save completed successfully');
      
      // Reset to idle after 3 seconds
      setTimeout(() => {
        setAutoSaveStatus('idle');
      }, 3000);
      
    } catch (error) {
      console.error('❌ Auto-save failed:', error);
      setAutoSaveStatus('error');
      
      // Reset to idle after 5 seconds
      setTimeout(() => {
        setAutoSaveStatus('idle');
      }, 5000);
    }
  }, [editedProposedContent, submission, currentUser.id, currentUser.email, onSave]);

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

  // Debounced auto-save (5 seconds after typing stops)
  const scheduleAutoSave = useCallback(() => {
    if (!isAutoSaveEnabledRef.current) {
      console.log('🚫 Auto-save disabled, not scheduling');
      return;
    }

    // Clear existing timeout
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
      console.log('🔄 Cleared previous auto-save timeout');
    }
    
    // Set status to pending
    setAutoSaveStatus('pending');
    
    // Schedule auto-save for 7 seconds later (increased to ensure last character is captured)
    autoSaveTimeoutRef.current = setTimeout(() => {
      console.log('⏰ Auto-save timeout triggered');
      performAutoSave();
    }, 7000);
    
    console.log('⏰ Auto-save scheduled for 7 seconds...');
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
      return;
    }
    
    console.log('📨 Received WebSocket update:', message);
    
    if (message.type === 'content_updated' && message.data) {
      const { field, newValue, lexicalContent, isAutoSave, cursorPosition, preserveEditingState } = message.data;
      
      if (field === 'proposedVersions.richTextContent' && lexicalContent) {
        console.log('🔄 Processing remote lexical update...', {
          isAutoSave,
          preserveEditingState,
          hasCursorPosition: !!cursorPosition
        });
        
        // More intelligent handling of when to apply updates
        const now = Date.now();
        const timeSinceLastAutoSave = lastAutoSaveTime ? now - lastAutoSaveTime.getTime() : Infinity;
        const timeSinceLastEdit = now - (Date.now()); // This will be updated with actual edit timestamp
        
        // Determine if the user is actively editing
        const isActivelyEditing = timeSinceLastAutoSave < 15000; // 15 seconds since last auto-save
        const shouldPreserveEditing = preserveEditingState && isActivelyEditing;
        
                 if (!shouldPreserveEditing) {
           console.log('🔄 Applying remote update (user not actively editing)');
           
           // Show visual feedback that a remote update is being applied
           setRemoteUpdateStatus('applying');
           
           // Store current cursor position before update
           const currentCursor = lastCursorPositionRef.current;
           
           // Apply the content update through the CollaborativeEditor
           if (remoteUpdateFunctionRef.current) {
             console.log('🔄 Triggering editor update via remote update function');
             remoteUpdateFunctionRef.current(lexicalContent);
           } else {
             console.log('⚠️ No remote update function available, falling back to state update');
             setEditedProposedContent(lexicalContent);
           }
           
           // Also update our state
           setEditedProposedContent(lexicalContent);
           setLastSavedProposedContent(lexicalContent);
           
           // If the update included cursor position information, we can use it
           // to better position other users' cursors
           if (cursorPosition) {
             console.log('📍 Remote update includes cursor position:', cursorPosition);
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
          console.log('⚠️ User is actively editing, deferring remote update');
          
          // In a production system, you would:
          // 1. Queue this update for later application
          // 2. Use operational transforms to merge changes
          // 3. Show a notification that updates are pending
          
          // For now, we'll just log and potentially show a warning
          console.log('💾 Remote changes available but deferred due to active editing');
        }
      }
    }
  }, [currentUser.id, currentUser.email, lastAutoSaveTime, onRefreshNeeded]);

  // Store WebSocket client reference
  const handleWebSocketClientRef = useCallback((client: any) => {
    webSocketClientRef.current = client;
    
    if (client) {
      // Listen for content updates
      client.on('content_updated', handleWebSocketUpdate);
      
      // Listen for cursor position updates to track current user's position
      client.on('cursor_position', (message: any) => {
        if (message.userId === (currentUser.id || currentUser.email)) {
          // Store our own cursor position for use in auto-save messages
          lastCursorPositionRef.current = message.data;
          console.log('📍 Updated current user cursor position:', message.data);
        }
      });
      
      console.log('🔌 WebSocket client connected for auto-save and cursor tracking');
    }
  }, [handleWebSocketUpdate, currentUser.id, currentUser.email]);

  // Cleanup auto-save timeout on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
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
    
    // For now, let's simplify by just passing the content directly
    // If it's already Lexical JSON, use it as-is
    // If it's plain text, pass it as plain text and let the editor handle it
    let result = content;
    
    // If content is empty, provide a default
    if (!result || result.trim() === '') {
      result = 'Start typing your content here...';
    }
    
    console.log('📝 Simplified proposedEditorContent result:', {
      resultLength: result?.length,
      resultType: typeof result,
      resultPreview: result?.substring(0, 200)
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
            
            {/* Auto-save status */}
            {autoSaveStatus === 'pending' && remoteUpdateStatus === 'none' && (
              <span className="save-status pending">
                ⏰ Auto-save in 7s...
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
              className="manual-save-button"
              onClick={() => {
                console.log('💾 Manual save requested');
                
                // Cancel auto-save and perform immediate save
                if (autoSaveTimeoutRef.current) {
                  clearTimeout(autoSaveTimeoutRef.current);
                }
                
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
                </div>
              </div>
              <div className="proposed-content">
                <div className="rich-text-editor-container">
                  <CollaborativeEditor
                    key="proposed-collaborative-editor"
                    documentId={submission.id}
                    currentUser={currentUser}
                    initialContent={proposedEditorContent}
                    onContentChange={(json) => {
                      setEditedProposedContent(json);
                      console.log('📝 Proposed editor content changed:', {
                        contentLength: json.length,
                        isLexical: isLexicalJson(json)
                      });
                      
                      // Auto-track changes as user types (debounced)
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
                      
                      if (hasChanges && hasChangesFromLastSaved) {
                        console.log('📝 Content has changes, scheduling auto-save');
                        
                        // Schedule auto-save (7 seconds after typing stops)
                        scheduleAutoSave();
                        
                        // Create a tracked change for real-time collaboration
                        const currentText = getDisplayableText(originalContent);
                        const newText = getDisplayableText(json);
                        
                        if (currentText !== newText) {
                          // Create incremental change for real-time tracking
                          const newChange = {
                            id: `change-${Date.now()}`,
                            field: 'content' as const,
                            oldValue: currentText,
                            newValue: newText,
                            changedBy: currentUser.id,
                            timestamp: new Date(),
                            isIncremental: true,
                            richTextOldValue: originalContent,
                            richTextNewValue: json
                          };
                          
                          console.log('📝 Created tracked change:', newChange);
                          // Note: In a real implementation, this would be sent to other users via WebSocket
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
                  const originalText = getDisplayableText(submission.richTextContent || submission.content || '');
                  const proposedText = getDisplayableText(editedProposedContent || submission.proposedVersions?.richTextContent || submission.richTextContent || submission.content || '');
                  
                  // If content is the same, show no changes message
                  if (originalText === proposedText) {
                    return (
                      <div className="no-changes">
                        <p>No changes detected between original and proposed versions.</p>
                      </div>
                    );
                  }
                  
                  // Generate word-level diff
                  const diff = smartDiff(originalText, proposedText);
                  
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
                          <div className="diff-text">
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
                          </div>
                        </div>
                        
                        <div className="diff-column">
                          <h4>Proposed Version</h4>
                          <div className="diff-text">
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
                          </div>
                        </div>
                      </div>
                      
                      {/* Unified diff view */}
                      <div className="unified-diff">
                        <h4>Unified Diff View</h4>
                        <div className="unified-diff-content">
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