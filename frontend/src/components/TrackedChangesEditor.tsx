import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ContentSubmission, User, Comment, Change, Approval } from '../types/content';
import { smartDiff, WordDiff, applyChanges, calculateIncrementalChanges, diffChars, diffCharsOptimized, diffWords } from '../utils/diffAlgorithm';
import { extractTextFromLexical, isLexicalJson, findAndReplaceInLexical, replaceFirstInLexical, insertTextInLexical, removeTextFromLexical, restoreDeletedTextInLexical, stripDeletedTextNodes } from '../utils/lexicalUtils';
import { API_URL } from '../config';

import LexicalEditorComponent from './editor/LexicalEditor';
import { CollaborativeEditor } from './CollaborativeEditor';
import { $isImageNode } from './editor/nodes/ImageNode';
import { SubmissionWebSocketClient, WebSocketMessage, WebSocketManager } from '../services/websocketService';
import { TransactionManager, Transaction } from '../services/transactionManager';
import SaveIndicator from './SaveIndicator';
import { addDecorationsForChange, removeDecorationsForChange, TrackedChange as PluginTrackedChange } from './editor/plugins/TrackedChangesPlugin';
import ApprovalTracker from './ApprovalTracker';
import ActivityTimeline from './ActivityTimeline';
import BatchActionBar from './BatchActionBar';
import ChangeGroup, { groupChanges } from './ChangeGroup';
import { ApprovalGates } from '../types/content';
import './TrackedChangesEditor.css';

const webSocketManager = new WebSocketManager();

const AUDIENCE_LABELS: Record<string, string> = {
  newsletter: 'Include in Ranger Newsletter (sent over Ranger Announce)',
  singular: 'Singular announcement (outside of Ranger Newsletter)',
  allcom: 'Allcom',
  website_fix: 'Website - fix',
  website_update: 'Website - update',
  jrs: 'JRS/Event Ops/Other BMP Audience',
  event: "Let's plan an event",
  other: 'Other',
};

// Display names for tracked change field types
const FIELD_DISPLAY_NAMES: Record<string, string> = {
  title: 'Subject',
  audience: 'Audience',
  replyToAddress: 'Reply-To',
  signatureText: 'Signature',
};

// Reverse map: label -> key (for converting stored label strings back to keys)
const AUDIENCE_LABEL_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(AUDIENCE_LABELS).map(([key, label]) => [label, key])
);

// Convert a stored audience value (which may be keys OR labels) to an array of keys
const parseAudienceToKeys = (value: string | string[]): string[] => {
  const parts = Array.isArray(value)
    ? value
    : value.split(',').map(s => s.trim()).filter(Boolean);
  return parts.map(part => {
    // If it's already a key, keep it
    if (AUDIENCE_LABELS[part]) return part;
    // If it's a label, convert to key
    if (AUDIENCE_LABEL_TO_KEY[part]) return AUDIENCE_LABEL_TO_KEY[part];
    // Handle "Other: ..." pattern
    if (part.startsWith('Other:')) return 'other';
    return part;
  });
};

// Helper function to format relative time
const formatRelativeTime = (date: Date): string => {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
};

// Lexical format bitmask constants
const FORMAT_BOLD = 1;
const FORMAT_ITALIC = 2;
const FORMAT_STRIKETHROUGH = 4;
const FORMAT_UNDERLINE = 8;

const FORMAT_NAMES: Record<number, string> = {
  [FORMAT_BOLD]: 'bold',
  [FORMAT_ITALIC]: 'italic',
  [FORMAT_STRIKETHROUGH]: 'strikethrough',
  [FORMAT_UNDERLINE]: 'underline',
};

const HEADING_TAG_NAMES: Record<string, string> = {
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4',
  h5: 'Heading 5',
  h6: 'Heading 6',
};

/**
 * Build a per-character format array from a block's text nodes.
 * Each element is the Lexical format bitmask for that character position.
 * This handles Lexical's text node splitting (e.g. bolding "nothing" splits
 * one node into three) by flattening to character level.
 */
/**
 * Recursively collect all text nodes from a JSON subtree.
 * Handles nested structures (list items, links, etc.) that have text nodes
 * deeper than direct children.
 */
const collectTextNodes = (node: any): any[] => {
  if (node.type === 'text') return [node];
  if (!node.children) return [];
  return node.children.flatMap((child: any) => collectTextNodes(child));
};

const buildCharFormatMap = (textNodes: any[]): { formats: number[]; fullText: string } => {
  const formats: number[] = [];
  let fullText = '';
  for (const node of textNodes) {
    const text: string = node.text || '';
    const format: number = node.format || 0;
    for (let i = 0; i < text.length; i++) {
      formats.push(format);
    }
    fullText += text;
  }
  return { formats, fullText };
};

/**
 * Compare two blocks' text nodes at the character level and return
 * contiguous ranges where the format bitmask changed.
 */
const detectInlineFormatChanges = (
  oldTextNodes: any[],
  newTextNodes: any[],
): Array<{ text: string; fromFormat: number; toFormat: number }> => {
  const oldMap = buildCharFormatMap(oldTextNodes);
  const newMap = buildCharFormatMap(newTextNodes);
  // Only compare if the plain text is identical (format-only change)
  if (oldMap.fullText !== newMap.fullText) return [];

  const results: Array<{ text: string; fromFormat: number; toFormat: number }> = [];
  let i = 0;
  while (i < oldMap.formats.length) {
    if (oldMap.formats[i] !== newMap.formats[i]) {
      // Start of a changed range
      const start = i;
      const fromFmt = oldMap.formats[i];
      const toFmt = newMap.formats[i];
      while (
        i < oldMap.formats.length &&
        oldMap.formats[i] === fromFmt &&
        newMap.formats[i] === toFmt
      ) {
        i++;
      }
      results.push({
        text: oldMap.fullText.substring(start, i),
        fromFormat: fromFmt,
        toFormat: toFmt,
      });
    } else {
      i++;
    }
  }
  return results;
};

/**
 * Compare richTextOldValue and richTextNewValue to produce human-readable
 * descriptions of format-only changes (block type and inline formatting).
 */
const describeFormatChanges = (richTextOldValue?: string, richTextNewValue?: string): string[] => {
  if (!richTextOldValue || !richTextNewValue) return [];
  try {
    const oldJson = isLexicalJson(richTextOldValue) ? JSON.parse(richTextOldValue) : null;
    const newJson = isLexicalJson(richTextNewValue) ? JSON.parse(richTextNewValue) : null;
    if (!oldJson?.root?.children || !newJson?.root?.children) return [];

    const descriptions: string[] = [];
    const oldBlocks = oldJson.root.children.filter((n: any) => n.type === 'paragraph' || n.type === 'heading');
    const newBlocks = newJson.root.children.filter((n: any) => n.type === 'paragraph' || n.type === 'heading');

    for (let i = 0; i < Math.min(oldBlocks.length, newBlocks.length); i++) {
      const oldBlock = oldBlocks[i];
      const newBlock = newBlocks[i];

      // Block type changes (paragraph <-> heading, or heading tag changes)
      if (oldBlock.type !== newBlock.type || oldBlock.tag !== newBlock.tag) {
        const blockText = (newBlock.children || [])
          .filter((n: any) => n.type === 'text')
          .map((n: any) => n.text || '')
          .join('');
        const snippet = blockText.length > 40 ? blockText.substring(0, 40) + '...' : blockText;
        const fromLabel = oldBlock.type === 'heading' && oldBlock.tag
          ? HEADING_TAG_NAMES[oldBlock.tag] || oldBlock.tag
          : 'Paragraph';
        const toLabel = newBlock.type === 'heading' && newBlock.tag
          ? HEADING_TAG_NAMES[newBlock.tag] || newBlock.tag
          : 'Paragraph';
        descriptions.push(`Changed "${snippet}" from ${fromLabel} to ${toLabel}`);
      }

      // Inline format changes — character-level comparison handles node splits
      // Use recursive collectTextNodes to handle nested structures (lists, links)
      const oldTexts = collectTextNodes(oldBlock);
      const newTexts = collectTextNodes(newBlock);
      const inlineChanges = detectInlineFormatChanges(oldTexts, newTexts);
      for (const ic of inlineChanges) {
        const snippet = ic.text.length > 30 ? ic.text.substring(0, 30) + '...' : ic.text;
        for (const [bit, name] of Object.entries(FORMAT_NAMES)) {
          const bitNum = Number(bit);
          const wasSet = (ic.fromFormat & bitNum) !== 0;
          const isSet = (ic.toFormat & bitNum) !== 0;
          if (!wasSet && isSet) {
            descriptions.push(`Made "${snippet}" ${name}`);
          } else if (wasSet && !isSet) {
            descriptions.push(`Removed ${name} from "${snippet}"`);
          }
        }
      }
    }

    return descriptions;
  } catch {
    return [];
  }
};

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
  onRemoteChangeResolved?: (changeId: string, status: string) => void;
  onSubmissionApprove?: (submission: ContentSubmission) => Promise<void> | void;
  onSubmissionReject?: (submission: ContentSubmission) => Promise<void> | void;
  onBack?: () => void;
  onReset?: () => void;
  onDelete?: () => void;
  onSendEmail?: () => Promise<void>;
  reviewMode?: boolean;
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
  onRemoteChangeResolved,
  onSubmissionApprove,
  onSubmissionReject,
  onBack,
  onReset,
  onDelete,
  onSendEmail,
  reviewMode = false
}) => {

  // WebSocket state is now managed by CollaborativeEditor

  // Existing state
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [showCommentDialog, setShowCommentDialog] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
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

  // Batch selection state
  const [selectedChangeIds, setSelectedChangeIds] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [batchActionLoading, setBatchActionLoading] = useState(false);

  // Error toast for failed operations
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const errorToastTimerRef = useRef<NodeJS.Timeout | null>(null);
  const showErrorToast = useCallback((msg: string) => {
    setErrorToast(msg);
    if (errorToastTimerRef.current) clearTimeout(errorToastTimerRef.current);
    errorToastTimerRef.current = setTimeout(() => setErrorToast(null), 6000);
  }, []);

  // Track optimistically removed changes (e.g. via undo) so they disappear immediately
  const [localRemovedChangeIds, setLocalRemovedChangeIds] = useState<Set<string>>(new Set());

  // Track optimistically added changes (from handleSaved) so they appear in sidebar
  // immediately without a full fetchSubmission() round-trip that would trigger applyDecorations cascade
  const [localAddedChanges, setLocalAddedChanges] = useState<Change[]>([]);

  // Synchronized scrolling refs and state
  const originalDiffTextRef = useRef<HTMLDivElement>(null);
  const proposedDiffTextRef = useRef<HTMLDivElement>(null);
  const isScrollingSyncedRef = useRef(false);

  // Content initialization tracking
  const hasInitializedContentRef = useRef(false);

  // Remote update state
  const [remoteUpdateStatus, setRemoteUpdateStatus] = useState<'none' | 'applying' | 'applied'>('none');

  // WebSocket connection status for banner
  const [wsConnectionLost, setWsConnectionLost] = useState(false);

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
  // Monotonic counter: each remote content update bumps this. Timeout
  // callbacks only clear isApplyingRealTimeUpdateRef when the counter
  // hasn't moved (no newer update arrived). This replaces a fixed-delay
  // timeout with a version-safe approach.
  const remoteUpdateVersionRef = useRef<number>(0);
  // Tracks whether a WebSocket-triggered refresh (fetchSubmission) is in-flight.
  // When true, the resulting editor re-init is from remote data, not a user edit.
  const isRemoteRefreshInFlightRef = useRef<boolean>(false);
  const isRefreshingContentRef = useRef<boolean>(false);
  // Stays true while a change resolution (approve/reject) is in progress.
  // Unlike isRefreshingContentRef (one-shot), this persists through multiple
  // onContentChange events until cleared by a timeout.
  const isResolvingChangeRef = useRef<boolean>(false);
  // Tracks how many resolve timeouts are pending. isResolvingChangeRef is only
  // cleared when this reaches 0, preventing the first timeout in a batch from
  // opening a window for WebSocket overwrites.
  const pendingResolveCountRef = useRef<number>(0);
  const batchSyncInProgressRef = useRef<boolean>(false);

  // TransactionManager instance — one per submission editing session
  const transactionManagerRef = useRef<TransactionManager | null>(null);
  if (!transactionManagerRef.current) {
    transactionManagerRef.current = new TransactionManager(submission.id);
  }
  const transactionManager = transactionManagerRef.current;

  // Track whether we have started a transaction for the current editing sequence
  const hasActiveTransactionRef = useRef(false);

  // Callback for SaveIndicator — returns the latest editor state for
  // beforeunload settle.
  const getLatestEditorState = useCallback((): string | object | null => {
    return editedProposedContentRef.current || null;
  }, []);

  // Tab navigation state for Proposed / Comparison / Original / Send sections
  const [activeTab, setActiveTab] = useState<'proposed' | 'comparison' | 'original' | 'send'>('proposed');
  const [sendCopied, setSendCopied] = useState(false);
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Sidebar tab state: Changes, Timeline, or Comments (review mode)
  const [sidebarTab, setSidebarTab] = useState<'changes' | 'timeline' | 'comments'>('changes');

  // Sidebar collapse state - initialize based on screen size
  const [isSmallScreen, setIsSmallScreen] = useState<boolean>(window.innerWidth <= 768);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [sidebarAutoCollapsed, setSidebarAutoCollapsed] = useState<boolean>(false); // Start with manual control

  // Use refs to access current state values without causing re-renders
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  const sidebarAutoCollapsedRef = useRef(sidebarAutoCollapsed);

  // Update refs when state changes
  useEffect(() => {
    sidebarCollapsedRef.current = sidebarCollapsed;
  }, [sidebarCollapsed]);

  useEffect(() => {
    sidebarAutoCollapsedRef.current = sidebarAutoCollapsed;
  }, [sidebarAutoCollapsed]);

  // Editable title/audience/replyTo/signature state
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingAudience, setEditingAudience] = useState(false);
  const [editingReplyTo, setEditingReplyTo] = useState(false);
  const [editingSignature, setEditingSignature] = useState(false);

  // Extract original form field values as arrays/strings
  const audienceArray = useMemo(() => {
    const field = submission.formFields?.find(f => f.id === 'audience');
    if (!field?.value) return [] as string[];
    return parseAudienceToKeys(field.value);
  }, [submission.formFields]);
  const audienceDisplay = useMemo(() => audienceArray.map(k => AUDIENCE_LABELS[k] || k).join(', '), [audienceArray]);

  const replyToValue = useMemo(() => {
    const field = submission.formFields?.find(f => f.id === 'replyToAddress');
    return (field?.value as string) || '';
  }, [submission.formFields]);

  const signatureValue = useMemo(() => {
    const field = submission.formFields?.find(f => f.id === 'signatureText');
    return (field?.value as string) || '';
  }, [submission.formFields]);

  const [proposedTitle, setProposedTitle] = useState(
    submission.proposedVersions?.title || submission.title
  );
  // Audience proposed state as array of keys
  const [proposedAudienceArr, setProposedAudienceArr] = useState<string[]>(() => {
    const proposed = submission.proposedVersions?.audience;
    if (proposed) return parseAudienceToKeys(proposed);
    return audienceArray;
  });
  const [proposedReplyTo, setProposedReplyTo] = useState(
    submission.proposedVersions?.replyToAddress || replyToValue
  );
  const [proposedSignature, setProposedSignature] = useState(
    submission.proposedVersions?.signatureText || signatureValue
  );

  // Get effective user ID (fallback to email if id is not available)
  const effectiveUserId = currentUser.id || currentUser.email;

  // Determine current user's existing approval decision on the submission
  const mySubmissionApproval = useMemo(() => {
    return (submission.approvals || []).find(a =>
      (a as any).approverEmail === currentUser.email || a.approverId === currentUser.id || a.approverId === effectiveUserId
    );
  }, [submission.approvals, currentUser.email, currentUser.id, effectiveUserId]);
  const hasApprovedSubmission = mySubmissionApproval?.status === 'APPROVED';
  const hasRejectedSubmission = mySubmissionApproval?.status === 'REJECTED';
  // Real-time notifications are now handled by CollaborativeEditor

  // Helper function to request refresh from parent
  const requestRefresh = useCallback(() => {
    if (onRefreshNeeded) {
      onRefreshNeeded();
    }
  }, [onRefreshNeeded, submission.id]);

  // Helper for WebSocket-triggered refreshes. Sets isApplyingRealTimeUpdateRef
  // so the TransactionManager skips editor re-inits caused by the async
  // fetchSubmission → setSubmission → proposedEditorContent → initialContent
  // chain. Uses the version counter so rapid calls don't leave stale flags.
  const refreshWithRemoteGuard = useCallback(() => {
    const v = ++remoteUpdateVersionRef.current;
    isApplyingRealTimeUpdateRef.current = true;
    isRemoteRefreshInFlightRef.current = true;
    if (onRefreshNeeded) {
      onRefreshNeeded();
    }
    // 5s ceiling covers: network RTT + React re-render + editor re-init +
    // applyDecorations. Only clears if no newer remote event has arrived.
    setTimeout(() => {
      if (remoteUpdateVersionRef.current === v) {
        isApplyingRealTimeUpdateRef.current = false;
        isRemoteRefreshInFlightRef.current = false;
      }
    }, 5000);
  }, [onRefreshNeeded]);

  // WebSocket connection is now handled by CollaborativeEditor
  // Removed WebSocket connection setup

  // WebSocket connection logic removed - now handled by CollaborativeEditor

  // Cleanup TransactionManager on unmount
  useEffect(() => {
    return () => {
      transactionManagerRef.current?.destroy();
    };
  }, []);

  // Wire TransactionManager events
  useEffect(() => {
    const tm = transactionManagerRef.current;
    if (!tm) return;

    // Reset the active-transaction flag when a transaction settles
    // so the next content change starts a new transaction.
    const handleSettledFlag = () => {
      hasActiveTransactionRef.current = false;
    };
    tm.on('transaction-settled', handleSettledFlag);

    // Broadcast the saved transaction over WebSocket.
    // We listen for transaction-saved (not settled) because we need the
    // remoteChangeId which is only assigned after the save succeeds.
    const handleSaved = (tx: Transaction) => {
      console.log('[TrackedChangesEditor] transaction-saved:', {
        remoteChangeId: tx.remoteChangeId,
        field: tx.field,
        status: tx.status,
        beforeTextLen: tx.beforeSnapshot.text.length,
        afterTextLen: tx.afterSnapshot?.text.length,
      });
      const client = webSocketClientRef.current;
      if (client && tx.remoteChangeId && tx.afterSnapshot) {
        client.sendTransactionSettled({
          changeId: tx.remoteChangeId,
          field: tx.field,
          oldValue: tx.beforeSnapshot.text,
          newValue: tx.afterSnapshot.text,
          regionMap: tx.regionMap ?? undefined,
        });

        // Map __pending_deletion__ to the real changeId in the Lexical JSON
        const currentJson = editedProposedContentRef.current;
        if (currentJson && currentJson.includes('__pending_deletion__')) {
          const updatedJson = currentJson.replace(/__pending_deletion__/g, tx.remoteChangeId);
          setEditedProposedContent(updatedJson);
          editedProposedContentRef.current = updatedJson;

          window.dispatchEvent(new CustomEvent('commit-pending-deletion', {
            detail: { newId: tx.remoteChangeId }
          }));
        }
      }
      // Optimistically add the new change to the sidebar instead of calling
      // onRefreshNeeded() (which triggers fetchSubmission → applyDecorations → cascade).
      // The editor DOM already has the correct DeletedTextNode from commit-pending-deletion.
      if (tx.remoteChangeId && tx.afterSnapshot) {
        const optimisticChange: Change = {
          id: tx.remoteChangeId,
          field: tx.field,
          oldValue: tx.beforeSnapshot.text,
          newValue: tx.afterSnapshot.text,
          changedBy: currentUser.email || currentUser.id,
          timestamp: new Date(),
          status: 'pending',
          isIncremental: true,
          regionMap: tx.regionMap ?? undefined,
        };
        setLocalAddedChanges(prev => [...prev, optimisticChange]);
      }
    };
    tm.on('transaction-saved', handleSaved);

    return () => {
      tm.off('transaction-settled', handleSettledFlag);
      tm.off('transaction-saved', handleSaved);
    };
  }, [currentUser.email, currentUser.id]);

  // Update ref when content changes
  useEffect(() => {
    editedProposedContentRef.current = editedProposedContent;
  }, [editedProposedContent]);

  // Stable onChange handler for the editor
  const handleEditorChange = useCallback((editor: any, json: string) => {
    // Skip if we're still initializing content to prevent auto-save on load
    if (!hasInitializedContentRef.current) {
      return;
    }

    // Only update if the content has actually changed
    if (json !== editedProposedContentRef.current) {
      setEditedProposedContent(json);
    }
  }, []);

  // Removed edit mode content state since we only have proposed version editing now

  const editorRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Measure toolbar height and set CSS variable for sidebar positioning
  useEffect(() => {
    const updateSidebarTop = () => {
      if (toolbarRef.current) {
        const navbarHeight = 64;
        const toolbarHeight = toolbarRef.current.offsetHeight;
        document.documentElement.style.setProperty('--sidebar-top', `${navbarHeight + toolbarHeight}px`);
      }
    };
    updateSidebarTop();
    window.addEventListener('resize', updateSidebarTop);
    return () => window.removeEventListener('resize', updateSidebarTop);
  }, []);

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
        // Failed to parse as JSON, treating as plain text
      }
    }

    return content;
  }, []);

  // Render character-level diff: only changed characters get <span> (styled via CSS)
  const renderCharDiff = useCallback((
    oldRaw: string,
    newRaw: string,
    mode: 'old' | 'new'
  ): React.ReactNode => {
    const oldText = getChangeDisplayText(oldRaw);
    const newText = getChangeDisplayText(newRaw);

    // Fall back to full-span rendering when char diff isn't useful
    if (!oldText || !newText || oldText.length > 500 || newText.length > 500) {
      const text = mode === 'old' ? oldText : newText;
      return <span>{text}</span>;
    }

    const segments = diffChars(oldText, newText);

    return <>{segments
      .filter(seg => mode === 'old' ? seg.type !== 'insert' : seg.type !== 'delete')
      .map((seg, idx) =>
        seg.type === 'equal'
          ? <React.Fragment key={idx}>{seg.value}</React.Fragment>
          : <span key={idx}>{seg.value}</span>
      )}</>;
  }, [getChangeDisplayText]);

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
      // For HTML content, let the CollaborativeEditor handle the conversion
      // Just return the HTML content as-is and let the editor parse it
      return content;
    }

    // If it's plain text, create a basic Lexical structure
    if (typeof content === 'string' && content.trim()) {
      // For plain text with line breaks, create multiple paragraphs
      const lines = content.split('\n');

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
    // Clear optimistic local state when submission changes arrive from the server
    setLocalRemovedChangeIds(new Set());
    setLocalAddedChanges([]);

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

    // DEFENSE: If we have editedProposedContent that's richer than what we're getting from backend,
    // and the new content is plain text while the current content is Lexical JSON, preserve the current content
    const isCurrentContentRich = editedProposedContent && isLexicalJson(editedProposedContent);
    const isNewContentPlain = content && !isLexicalJson(content);

    if (isCurrentContentRich && isNewContentPlain && editedProposedContent) {
      // Keep the current rich content instead of overwriting with plain text
      return;
    }

    const richTextContent = getRichTextContent(content);

    // Suppress TransactionManager from creating tracked changes during this
    // programmatic content update (e.g. after a rejection refreshes the submission).
    isRefreshingContentRef.current = true;

    // Always update the edited content and last saved content during initialization
    setEditedProposedContent(richTextContent);
    setLastSavedProposedContent(richTextContent);

    // Always update the initial content reference for fresh data
    // This ensures the editor gets the latest content when entering edit mode
    initialEditorContentRef.current = richTextContent;

    // Mark as initialized after a short delay to ensure all state is set.
    // Also clear isRefreshingContentRef as a safety net — if the editor doesn't
    // fire an onChange (e.g. content unchanged after refresh), the flag would
    // otherwise stay true and swallow the first user edit.
    setTimeout(() => {
      hasInitializedContentRef.current = true;
      isRefreshingContentRef.current = false;
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
    // Use a timeout to ensure the DOM elements are fully rendered
    const timeoutId = setTimeout(() => {
      const originalElement = originalDiffTextRef.current;
      const proposedElement = proposedDiffTextRef.current;

      if (originalElement && proposedElement) {
        originalElement.addEventListener('scroll', handleOriginalScroll, { passive: true });
        proposedElement.addEventListener('scroll', handleProposedScroll, { passive: true });
      }
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      const originalElement = originalDiffTextRef.current;
      const proposedElement = proposedDiffTextRef.current;

      if (originalElement && proposedElement) {
        originalElement.removeEventListener('scroll', handleOriginalScroll);
        proposedElement.removeEventListener('scroll', handleProposedScroll);
      }
    };
  }, [handleOriginalScroll, handleProposedScroll, submission.proposedVersions]);

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
    }).filter(c => !localRemovedChangeIds.has(c.id));

    // Merge optimistically added changes (from handleSaved) that aren't yet
    // in the server data.  Once fetchSubmission() runs, the server data will
    // include these changes and the local copies are automatically excluded.
    const serverIds = new Set(result.map(c => c.id));
    for (const local of localAddedChanges) {
      if (!serverIds.has(local.id) && !localRemovedChangeIds.has(local.id)) {
        result.push({
          ...local,
          status: local.status || 'pending',
          approvedBy: undefined,
          rejectedBy: undefined,
          comments: [],
        });
      }
    }

    console.log('[TrackedChangesEditor] trackedChanges:', {
      submissionChangesCount: submission.changes.length,
      afterFilterCount: result.length,
      localRemovedCount: localRemovedChangeIds.size,
      localAddedCount: localAddedChanges.filter(c => !serverIds.has(c.id)).length,
      statuses: result.map(c => c.status),
    });
    return result;
  }, [submission.changes, submission.comments, localRemovedChangeIds, localAddedChanges]);

  const hasPendingTrackedChanges = trackedChanges.filter(c => c.status === 'pending').length > 0;

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

  // Compute props for inline tracked changes in the editor
  const pendingContentChanges = useMemo(() => {
    return trackedChanges
      .filter(c => c.status === 'pending' && c.field === 'content')
      .map(c => ({
        id: c.id,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        changedBy: c.changedBy,
        status: c.status as 'pending' | 'approved' | 'rejected',
        richTextOldValue: c.richTextOldValue,
        richTextNewValue: c.richTextNewValue,
        isIncremental: c.isIncremental,
        completeProposedVersion: c.completeProposedVersion,
        regionMap: c.regionMap,
      }));
  }, [trackedChanges]);

  const originalTextForInlineChanges = useMemo(() => {
    const originalContent = submission.richTextContent || submission.content || '';
    return getDisplayableText(originalContent);
  }, [submission.richTextContent, submission.content, getDisplayableText]);

  const handleTextSelection = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
    }
  }, []);

  const handleProposedEditModeChange = useCallback((newEditMode: boolean) => {
    // Remove edit mode toggle - always collaborative
    console.log('Edit mode change requested but collaborative editing is always on');
  }, []);

  // Dedicated save function for reverted content.
  // Saves proposed content directly via tracked-changes API instead of onSave,
  // which avoids the race condition where handleSave's setSubmission(savedSubmission)
  // overwrites the optimistic rejection with stale data from the server.
  const saveRevertedContent = useCallback(async (revertedContent: string) => {
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) throw new Error('Not authenticated');

      await fetch(`${API_URL}/tracked-changes/submission/${submission.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({
          proposedVersionsRichText: revertedContent,
        }),
      });

      // Update the last saved content after successful save
      setLastSavedProposedContent(revertedContent);
    } catch (error) {
      console.error('❌ Failed to save reverted content:', error);
    }
  }, [submission.id]);

  const handleProposedEditSubmit = useCallback(async () => {
    const currentContent = submission.proposedVersions?.richTextContent || submission.richTextContent || submission.content || '';
    const hasActualChanges = editedProposedContent !== currentContent;

    if (!hasActualChanges) {
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

      await onSave(updatedSubmission);

      // Update the last saved content after successful save
      setLastSavedProposedContent(editedProposedContent);
    } catch (error) {
      console.error('❌ Save failed:', error);
    }
  }, [editedProposedContent, submission, onSave, currentUser.id, currentUser.email]);

  // Helper function to revert a change in the content
  const revertChangeInContent = useCallback((change: TrackedChange) => {
    // Use ref for current content so concurrent calls see the latest value
    const currentContent = editedProposedContentRef.current ||
      editedProposedContent ||
      submission.proposedVersions?.richTextContent ||
      submission.richTextContent ||
      submission.content || '';

    // Original content for position context when restoring deletions
    const originalContent = submission.richTextContent || submission.content || '';

    // Try to revert using rich text values first, then fall back to plain text
    const valueToRevert = change.richTextNewValue !== undefined ? change.richTextNewValue : change.newValue;
    const revertToValue = change.richTextOldValue !== undefined ? change.richTextOldValue : change.oldValue;

    if (valueToRevert === undefined || revertToValue === undefined) {
      return;
    }

    const applyRevert = (revertedContent: string) => {
      // Update ref immediately so concurrent calls see the latest content
      editedProposedContentRef.current = revertedContent;
      setEditedProposedContent(revertedContent);
      if (remoteUpdateFunctionRef.current) {
        remoteUpdateFunctionRef.current(revertedContent);
      }
      setTimeout(() => { saveRevertedContent(revertedContent); }, 100);
    };

    // Ellipsis separator used by backend to join disjoint change segments
    const SEGMENT_SEPARATOR = ' \u2026 ';

    // For incremental changes, surgically revert only the specific text
    // that this change introduced, leaving other changes intact.
    // NOTE: Deletion restoration is handled separately by the 'resolve-tracked-change'
    // event (which replaces DeletedTextNodes). This function only needs to handle
    // removing inserted text from the current document.
    if (change.isIncremental) {
      // Extract the text before and after this change was applied so we
      // can compute what was actually added/removed by this specific change.
      const changeOldText = getDisplayableText(revertToValue);
      const changeNewText = getDisplayableText(valueToRevert);

      if (isLexicalJson(currentContent)) {
        // Strip DeletedTextNodes from the JSON so text is continuous for
        // accurate search/replace. DeletedTextNodes split text across
        // multiple nodes, preventing replaceFirstInLexical from finding
        // junction text that spans a deletion boundary.
        const cleanedContent = stripDeletedTextNodes(currentContent);

        // Diff the change's old vs new to find the specific insertions/deletions
        const segments = diffCharsOptimized(changeOldText, changeNewText);
        let revertedContent = cleanedContent;
        const CTX = 20;

        // Track offsets in both old and new text independently.
        // equal segments advance both; insert advances new only; delete advances old only.
        let oldOffset = 0;
        let newOffset = 0;
        for (const seg of segments) {
          if (seg.type === 'equal') {
            oldOffset += seg.value.length;
            newOffset += seg.value.length;
          } else if (seg.type === 'insert') {
            // Get surrounding context from the new text for precise matching
            const before = changeNewText.slice(Math.max(0, newOffset - CTX), newOffset);
            const after = changeNewText.slice(
              newOffset + seg.value.length,
              newOffset + seg.value.length + CTX,
            );

            // Try context-aware replacement first (before+inserted+after → before+after)
            if (before.length > 0 || after.length > 0) {
              const searchStr = before + seg.value + after;
              const replaceStr = before + after;
              const result = replaceFirstInLexical(revertedContent, searchStr, replaceStr);
              if (result !== revertedContent) {
                revertedContent = result;
                newOffset += seg.value.length;
                continue;
              }
            }

            // Fallback: replace just the inserted text (first occurrence only)
            if (seg.value.trim()) {
              revertedContent = replaceFirstInLexical(revertedContent, seg.value, '');
            }
            newOffset += seg.value.length;
          } else if (seg.type === 'delete') {
            // Deletions are primarily handled by the resolve-tracked-change event
            // which replaces DeletedTextNodes with TextNodes. However, if
            // no DeletedTextNode exists, restore using context-aware placement.
            const before = changeOldText.slice(Math.max(0, oldOffset - CTX), oldOffset);
            const afterDel = changeOldText.slice(
              oldOffset + seg.value.length,
              oldOffset + seg.value.length + CTX,
            );
            if (before.length > 0 && afterDel.length > 0) {
              const junction = before + afterDel;
              const restored = before + seg.value + afterDel;
              const result = replaceFirstInLexical(revertedContent, junction, restored);
              if (result !== revertedContent) {
                revertedContent = result;
              }
            }
            oldOffset += seg.value.length;
          }
        }

        // Always apply if we cleaned DeletedTextNodes or if the diff changed content
        if (revertedContent !== currentContent) {
          applyRevert(revertedContent);
        }
      }
    } else {
      // For non-incremental changes, revert entire content to old value
      const currentText = getDisplayableText(currentContent);
      const newText = getDisplayableText(valueToRevert);

      if (currentText === newText) {
        applyRevert(getRichTextContent(revertToValue));
      }
    }
  }, [editedProposedContent, submission, getDisplayableText, getRichTextContent, saveRevertedContent]);

  // Background sync: fire-and-forget PUT to backend
  const syncChangeStatusToBackend = useCallback(async (changeId: string, status: 'approved' | 'rejected', revertedRichText?: string) => {
    // Skip individual backend syncs during batch operations — the batch
    // handler will make a single API call with all changes.
    if (batchSyncInProgressRef.current) return;
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) return;
      const body: Record<string, string> = { status, submissionId: submission.id };
      // Include the reverted editor content so the backend uses it instead of
      // recomputing rich text (which loses format reverts).
      if (revertedRichText) {
        body.revertedRichText = revertedRichText;
      }
      const response = await fetch(`${API_URL}/tracked-changes/change/${changeId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionId}` },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`Failed to ${status} change ${changeId}: ${response.status} ${errorText}`);
        const label = status === 'approved' ? 'accept' : 'reject';
        showErrorToast(`Failed to ${label} change (${response.status}): ${errorText || 'Unknown error'}`);
        onRefreshNeeded?.();
      } else {
        // Broadcast to other connected users via WebSocket
        const client = webSocketClientRef.current;
        if (client?.sendChangeStatusUpdate) {
          client.sendChangeStatusUpdate(changeId, status);
        }
      }
    } catch (error) {
      console.error(`Background sync failed for change ${changeId}:`, error);
      showErrorToast(`Failed to save change status: network error`);
      onRefreshNeeded?.();
    }
  }, [onRefreshNeeded, submission.id, showErrorToast]);

  // Handle change decision (approve/reject) — fully local, no network on hot path
  const handleChangeDecision = useCallback((changeId: string, decision: 'approve' | 'reject') => {
    // Compute deleted text segments so the handler can match __pending_deletion__ nodes.
    // Also compute replacement pairs (adjacent delete→insert) so the reject handler
    // can remove inserted text that corresponds to each deletion.
    const change = trackedChanges.find(c => c.id === changeId);
    let deletedTexts: string[] = [];
    let replacementPairs: Array<{ deleted: string; inserted: string }> = [];
    let insertedTexts: Array<{ text: string; beforeContext: string; afterContext: string }> = [];
    if (change) {
      const rawOld = change.richTextOldValue || change.oldValue || '';
      const rawNew = change.richTextNewValue || change.newValue || '';
      const oldText = getDisplayableText(rawOld);
      const newText = getDisplayableText(rawNew);
      if (oldText && newText) {
        const segments = diffCharsOptimized(oldText, newText);
        deletedTexts = segments
          .filter(s => s.type === 'delete')
          .map(s => s.value.replace(/^\n+|\n+$/g, ''))
          .filter(t => t.length > 0);

        // Build replacement pairs: adjacent (delete, insert) segments form a pair.
        // When rejecting, we need to remove the inserted text alongside restoring
        // the deleted text, otherwise both end up in the document.
        const pairedInsertIndices = new Set<number>();
        for (let i = 0; i < segments.length; i++) {
          if (segments[i].type === 'delete' && i + 1 < segments.length && segments[i + 1].type === 'insert') {
            const del = segments[i].value.replace(/^\n+|\n+$/g, '');
            const ins = segments[i + 1].value.replace(/^\n+|\n+$/g, '');
            if (del.length > 0 && ins.length > 0) {
              replacementPairs.push({ deleted: del, inserted: ins });
              pairedInsertIndices.add(i + 1);
            }
          }
        }

        // Build insertedTexts: pure inserts NOT part of a delete→insert replacement pair.
        // These are additions that have no corresponding DeletedTextNode, so the
        // resolve-tracked-change handler needs to find and remove them from TextNodes.
        let newOffset = 0;
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i];
          if (seg.type === 'equal') {
            newOffset += seg.value.length;
          } else if (seg.type === 'insert') {
            if (!pairedInsertIndices.has(i) && seg.value.trim().length > 0) {
              // Get after-context within the same paragraph for precise matching
              const afterAll = newText.slice(newOffset + seg.value.length);
              const nlIdx = afterAll.indexOf('\n');
              const afterCtx = nlIdx >= 0 ? afterAll.slice(0, Math.min(nlIdx, 30)) : afterAll.slice(0, 30);
              // Get before-context within the same paragraph
              const beforeAll = newText.slice(0, newOffset);
              const lastNl = beforeAll.lastIndexOf('\n');
              const beforeCtx = lastNl >= 0 ? beforeAll.slice(lastNl + 1) : beforeAll.slice(-30);
              insertedTexts.push({ text: seg.value, beforeContext: beforeCtx, afterContext: afterCtx });
            }
            newOffset += seg.value.length;
          }
          // 'delete' segments don't advance newOffset
        }
      }
    }

    // Detect formatting-only changes (block type + inline format) so the
    // resolve handler can revert them on rejection.
    let formatChanges: Array<{
      type?: 'block' | 'inline' | 'indent';
      text: string;
      fromType: string;
      fromTag?: string;
      toType: string;
      toTag?: string;
      fromFormat?: number;
      toFormat?: number;
      fromIndent?: number;
      toIndent?: number;
    }> = [];
    if (change && change.richTextOldValue && change.richTextNewValue) {
      try {
        const oldJson = isLexicalJson(change.richTextOldValue) ? JSON.parse(change.richTextOldValue) : null;
        const newJson = isLexicalJson(change.richTextNewValue) ? JSON.parse(change.richTextNewValue) : null;
        if (oldJson?.root?.children && newJson?.root?.children) {
          // Helper to extract text from any block (paragraph, heading, list, etc.)
          const extractBlockText = (block: any): string => {
            if (!block.children) return '';
            return block.children
              .map((n: any) => {
                if (n.type === 'text') return n.text || '';
                if (n.children) return extractBlockText(n);
                return '';
              })
              .join('');
          };

          // Compare all top-level blocks (not just paragraphs/headings)
          const oldBlocks = oldJson.root.children;
          const newBlocks = newJson.root.children;
          for (let i = 0; i < Math.min(oldBlocks.length, newBlocks.length); i++) {
            // Block type changes (paragraph <-> heading, heading tag changes)
            if (oldBlocks[i].type !== newBlocks[i].type || oldBlocks[i].tag !== newBlocks[i].tag) {
              const blockText = extractBlockText(newBlocks[i]);
              formatChanges.push({
                type: 'block',
                text: blockText,
                fromType: oldBlocks[i].type,
                fromTag: oldBlocks[i].tag,
                toType: newBlocks[i].type,
                toTag: newBlocks[i].tag,
              });
            }

            // Indent changes on the block itself
            if ((oldBlocks[i].indent ?? 0) !== (newBlocks[i].indent ?? 0)) {
              const blockText = extractBlockText(newBlocks[i]);
              formatChanges.push({
                type: 'indent',
                text: blockText,
                fromType: newBlocks[i].type,
                toType: newBlocks[i].type,
                fromIndent: oldBlocks[i].indent ?? 0,
                toIndent: newBlocks[i].indent ?? 0,
              });
            }

            // Indent changes on children (e.g. list items inside list nodes)
            if (oldBlocks[i].children && newBlocks[i].children) {
              const detectChildIndentChanges = (oldChildren: any[], newChildren: any[]) => {
                for (let j = 0; j < Math.min(oldChildren.length, newChildren.length); j++) {
                  if ((oldChildren[j].indent ?? 0) !== (newChildren[j].indent ?? 0)) {
                    const itemText = extractBlockText(newChildren[j]);
                    formatChanges.push({
                      type: 'indent',
                      text: itemText,
                      fromType: newChildren[j].type,
                      toType: newChildren[j].type,
                      fromIndent: oldChildren[j].indent ?? 0,
                      toIndent: newChildren[j].indent ?? 0,
                    });
                  }
                  // Recurse into nested children
                  if (oldChildren[j].children && newChildren[j].children) {
                    detectChildIndentChanges(oldChildren[j].children, newChildren[j].children);
                  }
                }
              };
              detectChildIndentChanges(oldBlocks[i].children, newBlocks[i].children);
            }

            // Inline format changes — character-level comparison handles node splits
            // Use recursive collectTextNodes to handle nested structures (lists, links)
            const oldTexts = collectTextNodes(oldBlocks[i]);
            const newTexts = collectTextNodes(newBlocks[i]);
            const inlineChanges = detectInlineFormatChanges(oldTexts, newTexts);
            for (const ic of inlineChanges) {
              formatChanges.push({
                type: 'inline',
                text: ic.text,
                fromType: 'text',
                toType: 'text',
                fromFormat: ic.fromFormat,
                toFormat: ic.toFormat,
              });
            }
          }
        }
      } catch { /* ignore parse errors */ }
    }

    // 1. Suppress TransactionManager for all editor changes caused by the
    //    resolve (restore text, remove decorations, applyDecorations re-run).
    transactionManager.pauseForChangeResolution();

    // 1b. Block incoming WebSocket content updates during resolution so they
    //     don't overwrite the format revert with stale content from other users.
    isResolvingChangeRef.current = true;

    console.log(`[RESOLVE] handleChangeDecision: changeId=${changeId}, decision=${decision}, formatChanges=`, JSON.stringify(formatChanges));
    console.log(`[RESOLVE] editedProposedContentRef BEFORE dispatch:`, editedProposedContentRef.current?.substring(0, 200));

    // 2. Resolve DeletedTextNode nodes in the Lexical editor
    //    - approve deletion: removes DeletedTextNode (text stays deleted)
    //    - reject deletion: replaces DeletedTextNode with TextNode (text restored)
    //      AND removes the corresponding inserted text for replacement pairs
    //    - reject format change: reverts block type (e.g., heading→paragraph)
    window.dispatchEvent(new CustomEvent('resolve-tracked-change', {
      detail: { changeId, action: decision === 'approve' ? 'approve' : 'reject', deletedTexts, replacementPairs, insertedTexts, formatChanges }
    }));

    console.log(`[RESOLVE] editedProposedContentRef AFTER dispatch:`, editedProposedContentRef.current?.substring(0, 200));

    // 3. Remove CSS highlight decorations for additions
    removeDecorationsForChange(changeId);

    // 4. Optimistic sidebar update (no network call)
    if (decision === 'approve') {
      onApprove(changeId);
    } else {
      onReject(changeId);
    }

    // 4b. Also hide from sidebar via localRemovedChangeIds.
    // onReject updates submission.changes, but changes from localAddedChanges
    // (created by handleSaved) aren't in submission.changes and won't be updated.
    // Adding to localRemovedChangeIds ensures the change disappears from both sources.
    setLocalRemovedChangeIds(prev => {
      const next = new Set(prev);
      next.add(changeId);
      return next;
    });

    // 5. Resume TransactionManager after a short delay to let all editor
    //    updates settle (decoration re-application, etc.).
    //    Track pending timeouts so that in batch operations, the resolve guard
    //    stays up until ALL timeouts have completed (not just the first one).
    pendingResolveCountRef.current++;
    setTimeout(async () => {
      transactionManager.resumeAfterChangeResolution();

      // By this point onContentChange has fired and editedProposedContentRef
      // holds the post-resolution Lexical state (including format reverts).
      const currentState = editedProposedContentRef.current;
      console.log(`[RESOLVE] setTimeout(500ms): currentState valid=${!!(currentState && isLexicalJson(currentState))}, pendingResolves=${pendingResolveCountRef.current}, first 200 chars:`, currentState?.substring(0, 200));

      // Broadcast the post-resolution editor state to other users.
      if (currentState && isLexicalJson(currentState) && webSocketClientRef.current) {
        try {
          setLastSavedProposedContent(currentState);
          webSocketClientRef.current.send({
            type: 'content_updated',
            data: {
              field: 'proposedVersions.richTextContent',
              newValue: extractTextFromLexical(currentState),
              lexicalContent: currentState,
              isAutoSave: true,
            }
          });
        } catch (e) {
          console.error('Failed to broadcast post-resolution content:', e);
        }
      }

      // Sync change status to backend, passing the reverted content so the
      // backend stores it atomically instead of recomputing (which loses
      // format reverts). This triggers other users' change_status_updated →
      // fetchSubmission(), which will get the correct reverted content.
      // Await the sync so isResolvingChangeRef stays true until the backend
      // has stored the reverted content — prevents a refresh from fetching
      // stale (pre-revert) data.
      await syncChangeStatusToBackend(changeId, decision === 'approve' ? 'approved' : 'rejected', currentState);

      // Only unblock incoming WebSocket content updates when ALL pending
      // resolve timeouts have completed. In a batch, the first timeout
      // must not clear the flag while later ones are still in flight.
      pendingResolveCountRef.current--;
      if (pendingResolveCountRef.current <= 0) {
        pendingResolveCountRef.current = 0;
        isResolvingChangeRef.current = false;
      }
    }, 500);
  }, [onApprove, onReject, syncChangeStatusToBackend, trackedChanges, getDisplayableText]);

  // Batch action handlers
  const pendingChanges = useMemo(
    () => trackedChanges.filter(c => c.status === 'pending'),
    [trackedChanges]
  );

  const changeGroups = useMemo(
    () => groupChanges(trackedChanges),
    [trackedChanges]
  );

  const toggleGroupExpansion = useCallback((index: number) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const handleBatchAction = useCallback(async (changeIds: string[], status: 'approved' | 'rejected') => {
    setBatchActionLoading(true);
    try {
      // Suppress individual backend syncs — we'll make one batch call.
      // Also keep the resolve guard up for the entire batch so that
      // incoming WebSocket updates can't overwrite reverts mid-batch.
      batchSyncInProgressRef.current = true;
      isResolvingChangeRef.current = true;
      const decision = status === 'approved' ? 'approve' : 'reject';
      for (const id of changeIds) {
        handleChangeDecision(id, decision);
      }
      batchSyncInProgressRef.current = false;

      // Wait for all per-change resolve timeouts to complete before
      // making the batch API call (they need to broadcast content and
      // resume the TransactionManager).
      await new Promise<void>(resolve => {
        const check = () => {
          if (pendingResolveCountRef.current <= 0) {
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        // Start checking after the 500ms timeout window
        setTimeout(check, 600);
      });

      // Single batch API call for backend persistence
      const sessionId = localStorage.getItem('sessionId');
      if (sessionId) {
        const response = await fetch(`${API_URL}/tracked-changes/batch-status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionId}` },
          body: JSON.stringify({ changeIds, status, submissionId: submission.id })
        });
        if (!response.ok) {
          console.error('Batch status update failed:', response.statusText);
        }
      }

      setSelectedChangeIds(new Set());
    } catch (err) {
      console.error('Batch action failed:', err);
      batchSyncInProgressRef.current = false;
    } finally {
      // Ensure the resolve guard is cleared when the batch completes
      // (including after the backend has stored the reverted content).
      pendingResolveCountRef.current = 0;
      isResolvingChangeRef.current = false;
      setBatchActionLoading(false);
    }
  }, [handleChangeDecision, submission.id]);

  const handleSelectAllChanges = useCallback(() => {
    setSelectedChangeIds(new Set(pendingChanges.map(c => c.id)));
  }, [pendingChanges]);

  const handleDeselectAllChanges = useCallback(() => {
    setSelectedChangeIds(new Set());
  }, []);

  const toggleChangeSelection = useCallback((changeId: string) => {
    setSelectedChangeIds(prev => {
      const next = new Set(prev);
      if (next.has(changeId)) next.delete(changeId);
      else next.add(changeId);
      return next;
    });
  }, []);

  // Keyboard shortcuts for batch actions
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (sidebarTab !== 'changes') return;

      const pendingIds = trackedChanges.filter(c => c.status === 'pending').map(c => c.id);
      if (pendingIds.length === 0) return;

      const currentIdx = selectedChange ? pendingIds.indexOf(selectedChange) : -1;

      if (e.key === 'j') {
        e.preventDefault();
        const nextIdx = Math.min(currentIdx + 1, pendingIds.length - 1);
        setSelectedChange(pendingIds[nextIdx]);
      } else if (e.key === 'k') {
        e.preventDefault();
        const prevIdx = Math.max(currentIdx - 1, 0);
        setSelectedChange(pendingIds[prevIdx]);
      } else if (e.key === 'a' && selectedChange) {
        e.preventDefault();
        if (selectedChangeIds.size > 0) {
          handleBatchAction(Array.from(selectedChangeIds), 'approved');
        } else {
          handleChangeDecision(selectedChange, 'approve');
        }
      } else if (e.key === 'r' && selectedChange) {
        e.preventDefault();
        if (selectedChangeIds.size > 0) {
          handleBatchAction(Array.from(selectedChangeIds), 'rejected');
        } else {
          handleChangeDecision(selectedChange, 'reject');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sidebarTab, selectedChange, selectedChangeIds, trackedChanges, handleBatchAction, handleChangeDecision]);

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

  // Scroll to and highlight matching text in the diff section when a change is clicked
  const scrollToChangeInDiff = useCallback((change: TrackedChange) => {
    const diffSection = document.querySelector('.diff-section');
    if (!diffSection) return;

    // Primary: find segment by data-change-id attribute
    let targetElement: Element | null = diffSection.querySelector(`.diff-segment[data-change-id="${change.id}"]`);

    // Fallback: text-based search if data-change-id mapping didn't find a match
    if (!targetElement) {
      const newText = change.newValue ? getChangeDisplayText(change.newValue) : '';
      const oldText = change.oldValue ? getChangeDisplayText(change.oldValue) : '';
      const segments = diffSection.querySelectorAll('.diff-segment');

      // Try matching old text in removed segments, new text in added segments
      const searches: [string, string][] = [];
      if (oldText) searches.push([oldText.trim(), 'removed']);
      if (newText) searches.push([newText.trim(), 'added']);
      for (const [text, cls] of searches) {
        if (!text) continue;
        for (const seg of segments) {
          if (!seg.classList.contains(cls)) continue;
          const segText = seg.textContent || '';
          if (segText.includes(text) || text.includes(segText.trim())) {
            targetElement = seg;
            break;
          }
        }
        if (targetElement) break;
      }

      // Try any segment containing the text
      if (!targetElement) {
        for (const text of [newText, oldText]) {
          if (!text || text.length < 2) continue;
          for (const seg of segments) {
            const segText = seg.textContent || '';
            if (segText.includes(text)) {
              const isChanged = seg.classList.contains('added') || seg.classList.contains('removed');
              if (isChanged) { targetElement = seg; break; }
              if (!targetElement) targetElement = seg;
            }
          }
          if (targetElement) break;
        }
      }
    }

    if (targetElement) {
      // Remove any existing highlight-pulse classes
      diffSection.querySelectorAll('.highlight-pulse').forEach(el => {
        el.classList.remove('highlight-pulse');
      });

      // First scroll the diff section into the page viewport
      diffSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      // Then scroll the inner .diff-body container after the page scroll settles
      const capturedTarget = targetElement;
      setTimeout(() => {
        const scrollContainer = capturedTarget.closest('.diff-body');
        if (scrollContainer) {
          // Lock out sync handlers
          isScrollingSyncedRef.current = true;

          // Calculate position of target within the scroll container's content
          const containerRect = scrollContainer.getBoundingClientRect();
          const targetRect = capturedTarget.getBoundingClientRect();
          const targetTopInContent = targetRect.top - containerRect.top + scrollContainer.scrollTop;
          const desiredScrollTop = Math.max(0, targetTopInContent - scrollContainer.clientHeight / 2 + targetRect.height / 2);

          // Set scrollTop directly on both containers to avoid smooth-scroll event fighting
          scrollContainer.scrollTop = desiredScrollTop;

          const otherContainer = scrollContainer === originalDiffTextRef.current
            ? proposedDiffTextRef.current
            : originalDiffTextRef.current;
          if (otherContainer) {
            otherContainer.scrollTop = desiredScrollTop;
          }

          // Re-enable sync after scroll events settle
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              isScrollingSyncedRef.current = false;
            });
          });
        }
      }, 400);

      // Add highlight animation
      targetElement.classList.add('highlight-pulse');

      // Remove the class after the animation ends
      setTimeout(() => {
        targetElement?.classList.remove('highlight-pulse');
      }, 2000);
    }
  }, [getChangeDisplayText]);

  // Handle saving title or audience as a tracked change
  const handleFieldChange = useCallback(async (field: string, oldValue: string, newValue: string) => {
    if (oldValue === newValue) return;
    const change: Change = {
      id: `${field}-${Date.now()}`,
      field,
      oldValue,
      newValue,
      changedBy: currentUser.email || currentUser.id || '',
      timestamp: new Date(),
      status: 'pending' as const,
    };
    await onSuggestion(change);
  }, [currentUser.email, currentUser.id, onSuggestion]);

  // Handle clicking on an inline tracked change in the editor → highlight sidebar card
  const handleEditorTrackedChangeClick = useCallback((changeId: string) => {
    // Ignore live (unsaved) change IDs — they have no sidebar card
    if (changeId.startsWith('__live__')) return;
    setSelectedChange(changeId);
    // Find and highlight the sidebar card
    setTimeout(() => {
      const card = document.querySelector(`.change-item[data-change-id="${changeId}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('sidebar-highlighted');
        setTimeout(() => card.classList.remove('sidebar-highlighted'), 2000);
      }
    }, 50);
  }, []);

  // Scroll to an inline tracked change in the proposed editor
  const scrollToChangeInProposed = useCallback((change: TrackedChange) => {
    const editorRoot = document.querySelector('.proposed-collaborative-editor');
    if (editorRoot) {
      const inlineElement = editorRoot.querySelector(`[data-change-id="${change.id}"]`);
      if (inlineElement) {
        inlineElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        inlineElement.classList.add('tracked-change-active');
        setTimeout(() => inlineElement.classList.remove('tracked-change-active'), 2000);
        return;
      }
    }
  }, []);

  // Handle clicking on a change item in the sidebar - scroll/highlight on current tab
  const handleChangeClick = useCallback((change: TrackedChange) => {
    setSelectedChange(change.id);

    // Field changes (title, audience, etc.) always live on the proposed tab
    if (FIELD_DISPLAY_NAMES[change.field]) {
      if (activeTab !== 'proposed') {
        setActiveTab('proposed');
      }
      setTimeout(() => {
        const fieldEl = document.querySelector(`[data-field-id="${change.field}"]`);
        if (fieldEl) {
          fieldEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          fieldEl.classList.add('field-highlight');
          setTimeout(() => fieldEl.classList.remove('field-highlight'), 2000);
        }
      }, 100);
      return;
    }

    // Content changes - behaviour depends on the active tab
    if (activeTab === 'comparison') {
      // Already on comparison tab - scroll to the diff segment
      setTimeout(() => scrollToChangeInDiff(change), 100);
    } else {
      // On proposed or original tab - switch to proposed and scroll to inline change
      if (activeTab !== 'proposed') {
        setActiveTab('proposed');
      }
      setTimeout(() => scrollToChangeInProposed(change), 100);
    }
  }, [activeTab, scrollToChangeInDiff, scrollToChangeInProposed]);

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
          pendingRealTimeUpdateRef.current = false;
          return;
        }

        // Send the most recent content
        sendRealTimeUpdate(lastRealTimeUpdateRef.current, lastCursorPositionRef.current);
        pendingRealTimeUpdateRef.current = false;
      }, 150); // 150ms throttle - fast enough to feel real-time but not overwhelming
    } else {
      console.log('⏰ Real-time update already pending, updating content for next send');
    }
  }, [sendRealTimeUpdate]);

  // Handle incoming WebSocket updates
  const handleWebSocketUpdate = useCallback((message: WebSocketMessage) => {
    // Don't process our own updates
    if (message.userId === (currentUser.id || currentUser.email)) {
      return;
    }

    // Skip incoming content updates while a change resolution (approve/reject)
    // is in progress. The local editor has just reverted formatting or text
    // and the reverted state hasn't been broadcast yet — applying stale content
    // from the other user would overwrite the revert.
    if (isResolvingChangeRef.current &&
        (message.type === 'content_updated' || message.type === 'realtime_content_update')) {
      console.log(`[RESOLVE-GUARD] Blocked incoming ${message.type} while resolving`);
      return;
    }

    // Handle real-time content updates (character-by-character)
    if (message.type === 'realtime_content_update' && message.data) {
      const { content, lexicalContent, cursorPosition, isRealTime, userId, userName } = message.data;

      // Ensure we have valid Lexical content
      if (!lexicalContent || !isLexicalJson(lexicalContent)) {
        console.error('❌ TrackedChangesEditor: Invalid Lexical content in real-time update');
        return; // Skip invalid content
      }

      // Skip applying remote updates while the local user is actively editing.
      // The full-document-state sync would overwrite local changes. The next
      // update after the local user pauses will bring things back in sync.
      if (hasActiveTransactionRef.current) {
        return;
      }

      // Apply the real-time update immediately
      // Try to use the specialized real-time update function first
      const rtVersion = ++remoteUpdateVersionRef.current;
      if (webSocketClientRef.current && webSocketClientRef.current.applyRealTimeUpdate) {
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

          // Request cursor positions from all connected users after real-time update
          if (webSocketClientRef.current) {
            setTimeout(() => {
              try {
                webSocketClientRef.current.send({
                  type: 'request_cursor_refresh_all',
                  data: {
                    requesterId: effectiveUserId,
                    requesterName: currentUser.name || currentUser.email,
                    timestamp: new Date().toISOString(),
                    reason: 'realtime_update_specialized'
                  }
                });
                console.log('📍 Requested cursor refresh from all users after specialized real-time update');
              } catch (error) {
                console.error('❌ Failed to request cursor refresh after specialized real-time update:', error);
              }
            }, 300); // Shorter delay for real-time updates
          }

          // Version-safe reset: only clear if no newer update arrived
          setTimeout(() => {
            if (remoteUpdateVersionRef.current === rtVersion) {
              isApplyingRealTimeUpdateRef.current = false;
            }
          }, 500);
        } catch (error) {
          console.error('❌ TrackedChangesEditor: Error applying real-time update via specialized function:', error);
          if (remoteUpdateVersionRef.current === rtVersion) {
            isApplyingRealTimeUpdateRef.current = false;
          }
        }
      } else if (remoteUpdateFunctionRef.current) {
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

          // Request cursor positions from all connected users after real-time update
          if (webSocketClientRef.current) {
            setTimeout(() => {
              try {
                webSocketClientRef.current.send({
                  type: 'request_cursor_refresh_all',
                  data: {
                    requesterId: effectiveUserId,
                    requesterName: currentUser.name || currentUser.email,
                    timestamp: new Date().toISOString(),
                    reason: 'realtime_update_fallback'
                  }
                });
                console.log('📍 Requested cursor refresh from all users after fallback real-time update');
              } catch (error) {
                console.error('❌ Failed to request cursor refresh after fallback real-time update:', error);
              }
            }, 300); // Shorter delay for real-time updates
          }

          // Version-safe reset: only clear if no newer update arrived
          setTimeout(() => {
            if (remoteUpdateVersionRef.current === rtVersion) {
              isApplyingRealTimeUpdateRef.current = false;
            }
          }, 500);
        } catch (error) {
          console.error('❌ TrackedChangesEditor: Error applying real-time update via fallback function:', error);
          if (remoteUpdateVersionRef.current === rtVersion) {
            isApplyingRealTimeUpdateRef.current = false;
          }
        }
      } else {
        // Fallback to state update - but only if we have valid Lexical content
        if (lexicalContent && isLexicalJson(lexicalContent)) {
          // Set flag to prevent feedback loop
          isApplyingRealTimeUpdateRef.current = true;

          setEditedProposedContent(lexicalContent);

          // Version-safe reset
          setTimeout(() => {
            if (remoteUpdateVersionRef.current === rtVersion) {
              isApplyingRealTimeUpdateRef.current = false;
            }
          }, 500);
        } else {
          console.error('❌ TrackedChangesEditor: Cannot apply real-time update - invalid Lexical content');
        }
      }

      return; // Exit early for real-time updates
    }

    // Handle regular content updates (auto-save, manual save)
    if (message.type === 'content_updated' && message.data) {
      const { field, newValue, lexicalContent, isAutoSave, cursorPosition, preserveEditingState } = message.data;
      console.log(`[WS-CONTENT] content_updated received: field=${field}, hasLexical=${!!lexicalContent}, isAutoSave=${isAutoSave}`);

      if (field === 'proposedVersions.richTextContent' && lexicalContent) {
        // Apply remote content updates
        {
          // Bump the version counter FIRST, then set the flag.
          // The timeout callback only clears the flag if the version
          // hasn't changed — a newer update arriving in the meantime
          // keeps the flag alive automatically.
          const thisVersion = ++remoteUpdateVersionRef.current;
          isApplyingRealTimeUpdateRef.current = true;

          // Show visual feedback that a remote update is being applied
          setRemoteUpdateStatus('applying');

          // Apply the content update through the CollaborativeEditor
          if (remoteUpdateFunctionRef.current) {
            try {
              remoteUpdateFunctionRef.current(lexicalContent);
            } catch (error) {
              console.error('❌ TrackedChangesEditor: Error calling remote update function:', error);
            }
          } else {
            setEditedProposedContent(lexicalContent);
          }

          // Also update our state — both React state AND the ref synchronously.
          // Synchronous ref update ensures editedProposedContentRef.current is
          // up-to-date if onContentChange fires later (preventing the
          // TransactionManager from using stale before-state).
          setEditedProposedContent(lexicalContent);
          editedProposedContentRef.current = lexicalContent;
          setLastSavedProposedContent(lexicalContent);

          // Show applied status briefly
          setRemoteUpdateStatus('applied');
          setTimeout(() => {
            setRemoteUpdateStatus('none');
          }, 2000);

          // Request cursor positions from all connected users after remote update
          if (webSocketClientRef.current) {
            setTimeout(() => {
              try {
                webSocketClientRef.current.send({
                  type: 'request_cursor_refresh_all',
                  data: {
                    requesterId: effectiveUserId,
                    requesterName: currentUser.name || currentUser.email,
                    timestamp: new Date().toISOString(),
                    reason: 'content_updated'
                  }
                });
                console.log('📍 Requested cursor refresh from all users after remote update');
              } catch (error) {
                console.error('❌ Failed to request cursor refresh:', error);
              }
            }, 500); // Wait for content to settle before requesting cursors
          }

          // Version-safe flag reset: only clear if no newer update arrived.
          // Covers downstream processing (applyDecorations ~300ms, cursor
          // restoration ~200-400ms, potential decoration re-runs). The 1500ms
          // delay is a ceiling; the version check means rapid updates won't
          // leave stale flags behind.
          setTimeout(() => {
            if (remoteUpdateVersionRef.current === thisVersion) {
              isApplyingRealTimeUpdateRef.current = false;
            }
          }, 1500);

          // NOTE: Do NOT call onRefreshNeeded() here. The content is already
          // applied via remoteUpdateFunctionRef above. Calling onRefreshNeeded
          // triggers fetchSubmission → setSubmission → proposedEditorContent
          // recalculation → editor re-initialization, which causes the
          // TransactionManager to detect a phantom "change" and create a
          // spurious tracked change. Change list/status refreshes are handled
          // by their own WebSocket events (change_status_updated, etc.).
        }
      }
    }
  }, [currentUser.id, currentUser.email, onRefreshNeeded]);

  // Store WebSocket client reference
  const handleWebSocketClientRef = useCallback((client: any) => {
    webSocketClientRef.current = client;

    if (client) {
      // Listen for content updates
      client.on('content_updated', handleWebSocketUpdate);

      // Listen for real-time content updates (character-by-character)
      client.on('realtime_content_update', handleWebSocketUpdate);

      // Listen for cursor position updates to track current user's position
      client.on('cursor_position', (message: any) => {
        if (message.userId === (currentUser.id || currentUser.email)) {
          // Store our own cursor position for use in auto-save messages
          lastCursorPositionRef.current = message.data;
        }
      });

      // Listen for connection status changes
      client.on('connection_lost', () => {
        setWsConnectionLost(true);
      });
      client.on('connection_restored', () => {
        setWsConnectionLost(false);
        // Refresh data after reconnection to pick up missed updates.
        // Use guarded refresh to prevent phantom tracked changes from
        // the async fetchSubmission → editor re-init chain.
        refreshWithRemoteGuard();
      });

      // Listen for gap detection — refetch from REST API
      client.on('sync_needed', () => {
        console.log('🔄 Sync needed — refetching from REST API');
        refreshWithRemoteGuard();
      });

      // Listen for transaction-settled from remote users
      client.on('transaction_settled', (message: WebSocketMessage) => {
        if (message.userId === effectiveUserId) return;
        const data = message.data;
        if (!data?.changeId) return;
        // Trigger a refresh so the new tracked change appears in the sidebar
        refreshWithRemoteGuard();
      });

      // Listen for transaction-undone from remote users
      client.on('transaction_undone', (message: WebSocketMessage) => {
        if (message.userId === effectiveUserId) return;
        const data = message.data;
        if (!data?.removedChangeIds || !Array.isArray(data.removedChangeIds)) return;
        // Remove decorations for each undone change
        for (const id of data.removedChangeIds) {
          try {
            removeDecorationsForChange(id);
          } catch (err) {
            console.error('Failed to remove decorations for undone change:', id, err);
          }
        }
        // Trigger a refresh so the sidebar updates
        refreshWithRemoteGuard();
      });

      // Listen for transaction-redone from remote users
      client.on('transaction_redone', (message: WebSocketMessage) => {
        if (message.userId === effectiveUserId) return;
        const data = message.data;
        if (!data?.changeId) return;
        // Trigger a refresh so the re-added tracked change appears
        refreshWithRemoteGuard();
      });

      // Listen for change status updates (accept/reject) from remote users
      client.on('change_status_updated', (message: WebSocketMessage) => {
        console.log(`[WS-STATUS] change_status_updated: userId=${message.userId}, effectiveUserId=${effectiveUserId}, changeId=${message.data?.changeId}, status=${message.data?.status}`);
        if (message.userId === effectiveUserId) return;
        const data = message.data;
        if (!data?.changeId || !data?.status) return;
        console.log(`[WS-STATUS] Processing remote change_status_updated — removing decorations and updating status locally`);
        // Guard with __isApplyingDecorations to prevent TransactionManager
        // from treating the decoration removal as a user edit
        (window as any).__isApplyingDecorations = true;
        // Remove decorations for the resolved change
        try {
          removeDecorationsForChange(data.changeId);
        } catch (err) {
          console.error('Failed to remove decorations for resolved change:', data.changeId, err);
        }
        setTimeout(() => {
          (window as any).__isApplyingDecorations = false;
        }, 100);
        // Update the change status locally instead of calling onRefreshNeeded().
        // A full submission refetch would trigger proposedEditorContent →
        // initialContent change → editor re-initialization → phantom tracked change.
        if (onRemoteChangeResolved) {
          onRemoteChangeResolved(data.changeId, data.status);
        }
      });
    }
  }, [handleWebSocketUpdate, currentUser.id, currentUser.email, effectiveUserId, onRemoteChangeResolved, refreshWithRemoteGuard]);

  // TransactionHistoryPlugin callback: broadcast undo over WebSocket
  const handleTransactionUndone = useCallback((tx: Transaction) => {
    const client = webSocketClientRef.current;
    if (!client) return;
    const removedIds: string[] = [];
    if (tx.remoteChangeId) {
      removedIds.push(tx.remoteChangeId);
      // Optimistically hide the change locally
      setLocalRemovedChangeIds(prev => {
        const next = new Set(prev);
        next.add(tx.remoteChangeId!);
        return next;
      });
    }
    if (removedIds.length > 0) {
      client.sendTransactionUndone(removedIds);

      // If we are undoing a tracked change natively, tell the plugin to restore it
      for (const id of removedIds) {
        window.dispatchEvent(new CustomEvent('resolve-tracked-change', {
          detail: { changeId: id, action: 'reject' } // Undo means reject/restore
        }));
      }
    }
    // Refresh sidebar
    if (onRefreshNeeded) {
      onRefreshNeeded();
    }
  }, [onRefreshNeeded]);

  // TransactionHistoryPlugin callback: broadcast redo over WebSocket
  const handleTransactionRedone = useCallback((tx: Transaction) => {
    const client = webSocketClientRef.current;
    if (!client || !tx.remoteChangeId || !tx.afterSnapshot) return;

    // Optimistically unhide the change locally if it was hidden
    setLocalRemovedChangeIds(prev => {
      const next = new Set(prev);
      next.delete(tx.remoteChangeId!);
      return next;
    });

    client.sendTransactionRedone({
      changeId: tx.remoteChangeId,
      field: tx.field,
      oldValue: tx.beforeSnapshot.text,
      newValue: tx.afterSnapshot.text,
      regionMap: tx.regionMap ?? undefined,
    });
    // Refresh sidebar
    if (onRefreshNeeded) {
      onRefreshNeeded();
    }
  }, [onRefreshNeeded]);

  // Cleanup real-time update timers on unmount
  useEffect(() => {
    return () => {
      if (realTimeUpdateTimeoutRef.current) {
        clearTimeout(realTimeUpdateTimeoutRef.current);
      }
      if (realTimeUpdateIntervalRef.current) {
        clearInterval(realTimeUpdateIntervalRef.current);
      }
    };
  }, []);

  // Handle sidebar auto-collapse based on available space
  useEffect(() => {
    let resizeTimeout: NodeJS.Timeout;
    let lastResizeTime = 0;
    const DEBOUNCE_DELAY = 300; // Increased debounce to prevent bouncing
    const MIN_RESIZE_INTERVAL = 500; // Minimum time between auto-collapse/expand actions

    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        const now = Date.now();
        const isSmallScreen = window.innerWidth <= 768;
        setIsSmallScreen(isSmallScreen);

        if (isSmallScreen) {
          // On mobile, only auto-collapse if it was previously auto-collapsed
          if (!sidebarCollapsedRef.current && sidebarAutoCollapsedRef.current) {
            console.log('📱 Mobile: Keeping auto-collapsed');
            setSidebarCollapsed(true);
          }
        } else {
          // On desktop, check if sidebar is impacting editor size
          const editorContainer = editorRef.current;
          if (editorContainer) {
            const containerWidth = editorContainer.offsetWidth;
            const sidebarWidth = 350; // Approximate sidebar width when expanded
            const minEditorWidth = 600; // Minimum width needed for comfortable editing

            const availableWidth = containerWidth - sidebarWidth;
            const shouldCollapse = availableWidth < minEditorWidth;

            console.log(`🖥️ Desktop: containerWidth=${containerWidth}, availableWidth=${availableWidth}, shouldCollapse=${shouldCollapse}, sidebarCollapsed=${sidebarCollapsedRef.current}, sidebarAutoCollapsed=${sidebarAutoCollapsedRef.current}`);

            // Only trigger auto-collapse/expand if enough time has passed since last action
            if (now - lastResizeTime > MIN_RESIZE_INTERVAL) {
              if (shouldCollapse && !sidebarCollapsedRef.current && !sidebarAutoCollapsedRef.current) {
                // Auto-collapse when space is limited (only if not already auto-collapsed)
                console.log('🖥️ Desktop: Auto-collapsing due to space constraints');
                setSidebarAutoCollapsed(true);
                setSidebarCollapsed(true);
                lastResizeTime = now;
              } else if (!shouldCollapse && sidebarCollapsedRef.current && sidebarAutoCollapsedRef.current) {
                // Auto-expand when space becomes available (only if it was auto-collapsed)
                console.log('🖥️ Desktop: Auto-expanding due to sufficient space');
                setSidebarAutoCollapsed(false);
                setSidebarCollapsed(false);
                lastResizeTime = now;
              }
            } else {
              console.log('⏱️ Skipping auto-collapse/expand due to minimum interval');
            }
          }
        }
      }, DEBOUNCE_DELAY);
    };

    // Check initial screen size (but skip auto-collapse on first render to honor default expanded state)
    const initialSmallScreen = window.innerWidth <= 768;
    setIsSmallScreen(initialSmallScreen);

    // Add event listener
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimeout);
    };
  }, []); // Remove dependencies to prevent infinite loop



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

  // Toggle sidebar collapse
  const toggleSidebar = useCallback(() => {
    console.log('🔧 Manual toggle clicked. Current state:', { sidebarCollapsed, sidebarAutoCollapsed, isSmallScreen });
    setSidebarCollapsed(prev => {
      const newState = !prev;
      console.log('🔧 Setting sidebarCollapsed to:', newState);

      // If expanding on mobile, scroll to show the content
      if (newState === false && isSmallScreen) {
        // Use setTimeout to ensure the DOM has updated before scrolling
        setTimeout(() => {
          const mobileSidebarSection = document.querySelector('.mobile-sidebar-section');
          if (mobileSidebarSection) {
            mobileSidebarSection.scrollIntoView({
              behavior: 'smooth',
              block: 'start',
              inline: 'nearest'
            });
          }
        }, 100);
      }

      return newState;
    });
    setSidebarAutoCollapsed(false); // Clear auto-collapse flag when manually toggled
    console.log('🔧 Cleared sidebarAutoCollapsed flag');
  }, [sidebarCollapsed, sidebarAutoCollapsed, isSmallScreen]);

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
    console.log(`[CONTENT-MEMO] proposedEditorContent recalculated. Source: ${submission.proposedVersions?.richTextContent ? 'proposedVersions.richTextContent' : submission.proposedVersions?.content ? 'proposedVersions.content' : submission.richTextContent ? 'richTextContent' : 'content'}, first 150 chars:`, content.substring(0, 150));

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

    return result;
  }, [submission.proposedVersions?.richTextContent, submission.proposedVersions?.content, submission.richTextContent, submission.content]);

  return (
    <div className={`tracked-changes-editor ${reviewMode ? 'review-mode' : ''}`}>
      {/* Error toast */}
      {errorToast && (
        <div className="tce-error-toast" onClick={() => setErrorToast(null)}>
          {errorToast}
        </div>
      )}
      {/* Connection lost banner */}
      {wsConnectionLost && (
        <div className="tce-connection-lost-banner">
          Connection lost — reconnecting...
        </div>
      )}
      {/* Collaborative Editor handles its own WebSocket status and user presence */}

      {!reviewMode && <div className="editor-toolbar" ref={toolbarRef}>
        <div className="toolbar-left">
          {onBack && (
            <button onClick={onBack} className="toolbar-back-btn" title="Back to requests">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
            </button>
          )}
          <span className="toolbar-value">
            {proposedTitle || submission.title}
          </span>
        </div>
        <div className="toolbar-right">
          <div className="auto-save-status">
            {/* Remote update status */}
            {remoteUpdateStatus === 'applying' && (
              <span className="save-status applying">
                Syncing...
              </span>
            )}
            {remoteUpdateStatus === 'applied' && (
              <span className="save-status applied">
                Synced
              </span>
            )}

            {/* SaveIndicator — replaces the old auto-save text */}
            <SaveIndicator
              transactionManager={transactionManager}
              submissionId={submission.id}
              getLatestEditorState={getLatestEditorState}
            />

            {/* Manual save button — settles any active transaction then saves */}
            <button
              className="manual-save-button"
              onClick={() => {
                // Force-settle the active transaction if one exists
                const currentState = editedProposedContentRef.current;
                if (currentState && transactionManager.getActiveTransaction()) {
                  transactionManager.settleTransaction(currentState);
                }
                handleProposedEditSubmit();
              }}
              disabled={editedProposedContent === lastSavedProposedContent}
              title="Save changes now"
            >
              Save
            </button>
            {onReset && (
              <button
                className="manual-save-button"
                style={{ marginLeft: '8px', backgroundColor: '#fee2e2', color: '#b91c1c', borderColor: '#fca5a5' }}
                onClick={() => setShowResetConfirm(true)}
                title="Reset to Original"
              >
                Reset
              </button>
            )}
            {onDelete && (
              <button
                className="manual-save-button"
                style={{ marginLeft: '8px', backgroundColor: '#fee2e2', color: '#b91c1c', borderColor: '#fca5a5' }}
                onClick={() => setShowDeleteConfirm(true)}
                title="Delete Submission"
              >
                <i className="fas fa-trash-alt" style={{ marginRight: '4px' }} />
                Delete
              </button>
            )}
          </div>
          <div className="change-stats">
            <span className="stat pending">
              {`${trackedChanges.filter(c => c.status === 'pending').length} pending`}
            </span>
            <span className="stat approved">
              {`${trackedChanges.filter(c => c.status === 'approved').length} approved`}
            </span>
            <span className="stat rejected">
              {`${trackedChanges.filter(c => c.status === 'rejected').length} rejected`}
            </span>
          </div>
          {(submission as any).approvalGates && (
            <ApprovalTracker
              variant="compact"
              gates={(submission as any).approvalGates as ApprovalGates}
              onNavigateToChanges={() => {
                const changesSection = document.querySelector('.changes-list');
                if (changesSection) {
                  changesSection.scrollIntoView({ behavior: 'smooth' });
                }
              }}
            />
          )}
        </div>
      </div>}

      <div className="editor-container">
        <div className={`editor-content ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`} ref={editorRef}>
          <div className={reviewMode ? 'editor-document-page' : undefined}>
          <div className="document-title-row" data-field-id="title">
            {editingTitle ? (
              <div className="field-edit-row">
                <input
                  className="field-edit-input title-edit-input"
                  value={proposedTitle}
                  onChange={(e) => setProposedTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleFieldChange('title', submission.title, proposedTitle);
                      setEditingTitle(false);
                    } else if (e.key === 'Escape') {
                      setProposedTitle(submission.proposedVersions?.title || submission.title);
                      setEditingTitle(false);
                    }
                  }}
                  onBlur={() => {
                    handleFieldChange('title', submission.title, proposedTitle);
                    setEditingTitle(false);
                  }}
                  autoFocus
                />
              </div>
            ) : (
              <h1
                className="document-title editable-field"
                onClick={() => setEditingTitle(true)}
                title="Click to edit title"
              >
                {proposedTitle}
                <i className="fas fa-pencil-alt field-edit-icon"></i>
              </h1>
            )}
          </div>

          <div className="document-field-row" data-field-id="replyToAddress">
            <span className="field-row-label">Reply-To:</span>
            {editingReplyTo ? (
              <div className="field-edit-row">
                <input
                  className="field-edit-input reply-to-edit-input"
                  type="email"
                  value={proposedReplyTo}
                  onChange={(e) => setProposedReplyTo(e.target.value)}
                  placeholder="Reply-to email address"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleFieldChange('replyToAddress', replyToValue, proposedReplyTo);
                      setEditingReplyTo(false);
                    } else if (e.key === 'Escape') {
                      setProposedReplyTo(submission.proposedVersions?.replyToAddress || replyToValue);
                      setEditingReplyTo(false);
                    }
                  }}
                  onBlur={() => {
                    handleFieldChange('replyToAddress', replyToValue, proposedReplyTo);
                    setEditingReplyTo(false);
                  }}
                  autoFocus
                />
              </div>
            ) : (
              <span
                className="field-row-value editable-field"
                onClick={() => setEditingReplyTo(true)}
                title="Click to edit reply-to address"
              >
                {proposedReplyTo || 'Not specified'}
                <i className="fas fa-pencil-alt field-edit-icon"></i>
              </span>
            )}
          </div>

          <div className="document-field-row" data-field-id="audience">
            <span className="field-row-label">Audience:</span>
            {editingAudience ? (
              <div className="audience-edit-container">
                <div className="tce-audience-grid">
                  {Object.entries(AUDIENCE_LABELS).map(([value, label]) => {
                    const checked = proposedAudienceArr.includes(value);
                    return (
                      <label key={value} className={`tce-audience-option ${checked ? 'selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const next = checked
                              ? proposedAudienceArr.filter(v => v !== value)
                              : [...proposedAudienceArr, value];
                            setProposedAudienceArr(next);
                          }}
                        />
                        <span className="tce-audience-label">{label}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="audience-edit-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      const newVal = proposedAudienceArr.join(', ');
                      handleFieldChange('audience', audienceDisplay, newVal);
                      setEditingAudience(false);
                    }}
                  >
                    Save
                  </button>
                  <button
                    className="btn btn-neutral btn-sm"
                    onClick={() => {
                      const proposed = submission.proposedVersions?.audience;
                      if (proposed) {
                        setProposedAudienceArr(parseAudienceToKeys(proposed));
                      } else {
                        setProposedAudienceArr(audienceArray);
                      }
                      setEditingAudience(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <span
                className="field-row-value editable-field"
                onClick={() => setEditingAudience(true)}
                title="Click to edit audience"
              >
                {proposedAudienceArr.map(v => AUDIENCE_LABELS[v] || v).join(', ') || 'Not specified'}
                <i className="fas fa-pencil-alt field-edit-icon"></i>
              </span>
            )}
          </div>

          <div className="document-meta">
            <span>Submitted by {submission.submittedBy}</span>
            <span className="separator">•</span>
            <span>{new Date(submission.submittedAt).toLocaleDateString()}</span>
          </div>

          <div className="document-body">
            {/* Tab bar for switching between sections */}
            <div className="tce-tab-bar">
              <button
                className={`tce-tab ${activeTab === 'proposed' ? 'active' : ''}`}
                onClick={() => setActiveTab('proposed')}
              >
                Proposed Version
              </button>
              <button
                className={`tce-tab ${activeTab === 'comparison' ? 'active' : ''}`}
                onClick={() => setActiveTab('comparison')}
              >
                Content Comparison
              </button>
              <button
                className={`tce-tab ${activeTab === 'original' ? 'active' : ''}`}
                onClick={() => setActiveTab('original')}
              >
                Original Version
              </button>
              {['approved', 'comms_approved', 'sent'].includes(submission.status) ? (
                <button
                  className={`tce-tab ${activeTab === 'send' ? 'active' : ''}`}
                  onClick={() => setActiveTab('send')}
                >
                  Send
                </button>
              ) : (
                <div className="tce-tab-bar__send-pending">
                  {(submission as any).approvalGates && (
                    <div className="tce-tab-bar__status-badge">
                      <ApprovalTracker
                        variant="compact"
                        gates={(submission as any).approvalGates as ApprovalGates}
                      />
                    </div>
                  )}
                  <span className="tce-tab tce-tab--disabled">Send</span>
                </div>
              )}
            </div>

            {/* Proposed Version */}
            {activeTab === 'proposed' && <div className="proposed-version-section">
              {/* Action bar - only shown when there are actions available */}
              {(submission.status === 'in_review' || (canApproveProposedVersion() && !isProposedVersionApproved) || (isProposedVersionApproved && proposedVersionApprovalInfo)) && (
                <div className="proposed-actions-bar">
                  {/* Submission-level Approve/Reject controls */}
                  {submission.status === 'in_review' && (
                    <>
                      <button
                        className={`btn btn-primary btn-sm ${hasApprovedSubmission || hasPendingTrackedChanges ? 'opacity-50 cursor-not-allowed' : ''}`}
                        onClick={() => { if (!hasApprovedSubmission && !hasPendingTrackedChanges) { onSubmissionApprove ? onSubmissionApprove(submission) : undefined; } }}
                        disabled={hasApprovedSubmission || hasPendingTrackedChanges}
                        title={hasPendingTrackedChanges ? 'Resolve all pending tracked changes before approving' : 'Approve submission'}
                      >
                        Approve
                      </button>
                      <button
                        className={`btn btn-danger btn-sm ${hasRejectedSubmission ? 'opacity-50 cursor-not-allowed' : ''}`}
                        onClick={() => { if (!hasRejectedSubmission) { onSubmissionReject ? onSubmissionReject(submission) : undefined; } }}
                        disabled={hasRejectedSubmission}
                        title="Reject submission"
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {canApproveProposedVersion() && !isProposedVersionApproved && (
                    <button
                      className="btn btn-primary approve-button"
                      onClick={() => setShowProposedVersionApprovalDialog(true)}
                      title="Approve proposed version"
                    >
                      Approve Proposed
                    </button>
                  )}
                  {isProposedVersionApproved && proposedVersionApprovalInfo && (
                    <div className="approval-info">
                      <span className="approved-badge">
                        Approved by {proposedVersionApprovalInfo.approverId}
                      </span>
                      {proposedVersionApprovalInfo.comment && (
                        <span className="approval-comment">
                          "{proposedVersionApprovalInfo.comment}"
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
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
                        return;
                      }
                      // Log when content changes happen during resolution
                      if (isResolvingChangeRef.current || transactionManager.isPausedForResolution()) {
                        console.log(`[CONTENT-CHANGE] During resolution: isPaused=${transactionManager.isPausedForResolution()}, isResolving=${isResolvingChangeRef.current}, first 150:`, json?.substring(0, 150));
                      }

                      // If this onChange was triggered by a programmatic content refresh
                      // (e.g. after a rejection), clear the flag and skip tracking.
                      if (isRefreshingContentRef.current) {
                        isRefreshingContentRef.current = false;
                        setEditedProposedContent(json);
                        return;
                      }

                      // Skip TransactionManager during change resolution (approve/reject).
                      if (transactionManager.isPausedForResolution()) {
                        setEditedProposedContent(json);
                        return;
                      }

                      // Skip TransactionManager during programmatic decoration updates
                      // (applyDecorations inserts/removes DeletedTextNodes).
                      if ((window as any).__isApplyingDecorations) {
                        setEditedProposedContent(json);
                        return;
                      }

                      setEditedProposedContent(json);

                      // Wire TransactionManager: start or continue a transaction
                      if (!isApplyingRealTimeUpdateRef.current) {
                        if (!hasActiveTransactionRef.current) {
                          // First change in this editing sequence — start a new transaction
                          const beforeState = editedProposedContentRef.current || json;
                          transactionManager.startTransaction('content', beforeState);
                          hasActiveTransactionRef.current = true;
                        }
                        // Notify activity to reset the pause timer with latest state
                        transactionManager.notifyActivity(json);
                      }

                      // Send real-time character-by-character updates immediately
                      const originalContent = submission.proposedVersions?.richTextContent || submission.richTextContent || submission.content || '';
                      const hasChanges = json !== originalContent;

                      if (hasChanges) {
                        // Check if we're applying a real-time update to prevent feedback loops
                        if (!isApplyingRealTimeUpdateRef.current) {
                          // Send immediate real-time update with cursor position
                          throttledRealTimeUpdate(json, cursorPosition);
                        }
                      }
                    }}
                    onSave={(content) => {
                      // Update the edited content with the saved content
                      setEditedProposedContent(content);
                      handleProposedEditSubmit();
                    }}
                    onWebSocketClientReady={handleWebSocketClientRef}
                    onRemoteContentUpdate={(updateFn) => {
                      remoteUpdateFunctionRef.current = updateFn;
                    }}
                    placeholder="Edit the proposed version..."
                    readOnly={false}
                    showToolbar={true}
                    className="proposed-collaborative-editor"
                    useSubmissionWebSocket={true}
                    trackedChanges={pendingContentChanges.length > 0 ? pendingContentChanges : undefined}
                    originalText={pendingContentChanges.length > 0 ? originalTextForInlineChanges : undefined}
                    onTrackedChangeClick={handleEditorTrackedChangeClick}
                    liveBaseline={originalTextForInlineChanges}
                    transactionManager={transactionManager}
                    onTransactionUndone={handleTransactionUndone}
                    onTransactionRedone={handleTransactionRedone}
                    interceptDeletions={true}
                  />
                </div>

                {/* Signature at bottom of proposed version */}
                <div className="document-signature-section">
                  <div className="document-field-row" data-field-id="signatureText">
                    <span className="field-row-label">Signature:</span>
                    {editingSignature ? (
                      <div className="field-edit-row">
                        <input
                          className="field-edit-input signature-edit-input"
                          value={proposedSignature}
                          onChange={(e) => setProposedSignature(e.target.value)}
                          placeholder="Signature text"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleFieldChange('signatureText', signatureValue, proposedSignature);
                              setEditingSignature(false);
                            } else if (e.key === 'Escape') {
                              setProposedSignature(submission.proposedVersions?.signatureText || signatureValue);
                              setEditingSignature(false);
                            }
                          }}
                          onBlur={() => {
                            handleFieldChange('signatureText', signatureValue, proposedSignature);
                            setEditingSignature(false);
                          }}
                          autoFocus
                        />
                      </div>
                    ) : (
                      <span
                        className="field-row-value editable-field"
                        onClick={() => setEditingSignature(true)}
                        title="Click to edit signature"
                      >
                        {proposedSignature || 'Not specified'}
                        <i className="fas fa-pencil-alt field-edit-icon"></i>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>}

            {/* Content Comparison */}
            {activeTab === 'comparison' && <div className="diff-section">
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

                  // Generate word-level diff for text.
                  // Always use diffWords here — smartDiff falls back to diffChars
                  // for short texts, which fragments words into per-character changes
                  // and makes the Original Version column look garbled.
                  const diff = diffWords(originalText, proposedText);

                  // Build position-based mapping of diff segments to tracked change IDs
                  // Track character offsets in original text (for delete segments) and proposed text (for insert segments)
                  const changePositionsInOriginal: Array<{ start: number; end: number; changeId: string }> = [];
                  const changePositionsInProposed: Array<{ start: number; end: number; changeId: string }> = [];
                  // Normalize whitespace helper for matching change text against document text
                  const normalizeWS = (s: string) => s.replace(/\s+/g, ' ').trim();
                  const normalizedOriginal = normalizeWS(originalText);
                  const normalizedProposed = normalizeWS(proposedText);
                  // Build a char-index map from normalized positions back to original positions
                  const buildNormMap = (text: string): number[] => {
                    const map: number[] = [];
                    let inWhitespace = false;
                    let started = false;
                    for (let i = 0; i < text.length; i++) {
                      if (/\s/.test(text[i])) {
                        if (started && !inWhitespace) {
                          map.push(i); // the normalized space
                          inWhitespace = true;
                        }
                      } else {
                        started = true;
                        inWhitespace = false;
                        map.push(i);
                      }
                    }
                    return map;
                  };
                  const origNormMap = buildNormMap(originalText);
                  const propNormMap = buildNormMap(proposedText);
                  for (const change of trackedChanges) {
                    const oldDisplayText = change.oldValue ? getChangeDisplayText(change.oldValue) : '';
                    const newDisplayText = change.newValue ? getChangeDisplayText(change.newValue) : '';
                    if (oldDisplayText) {
                      // Try direct match first, then normalized match
                      let pos = originalText.indexOf(oldDisplayText);
                      if (pos !== -1) {
                        changePositionsInOriginal.push({ start: pos, end: pos + oldDisplayText.length, changeId: change.id });
                      } else {
                        const normPos = normalizedOriginal.indexOf(normalizeWS(oldDisplayText));
                        if (normPos !== -1 && normPos < origNormMap.length) {
                          const mappedStart = origNormMap[normPos];
                          const endNorm = normPos + normalizeWS(oldDisplayText).length - 1;
                          const mappedEnd = endNorm < origNormMap.length ? origNormMap[endNorm] + 1 : mappedStart + oldDisplayText.length;
                          changePositionsInOriginal.push({ start: mappedStart, end: mappedEnd, changeId: change.id });
                        }
                      }
                    }
                    if (newDisplayText) {
                      let pos = proposedText.indexOf(newDisplayText);
                      if (pos !== -1) {
                        changePositionsInProposed.push({ start: pos, end: pos + newDisplayText.length, changeId: change.id });
                      } else {
                        const normPos = normalizedProposed.indexOf(normalizeWS(newDisplayText));
                        if (normPos !== -1 && normPos < propNormMap.length) {
                          const mappedStart = propNormMap[normPos];
                          const endNorm = normPos + normalizeWS(newDisplayText).length - 1;
                          const mappedEnd = endNorm < propNormMap.length ? propNormMap[endNorm] + 1 : mappedStart + newDisplayText.length;
                          changePositionsInProposed.push({ start: mappedStart, end: mappedEnd, changeId: change.id });
                        }
                      }
                    }
                  }

                  // Compute per-segment change IDs by tracking running offsets through the diff
                  let originalOffset = 0;
                  let proposedOffset = 0;
                  const segmentChangeIds: Map<number, string> = new Map();
                  diff.forEach((segment, index) => {
                    if (segment.type === 'delete') {
                      const segStart = originalOffset;
                      const segEnd = originalOffset + segment.value.length;
                      for (const cp of changePositionsInOriginal) {
                        if (segStart < cp.end && segEnd > cp.start) {
                          segmentChangeIds.set(index, cp.changeId);
                          break;
                        }
                      }
                      originalOffset = segEnd;
                    } else if (segment.type === 'insert') {
                      const segStart = proposedOffset;
                      const segEnd = proposedOffset + segment.value.length;
                      for (const cp of changePositionsInProposed) {
                        if (segStart < cp.end && segEnd > cp.start) {
                          segmentChangeIds.set(index, cp.changeId);
                          break;
                        }
                      }
                      proposedOffset = segEnd;
                    } else {
                      // equal: advances both
                      originalOffset += segment.value.length;
                      proposedOffset += segment.value.length;
                    }
                  });

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

                  // Build aligned rows: each row has left and right content.
                  // When a paragraph is deleted, right side gets a spacer (and vice versa).
                  type Seg = { type: string; value: string; index: number };
                  type AlignedRow = { left: Seg[]; right: Seg[] };

                  const buildAlignedRows = (): AlignedRow[] => {
                    const rows: AlignedRow[] = [];
                    let leftPara: Seg[] = [];
                    let rightPara: Seg[] = [];

                    const flushRow = () => {
                      if (leftPara.length > 0 || rightPara.length > 0) {
                        rows.push({ left: [...leftPara], right: [...rightPara] });
                        leftPara = [];
                        rightPara = [];
                      }
                    };

                    diff.forEach((segment, index) => {
                      const parts = segment.value.split('\n');
                      parts.forEach((part, partIndex) => {
                        if (partIndex > 0) {
                          if (segment.type === 'equal') {
                            flushRow();
                          } else if (segment.type === 'delete') {
                            // If left has only delete content and right is empty, flush as left-only
                            if (leftPara.length > 0 && leftPara.every(s => s.type === 'delete') && rightPara.length === 0) {
                              rows.push({ left: [...leftPara], right: [] });
                              leftPara = [];
                            } else {
                              flushRow();
                            }
                          } else if (segment.type === 'insert') {
                            // If right has only insert content and left is empty, flush as right-only
                            if (rightPara.length > 0 && rightPara.every(s => s.type === 'insert') && leftPara.length === 0) {
                              rows.push({ left: [], right: [...rightPara] });
                              rightPara = [];
                            } else {
                              flushRow();
                            }
                          }
                        }
                        if (part) {
                          const seg: Seg = { type: segment.type, value: part, index };
                          if (segment.type === 'equal') {
                            leftPara.push(seg);
                            rightPara.push(seg);
                          } else if (segment.type === 'delete') {
                            leftPara.push(seg);
                          } else if (segment.type === 'insert') {
                            rightPara.push(seg);
                          }
                        }
                      });
                    });
                    flushRow();

                    // Post-process: merge orphaned fragments (like stray punctuation)
                    // into the preceding row. This handles cases where the diff splits
                    // e.g. "people" and "." into separate segments across a paragraph break.
                    for (let i = rows.length - 1; i > 0; i--) {
                      const row = rows[i];
                      const prevRow = rows[i - 1];

                      const leftText = row.left.map(s => s.value).join('');
                      const rightText = row.right.map(s => s.value).join('');

                      // Right-only row with tiny content → merge into previous row's right side
                      if (row.left.length === 0 && row.right.length > 0 && prevRow.right.length > 0) {
                        if (rightText.length <= 3) {
                          prevRow.right.push(...row.right);
                          rows.splice(i, 1);
                          continue;
                        }
                      }
                      // Left-only row with tiny content → merge into previous row's left side
                      if (row.right.length === 0 && row.left.length > 0 && prevRow.left.length > 0) {
                        if (leftText.length <= 3) {
                          prevRow.left.push(...row.left);
                          rows.splice(i, 1);
                          continue;
                        }
                      }
                      // Row with substantial content on one side and tiny orphaned fragment
                      // on the other: merge the fragment into the previous row.
                      // E.g. diff splits "people" and "." across a paragraph boundary,
                      // leaving "." as an equal segment alongside the deleted paragraph.
                      if (row.left.length > 0 && row.right.length > 0) {
                        if (rightText.length <= 3 && leftText.length > 10 && prevRow.right.length > 0) {
                          prevRow.right.push(...row.right);
                          row.right = [];
                          // Also move equal segments from left to previous row's left,
                          // replacing any duplicate delete/insert segments with the same text
                          const equalSegs = row.left.filter(s => s.type === 'equal');
                          if (equalSegs.length > 0 && prevRow.left.length > 0) {
                            for (const eq of equalSegs) {
                              const dupeIdx = prevRow.left.findIndex(
                                s => s.type !== 'equal' && s.value === eq.value
                              );
                              if (dupeIdx >= 0) {
                                prevRow.left[dupeIdx] = eq;
                              } else {
                                prevRow.left.push(eq);
                              }
                            }
                            row.left = row.left.filter(s => s.type !== 'equal');
                          }
                          continue;
                        }
                        // Symmetric: substantial insert on right, tiny fragment on left
                        if (leftText.length <= 3 && rightText.length > 10 && prevRow.left.length > 0) {
                          prevRow.left.push(...row.left);
                          row.left = [];
                          const equalSegs = row.right.filter(s => s.type === 'equal');
                          if (equalSegs.length > 0 && prevRow.right.length > 0) {
                            for (const eq of equalSegs) {
                              const dupeIdx = prevRow.right.findIndex(
                                s => s.type !== 'equal' && s.value === eq.value
                              );
                              if (dupeIdx >= 0) {
                                prevRow.right[dupeIdx] = eq;
                              } else {
                                prevRow.right.push(eq);
                              }
                            }
                            row.right = row.right.filter(s => s.type !== 'equal');
                          }
                        }
                      }
                    }

                    return rows;
                  };

                  const alignedRows = buildAlignedRows();

                  const renderCell = (segments: Seg[]) => (
                    <div className="diff-paragraph">
                      {segments.map((seg, segIndex) => (
                        <span
                          key={`${seg.index}-${segIndex}`}
                          className={`diff-segment ${seg.type === 'delete' ? 'removed' : seg.type === 'insert' ? 'added' : 'unchanged'}`}
                          {...(segmentChangeIds.has(seg.index) ? { 'data-change-id': segmentChangeIds.get(seg.index) } : {})}
                        >
                          {seg.value}
                        </span>
                      ))}
                    </div>
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
                        <div className="diff-headers">
                          <h4>Original Version</h4>
                          <h4>Proposed Version</h4>
                        </div>
                        <div className="diff-body" ref={originalDiffTextRef}>
                          {alignedRows.map((row, rowIndex) => (
                            <div key={rowIndex} className="diff-row">
                              <div className={`diff-cell${row.left.length === 0 ? ' spacer' : ''}`}>
                                {row.left.length > 0 ? renderCell(row.left) : <div className="diff-spacer-content" />}
                              </div>
                              <div className={`diff-cell${row.right.length === 0 ? ' spacer' : ''}`}>
                                {row.right.length > 0 ? renderCell(row.right) : <div className="diff-spacer-content" />}
                              </div>
                            </div>
                          ))}

                          {/* Images */}
                          {(unchangedImages.length > 0 || removedImages.length > 0 || addedImages.length > 0) && (
                            <div className="diff-row">
                              <div className="diff-cell">
                                <div className="diff-images">
                                  {unchangedImages.map(image => renderImageInDiff(image, 'unchanged'))}
                                  {removedImages.map(image => renderImageInDiff(image, 'removed'))}
                                </div>
                              </div>
                              <div className="diff-cell">
                                <div className="diff-images">
                                  {unchangedImages.map(image => renderImageInDiff(image, 'unchanged'))}
                                  {addedImages.map(image => renderImageInDiff(image, 'added'))}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>}

            {/* Original Version */}
            {activeTab === 'original' && <div className="original-version-section">
              <div className="original-content">
                <h3 className="original-title">{submission.title}</h3>
                {replyToValue && (
                  <p className="original-field">Reply-To: {replyToValue}</p>
                )}
                {audienceDisplay && (
                  <p className="original-field">Audience: {audienceDisplay}</p>
                )}
                <div className="rich-text-display">
                  <LexicalEditorComponent
                    key="original-display-editor"
                    initialContent={getRichTextContent(submission.richTextContent || submission.content || '')}
                    readOnly={true}
                    showToolbar={false}
                    className="original-display-editor"
                  />
                </div>
                {signatureValue && (
                  <p className="original-field original-signature">Signature: {signatureValue}</p>
                )}
              </div>
            </div>}

            {/* Send Mode */}
            {activeTab === 'send' && <div className="send-mode-section">
              {(() => {
                const proposedTitle = (() => {
                  // Check proposed versions for a title
                  if (submission.proposedVersions?.title) return submission.proposedVersions.title;
                  return submission.title;
                })();

                const bodyContent = (() => {
                  const content = editedProposedContent || submission.proposedVersions?.richTextContent || submission.richTextContent || submission.content || '';
                  if (typeof content === 'string' && isLexicalJson(content)) {
                    return extractTextFromLexical(content);
                  }
                  if (typeof content === 'object' && isLexicalJson(content)) {
                    return extractTextFromLexical(content);
                  }
                  return typeof content === 'string' ? content : '';
                })();

                const audienceFields = submission.formFields?.filter(
                  (f) => f.id === 'audience' || f.label?.toLowerCase() === 'audience'
                ) || [];
                const audienceValues: string[] = audienceFields.flatMap((f) => {
                  if (Array.isArray(f.value)) return f.value as string[];
                  if (typeof f.value === 'string') {
                    try { return JSON.parse(f.value); } catch { return [f.value]; }
                  }
                  return [];
                });

                const emailAudiences = ['newsletter', 'singular', 'allcom'];
                const audienceKeys = audienceValues.map((v) => {
                  // Map from label to key if needed
                  const entry = Object.entries(AUDIENCE_LABELS).find(([, label]) => label === v);
                  return entry ? entry[0] : v;
                });
                const hasEmailAudience = audienceKeys.some((k) => emailAudiences.includes(k));
                const audienceLabels = audienceKeys.map((k) => AUDIENCE_LABELS[k] || k);

                const replyTo = submission.formFields?.find(
                  (f) => f.id === 'replyToAddress' || f.label?.toLowerCase()?.includes('reply')
                )?.value as string || '';
                const signature = submission.formFields?.find(
                  (f) => f.id === 'signatureText' || f.label?.toLowerCase()?.includes('signature')
                )?.value as string || '';

                const fullText = [
                  `Subject: ${proposedTitle}`,
                  '',
                  bodyContent,
                  signature ? `\n${signature}` : '',
                ].join('\n').trim();

                const isCommsCadreOrAdmin = currentUser.roles?.some(
                  (r) => ['CommsCadre', 'Admin'].includes(r)
                );

                const alreadySent = submission.status === 'sent';

                const handleCopy = async () => {
                  try {
                    await navigator.clipboard.writeText(fullText);
                    setSendCopied(true);
                    setTimeout(() => setSendCopied(false), 2000);
                  } catch {
                    // Fallback
                    const textarea = document.createElement('textarea');
                    textarea.value = fullText;
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textarea);
                    setSendCopied(true);
                    setTimeout(() => setSendCopied(false), 2000);
                  }
                };

                const handleSend = async () => {
                  if (!onSendEmail) return;
                  setSending(true);
                  setSendError(null);
                  try {
                    await onSendEmail();
                    setShowSendConfirm(false);
                  } catch (err: any) {
                    setSendError(err?.message || 'Failed to send email');
                  } finally {
                    setSending(false);
                  }
                };

                return (
                  <div className="send-mode-preview">
                    <div className="send-mode-email">
                      <div className="send-mode-field">
                        <span className="send-mode-label">Subject:</span>
                        <span className="send-mode-value">{proposedTitle}</span>
                      </div>
                      <div className="send-mode-field">
                        <span className="send-mode-label">To:</span>
                        <span className="send-mode-value">
                          {audienceLabels.length > 0 ? audienceLabels.join(', ') : 'No audience specified'}
                        </span>
                      </div>
                      {replyTo && (
                        <div className="send-mode-field">
                          <span className="send-mode-label">Reply-To:</span>
                          <span className="send-mode-value">{replyTo}</span>
                        </div>
                      )}
                      <div className="send-mode-divider" />
                      <div className="send-mode-body">
                        {bodyContent}
                      </div>
                      {signature && (
                        <>
                          <div className="send-mode-divider" />
                          <div className="send-mode-signature">{signature}</div>
                        </>
                      )}
                    </div>

                    <div className="send-mode-actions">
                      <button
                        className="btn btn-neutral"
                        onClick={handleCopy}
                      >
                        <i className={`fas ${sendCopied ? 'fa-check' : 'fa-copy'}`} style={{ marginRight: '6px' }} />
                        {sendCopied ? 'Copied!' : 'Copy to Clipboard'}
                      </button>

                      {!hasEmailAudience && (
                        <span className="send-mode-note">
                          <i className="fas fa-info-circle" style={{ marginRight: '4px' }} />
                          This submission is not an email item
                        </span>
                      )}

                      {hasEmailAudience && !alreadySent && isCommsCadreOrAdmin && onSendEmail && (
                        <button
                          className="btn btn-primary"
                          onClick={() => setShowSendConfirm(true)}
                          disabled={sending}
                        >
                          <i className="fas fa-paper-plane" style={{ marginRight: '6px' }} />
                          {sending ? 'Sending...' : 'Send Email'}
                        </button>
                      )}

                      {alreadySent && (
                        <span className="send-mode-sent-info">
                          <i className="fas fa-check-circle" style={{ marginRight: '4px', color: 'var(--accent-teal)' }} />
                          Sent{submission.sentBy ? ` by ${submission.sentBy}` : ''}
                          {submission.sentAt ? ` on ${new Date(submission.sentAt).toLocaleDateString()}` : ''}
                        </span>
                      )}

                      {sendError && (
                        <span className="send-mode-error">
                          <i className="fas fa-exclamation-circle" style={{ marginRight: '4px' }} />
                          {sendError}
                        </span>
                      )}
                    </div>

                    {/* Send Confirmation */}
                    {showSendConfirm && (
                      <div className="request-changes-overlay" onClick={() => setShowSendConfirm(false)}>
                        <div className="request-changes-dialog" onClick={e => e.stopPropagation()}>
                          <h3>Send Email</h3>
                          <p style={{ margin: '12px 0', color: '#666' }}>
                            Are you sure you want to send this announcement to {audienceLabels.join(', ')}? This action cannot be undone.
                          </p>
                          <div className="request-changes-actions">
                            <button className="btn btn-neutral" onClick={() => setShowSendConfirm(false)}>
                              Cancel
                            </button>
                            <button
                              className="btn btn-primary"
                              onClick={handleSend}
                              disabled={sending}
                            >
                              {sending ? 'Sending...' : 'Confirm Send'}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>}
          </div>{/* close editor-document-page wrapper */}

            {/* Mobile sidebar section - shown below content on small screens */}
            {isSmallScreen && (
              <div className="mobile-sidebar-section">
                <div className="mobile-sidebar-header">
                  <h3>Changes & Comments</h3>
                  <button
                    className="mobile-sidebar-toggle-btn"
                    onClick={toggleSidebar}
                    title={sidebarCollapsed ? "Expand changes" : "Collapse changes"}
                  >
                    {sidebarCollapsed ? '▼' : '▲'}
                  </button>
                </div>
                {!sidebarCollapsed && (
                  <div className="mobile-sidebar-content">
                    <div className="changes-list">
                      {trackedChanges.map(change => (
                        <div
                          key={change.id}
                          className={`change-item ${change.status} ${selectedChange === change.id ? 'selected' : ''}`}
                          onClick={() => handleChangeClick(change)}
                          data-change-id={change.id}
                        >
                          <div className="change-header">
                            <span className="change-author" title={change.changedBy}>{change.changedBy}</span>
                            <span className="change-time" title={new Date(change.timestamp).toLocaleString()}>
                              {formatRelativeTime(new Date(change.timestamp))}
                            </span>
                          </div>
                          {FIELD_DISPLAY_NAMES[change.field] && (
                            <div className="change-field-tag">
                              <span className="field-tag-badge">{FIELD_DISPLAY_NAMES[change.field]}</span>
                            </div>
                          )}
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
                                  {change.oldValue === change.newValue ? (
                                    // Format-only change — show descriptions
                                    describeFormatChanges(change.richTextOldValue, change.richTextNewValue).map((desc, i) => (
                                      <div key={i} style={{ fontSize: '12px', color: '#555', marginTop: '4px', lineHeight: '1.4' }}>
                                        {desc}
                                      </div>
                                    ))
                                  ) : (
                                    <>
                                      {change.oldValue && (
                                        <span className="diff-old" style={{ fontSize: '13px', lineHeight: '1.4' }}>
                                          <strong style={{ marginRight: '6px' }}>From:</strong>
                                          {renderCharDiff(change.oldValue, change.newValue || '', 'old')}
                                        </span>
                                      )}
                                      {change.newValue && (
                                        <span className="diff-new" style={{ fontSize: '13px', lineHeight: '1.4' }}>
                                          <strong style={{ marginRight: '6px' }}>To:</strong>
                                          {renderCharDiff(change.oldValue || '', change.newValue, 'new')}
                                        </span>
                                      )}
                                    </>
                                  )}
                                </>
                              ) : (
                                <>
                                  {change.oldValue && (
                                    <span className="diff-old" style={{ fontSize: '13px', lineHeight: '1.4' }}>
                                      <strong>Previous:</strong>{' '}{getChangeDisplayText(change.oldValue).substring(0, 100)}...
                                    </span>
                                  )}
                                  {change.newValue && (
                                    <span className="diff-new" style={{ fontSize: '13px', lineHeight: '1.4' }}>
                                      <strong>New:</strong>{' '}{getChangeDisplayText(change.newValue).substring(0, 100)}...
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
                                  title={expandedComments.has(change.id) ? "Collapse comments" : "Expand comments"}
                                >
                                  {expandedComments.has(change.id) ? '▼' : '▶'}
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
                )}
              </div>
            )}
          </div>
        </div>

        {/* Desktop sidebar - only shown on larger screens (always visible in review mode) */}
        {(!isSmallScreen || reviewMode) && (
          <div className={`editor-sidebar ${reviewMode ? 'review-panel' : ''} ${sidebarCollapsed && !reviewMode ? 'collapsed' : ''} ${sidebarAutoCollapsed ? 'auto-collapsed' : ''}`}>
            <div className="sidebar-header">
              <div className="sidebar-tabs">
                <button
                  className={`sidebar-tab-btn ${sidebarTab === 'changes' ? 'active' : ''}`}
                  onClick={() => setSidebarTab('changes')}
                >
                  Changes
                </button>
                <button
                  className={`sidebar-tab-btn ${sidebarTab === 'timeline' ? 'active' : ''}`}
                  onClick={() => setSidebarTab('timeline')}
                >
                  Timeline
                </button>
                {reviewMode && (
                  <button
                    className={`sidebar-tab-btn ${sidebarTab === 'comments' ? 'active' : ''}`}
                    onClick={() => setSidebarTab('comments')}
                  >
                    Comments
                  </button>
                )}
              </div>
              {!reviewMode && (
                <button
                  className="sidebar-toggle-btn"
                  onClick={toggleSidebar}
                  title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                >
                  {sidebarCollapsed ? '◀' : '▶'}
                </button>
              )}
            </div>
            {sidebarCollapsed && !isSmallScreen && (
              <div className="collapsed-sidebar-indicator">
                <div
                  className={`change-count-badge ${trackedChanges.filter(c => c.status === 'pending').length > 0 ? 'has-pending' : ''}`}
                  title={`${trackedChanges.filter(c => c.status === 'pending').length > 0 ? trackedChanges.filter(c => c.status === 'pending').length + ' pending' : trackedChanges.length + ' changes'}`}
                >
                  {trackedChanges.filter(c => c.status === 'pending').length || trackedChanges.length}
                </div>
              </div>
            )}
            {sidebarCollapsed && isSmallScreen && sidebarAutoCollapsed && (
              <div className="mobile-auto-collapsed-indicator">
                <span>💬 {trackedChanges.length} changes</span>
              </div>
            )}
            {(!sidebarCollapsed || reviewMode) && (
              <div className="sidebar-content">
                {sidebarTab === 'comments' ? (
                  <div className="sidebar-comments-content">
                    {submission.comments.length === 0 ? (
                      <p className="sidebar-empty-state">No comments yet.</p>
                    ) : (
                      <div className="submission-comments-list">
                        {submission.comments.map(comment => (
                          <div key={comment.id} className="submission-comment-item">
                            <div className="submission-comment-header">
                              <span className="submission-comment-author">{comment.authorId}</span>
                              <span className="submission-comment-time">
                                {formatRelativeTime(new Date(comment.createdAt))}
                              </span>
                            </div>
                            <p className="submission-comment-body">{comment.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : sidebarTab === 'timeline' ? (
                  <div className="sidebar-timeline-content">
                    <ActivityTimeline submissionId={submission.id} />
                  </div>
                ) : (
                  <>
                    {canMakeEditorialDecisions() && pendingChanges.length > 0 && (
                      <BatchActionBar
                        selectedCount={selectedChangeIds.size}
                        totalCount={pendingChanges.length}
                        onSelectAll={handleSelectAllChanges}
                        onDeselectAll={handleDeselectAllChanges}
                        onApproveSelected={() => handleBatchAction(Array.from(selectedChangeIds), 'approved')}
                        onRejectSelected={() => handleBatchAction(Array.from(selectedChangeIds), 'rejected')}
                        onApproveAll={() => handleBatchAction(pendingChanges.map(c => c.id), 'approved')}
                        onRejectAll={() => handleBatchAction(pendingChanges.map(c => c.id), 'rejected')}
                        disabled={batchActionLoading}
                      />
                    )}
                    <div className="changes-list">
                      {changeGroups.length === 0 && (
                        <p className="sidebar-empty-state">No tracked changes yet. Edits will appear here after saving.</p>
                      )}
                      {changeGroups.map((group, groupIndex) => (
                        <ChangeGroup
                          key={`${group.authorEmail}-${group.timestamp}`}
                          authorName={group.authorName}
                          authorEmail={group.authorEmail}
                          timestamp={group.timestamp}
                          changes={group.changes}
                          expanded={expandedGroups.has(groupIndex)}
                          onToggle={() => toggleGroupExpansion(groupIndex)}
                          onApproveGroup={() => handleBatchAction(
                            group.changes.filter(c => c.status === 'pending').map(c => c.id),
                            'approved'
                          )}
                          onRejectGroup={() => handleBatchAction(
                            group.changes.filter(c => c.status === 'pending').map(c => c.id),
                            'rejected'
                          )}
                          selectedIds={selectedChangeIds}
                          onToggleSelect={toggleChangeSelection}
                          canReview={canMakeEditorialDecisions()}
                          renderChange={(change) => (
                            <div
                              className={`change-item ${change.status} ${selectedChange === change.id ? 'selected' : ''}`}
                              onClick={() => handleChangeClick(change as any)}
                              data-change-id={change.id}
                            >
                              <div className="change-header">
                                <span className="change-author" title={change.changedBy}>{change.changedBy}</span>
                                <span className="change-time" title={new Date(change.timestamp).toLocaleString()}>
                                  {formatRelativeTime(new Date(change.timestamp))}
                                </span>
                              </div>
                              {FIELD_DISPLAY_NAMES[change.field] && (
                                <div className="change-field-tag">
                                  <span className="field-tag-badge">{FIELD_DISPLAY_NAMES[change.field]}</span>
                                </div>
                              )}
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
                                      {change.oldValue === change.newValue ? (
                                        // Format-only change — show descriptions
                                        describeFormatChanges(change.richTextOldValue, change.richTextNewValue).map((desc, i) => (
                                          <div key={i} style={{ fontSize: '12px', color: '#555', marginTop: '4px', lineHeight: '1.4' }}>
                                            {desc}
                                          </div>
                                        ))
                                      ) : (
                                        <>
                                          {change.oldValue && (
                                            <span className="diff-old" style={{ fontSize: '13px', lineHeight: '1.4' }}>
                                              <strong style={{ marginRight: '6px' }}>From:</strong>
                                              {renderCharDiff(change.oldValue, change.newValue || '', 'old')}
                                            </span>
                                          )}
                                          {change.newValue && (
                                            <span className="diff-new" style={{ fontSize: '13px', lineHeight: '1.4' }}>
                                              <strong style={{ marginRight: '6px' }}>To:</strong>
                                              {renderCharDiff(change.oldValue || '', change.newValue, 'new')}
                                            </span>
                                          )}
                                        </>
                                      )}
                                    </>
                                  ) : (
                                    <>
                                      {change.oldValue && (
                                        <span className="diff-old" style={{ fontSize: '13px', lineHeight: '1.4' }}>
                                          <strong>Previous:</strong>{' '}{getChangeDisplayText(change.oldValue).substring(0, 100)}...
                                        </span>
                                      )}
                                      {change.newValue && (
                                        <span className="diff-new" style={{ fontSize: '13px', lineHeight: '1.4' }}>
                                          <strong>New:</strong>{' '}{getChangeDisplayText(change.newValue).substring(0, 100)}...
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
                              {(change as any).comments && (change as any).comments.length > 0 && (
                                <div className="change-comments">
                                  <div className="comments-header">
                                    <span className="comments-count">{(change as any).comments.length} comment{(change as any).comments.length !== 1 ? 's' : ''}</span>
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
                                      {organizeCommentsIntoTree((change as any).comments).map((comment: any) =>
                                        renderCommentTree(comment, change.id)
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
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

      {/* Reset Confirmation Modal */}
      {showResetConfirm && (
        <div className="request-changes-overlay" onClick={() => setShowResetConfirm(false)}>
          <div className="request-changes-dialog" onClick={e => e.stopPropagation()}>
            <h3>Reset Document</h3>
            <p style={{ margin: '12px 0', color: '#666' }}>
              Are you sure you want to reset this document to its original state and delete all tracked changes? This cannot be undone.
            </p>
            <div className="request-changes-actions">
              <button className="btn btn-neutral" onClick={() => setShowResetConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setShowResetConfirm(false);
                  onReset?.();
                }}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="request-changes-overlay" onClick={() => setShowDeleteConfirm(false)}>
          <div className="request-changes-dialog" onClick={e => e.stopPropagation()}>
            <h3>Delete Submission</h3>
            <p style={{ margin: '12px 0', color: '#666' }}>
              Are you sure you want to delete &ldquo;{submission.title}&rdquo;? This cannot be undone.
            </p>
            <div className="request-changes-actions">
              <button className="btn btn-neutral" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  onDelete?.();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};