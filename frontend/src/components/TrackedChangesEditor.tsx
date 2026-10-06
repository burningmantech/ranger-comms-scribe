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
import SaveStatus from './SaveStatus';
import DocumentViewBar from './DocumentViewBar';
import { addDecorationsForChange, removeDecorationsForChange, TrackedChange as PluginTrackedChange, ResolveTrackedChangeDetail, getActiveTrackedChangesEditor, reapplyRejectedChanges } from './editor/plugins/TrackedChangesPlugin';
import ApprovalTracker from './ApprovalTracker';
import { ReviewPanel, ReviewTab } from './review/ReviewPanel';
import { UndoToast } from './review/UndoToast';
import { changeIdAtPoint, revealChangeInEditor } from './editor/collab/changeReveal';
import { locateChange } from './editor/collab/rejectRestore';
import { collectTextNodes, detectInlineFormatChanges, describeChange, ChangeDescription } from '../utils/changeDescriptions';
import { ChangeCard, HistoryEntry, OpenItem, buildHistory, buildOpenItems, commentChangeId, pendingOnly } from '../utils/reviewItems';
import { ApprovalGates } from '../types/content';
import type { CollabMode } from '../services/collabConfig';
import type { CollabSession } from './editor/collab/YjsCollaboration';
import type { LocalEditSession } from './editor/collab/localEditTracker';
import './TrackedChangesEditor.css';
import { UserName } from './UserName';
import { applyChangeStatus, ChangeResolver, mergeLocalChanges, resolvedChangeIds } from '../utils/changeStatus';

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

interface TrackedChangesEditorProps {
  submission: ContentSubmission;
  currentUser: User;
  onSave: (submission: ContentSubmission) => void;
  onComment: (comment: Comment) => void;
  onApprove: (changeId: string) => void;
  onReject: (changeId: string) => void;
  onSuggestion: (suggestion: Change) => void;
  onUndo: (changeId: string) => void;
  onRefreshNeeded?: () => void;
  onRemoteChangeResolved?: (changeId: string, status: string, resolver?: ChangeResolver) => void;
  onBack?: () => void;
  onDelete?: () => void;
  onSendEmail?: () => Promise<void>;
  reviewMode?: boolean;
  /**
   * 'yjs': merged real-time editing (PRD §14). The editor syncs through Yjs, only the
   * local user's own edits become tracked changes, and refreshes update the changes
   * sidebar only. Default 'legacy': whole-document sync, unchanged.
   */
  collabMode?: CollabMode;
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

/** A decision (or undo) known locally before the change records catch up. */
interface StatusOverride {
  status: 'pending' | 'approved' | 'rejected';
  resolverId?: string;
  resolverName?: string;
  /** When it was decided (ms). */
  at: number;
}

/** Apply status overrides to change records (resolver and time too, for History). */
function applyOverrides<T extends Change>(changes: T[], overrides: ReadonlyMap<string, StatusOverride>): T[] {
  if (overrides.size === 0) return changes;
  return changes.map(change => {
    const o = overrides.get(change.id);
    if (!o) return change;
    if (o.status === 'pending') return change.status === 'pending' ? change : { ...change, status: 'pending' };
    if (o.status === 'approved') {
      return {
        ...change,
        status: 'approved',
        approvedBy: change.status === 'approved' && change.approvedBy ? change.approvedBy : o.resolverId ?? change.approvedBy,
        approvedByName: change.status === 'approved' && change.approvedByName ? change.approvedByName : o.resolverName ?? change.approvedByName,
        approvedAt: change.status === 'approved' && change.approvedAt ? change.approvedAt : new Date(o.at),
      };
    }
    return {
      ...change,
      status: 'rejected',
      rejectedBy: change.status === 'rejected' && change.rejectedBy ? change.rejectedBy : o.resolverId ?? change.rejectedBy,
      rejectedByName: change.status === 'rejected' && change.rejectedByName ? change.rejectedByName : o.resolverName ?? change.rejectedByName,
      rejectedAt: change.status === 'rejected' && change.rejectedAt ? change.rejectedAt : new Date(o.at),
    };
  });
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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
  onRefreshNeeded,
  onRemoteChangeResolved,
  onBack,
  onDelete,
  onSendEmail,
  reviewMode = false,
  collabMode = 'legacy',
}) => {
  const isCollab = collabMode === 'yjs';

  // WebSocket state is now managed by CollaborativeEditor

  // Existing state
  const [, setSelectedChange] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [showCommentDialog, setShowCommentDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [suggestionText, setSuggestionText] = useState('');
  const [showSuggestionDialog, setShowSuggestionDialog] = useState(false);
  // Always-on collaborative editing - no edit mode toggle needed
  const [editedProposedContent, setEditedProposedContent] = useState('');
  const editedProposedContentRef = useRef(editedProposedContent);
  const initialEditorContentRef = useRef<string>('');
  const [, setLastSavedProposedContent] = useState<string>('');
  // The change a new comment goes on (null: a general comment)
  const [commentTarget, setCommentTarget] = useState<string | null>(null);

  // Bulk action (Accept all / Reject all) in progress
  const [batchActionLoading, setBatchActionLoading] = useState(false);

  // Review sidebar (requirement: Google Docs-style suggestions)
  // - selectedKey: the selected card in the Open list
  // - statusOverrides: decisions and undos made here (or received) that the change records
  //   may not reflect yet; they win over the record's status
  // - changePositions: document position of each change (the reject locator), for ordering
  // - hoveredChangeId: the change whose highlighted text the pointer is over in the editor
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [statusOverrides, setStatusOverrides] = useState<Map<string, StatusOverride>>(new Map());
  const [changePositions, setChangePositions] = useState<Map<string, number>>(new Map());
  const [hoveredChangeId, setHoveredChangeId] = useState<string | null>(null);
  const [undoToast, setUndoToast] = useState<{ ids: string[]; message: string } | null>(null);
  const undoToastTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [undoBusyIds, setUndoBusyIds] = useState<Set<string>>(new Set());
  // Changes the server cascade-rejected with a change this user rejected (undone together)
  const cascadeByChangeRef = useRef<Map<string, string[]>>(new Map());

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
  // Collaborative mode: the live Yjs session, and the local-edit session of the active
  // transaction (records this user's own edits so the transaction can stay open while
  // other users' edits merge in).
  const collabSessionRef = useRef<CollabSession | null>(null);
  const localEditSessionRef = useRef<LocalEditSession | null>(null);
  if (!transactionManagerRef.current) {
    transactionManagerRef.current = isCollab
      ? new TransactionManager(submission.id, {
          diffAgainstOldValue: true,
          // At settle: before = the current document minus this user's edits since the
          // transaction began, after = the current document. Both include everything
          // merged from other users, so the change holds only this user's text.
          resolveSnapshots: () => {
            const session = localEditSessionRef.current;
            const collab = collabSessionRef.current;
            localEditSessionRef.current = null;
            if (!session || !collab || !session.active) return null;
            try {
              return { before: collab.tracker.baselineJson(session), after: collab.tracker.currentJson() };
            } catch (error) {
              console.error('[YJS] Could not rebuild the tracked change from the shared document', error);
              return null;
            } finally {
              collab.tracker.end(session);
            }
          },
        })
      : new TransactionManager(submission.id);
  }
  const transactionManager = transactionManagerRef.current;

  // Track whether we have started a transaction for the current editing sequence
  const hasActiveTransactionRef = useRef(false);
  // A remote-triggered refresh that arrived while the local user was editing.
  // Refetching then would freeze change tracking (isApplyingRealTimeUpdateRef) and
  // re-initialize the editor with server content that lacks the local keystrokes, so
  // it waits until the local edit has been saved (see flushPendingRemoteRefresh).
  const pendingRemoteRefreshRef = useRef(false);
  const refreshWithRemoteGuardRef = useRef<() => void>(() => {});

  // Collaborative mode state.
  // - lastLocalJsonRef: the editor state after the local user's latest own edit. When
  //   another user's edit merges in during a local transaction, that transaction is
  //   settled with this state, so it never contains the other user's text.
  // - collabEditorReportedRef: the editor has reported its (shared) content; from then on
  //   it, not the fetched submission, is the source of editedProposedContent.
  // - savedContentRef: the fetched proposed content, used to seed an empty room when this
  //   client has nothing newer (never the placeholder text).
  const lastLocalJsonRef = useRef<string | null>(null);
  const collabEditorReportedRef = useRef(false);
  const savedContentRef = useRef('');
  savedContentRef.current = submission.proposedVersions?.richTextContent ||
    submission.proposedVersions?.content ||
    submission.richTextContent ||
    submission.content || '';

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

  // Sidebar tab: Open (pending changes and comments) or History (decisions)
  const [sidebarTab, setSidebarTab] = useState<ReviewTab>('open');

  // Sidebar collapse state - initialize based on screen size
  const [isSmallScreen, setIsSmallScreen] = useState<boolean>(window.innerWidth <= 768);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [sidebarAutoCollapsed, setSidebarAutoCollapsed] = useState<boolean>(false); // Start with manual control

  // Required approvers management
  const [newApproverEmail, setNewApproverEmail] = useState('');
  const [allApproverUsers, setAllApproverUsers] = useState<Array<{name: string; email: string}>>([]);
  const [councilManagersList, setCouncilManagersList] = useState<Array<{email: string; role?: string}>>([]);
  const [approverSuggestions, setApproverSuggestions] = useState<Array<{name: string; email: string}>>([]);
  const [activeSuggestionIdx, setActiveSuggestionIdx] = useState(0);

  const canEditRequiredApprovers = useMemo(() => {
    const isSubmitter = currentUser.id === submission.submittedBy || currentUser.email === submission.submittedBy;
    const isCommsCadre = currentUser.roles.includes('CommsCadre');
    const isCouncilManager = currentUser.roles.includes('CouncilManager');
    const isAdmin = currentUser.roles.includes('Admin');
    return isSubmitter || isCommsCadre || isCouncilManager || isAdmin;
  }, [currentUser, submission.submittedBy]);

  const handleAddRequiredApprover = useCallback(() => {
    const email = newApproverEmail.trim();
    if (!email) return;
    const updated = {
      ...submission,
      requiredApprovers: Array.from(new Set([...(submission.requiredApprovers || []), email]))
    };
    onSave(updated);
    setNewApproverEmail('');
  }, [newApproverEmail, submission, onSave]);

  const handleRemoveRequiredApprover = useCallback((email: string) => {
    const updated = {
      ...submission,
      requiredApprovers: (submission.requiredApprovers || []).filter(e => e !== email)
    };
    onSave(updated);
  }, [submission, onSave]);

  // Fetch approver users and council managers for autocomplete
  useEffect(() => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) return;
    Promise.all([
      fetch(`${API_URL}/user/approvers`, { headers: { Authorization: `Bearer ${sessionId}` } }).then(r => r.ok ? r.json() : { users: [] }),
      fetch(`${API_URL}/council/members`, { headers: { Authorization: `Bearer ${sessionId}` } }).then(r => r.ok ? r.json() : []),
    ]).then(([usersData, managersData]) => {
      setAllApproverUsers(usersData.users || []);
      setCouncilManagersList(managersData || []);
    }).catch(err => console.error('Error fetching approver data:', err));
  }, []);

  const showApproverDefaults = useCallback(() => {
    const cmUsers = allApproverUsers.filter(u =>
      councilManagersList.some(m => m.email === u.email)
    );
    if (cmUsers.length > 0) {
      setApproverSuggestions(cmUsers);
      setActiveSuggestionIdx(0);
    }
  }, [allApproverUsers, councilManagersList]);

  const handleApproverSearchChange = useCallback((value: string) => {
    setNewApproverEmail(value);
    if (value && allApproverUsers.length > 0) {
      const filtered = allApproverUsers.filter(
        u => u.email.toLowerCase().includes(value.toLowerCase()) ||
             (u.name && u.name.toLowerCase().includes(value.toLowerCase()))
      );
      setApproverSuggestions(filtered);
      setActiveSuggestionIdx(0);
    } else if (!value) {
      showApproverDefaults();
    } else {
      setApproverSuggestions([]);
      setActiveSuggestionIdx(0);
    }
  }, [allApproverUsers, showApproverDefaults]);

  const handleSuggestionSelect = useCallback((email: string) => {
    const updated = {
      ...submission,
      requiredApprovers: Array.from(new Set([...(submission.requiredApprovers || []), email]))
    };
    onSave(updated);
    setNewApproverEmail('');
    setApproverSuggestions([]);
  }, [submission, onSave]);

  const handleApproverKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (approverSuggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveSuggestionIdx(prev => Math.min(prev + 1, Math.min(approverSuggestions.length, 6) - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveSuggestionIdx(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const selected = approverSuggestions.slice(0, 6)[activeSuggestionIdx];
      if (selected) handleSuggestionSelect(selected.email);
    }
  }, [approverSuggestions, activeSuggestionIdx, handleSuggestionSelect]);

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
    // Collaborative mode: a refetch only updates the changes sidebar (the editor never
    // re-initializes from it), so there's nothing to defer and change tracking is never
    // frozen.
    if (isCollab) {
      if (onRefreshNeeded) {
        onRefreshNeeded();
      }
      return;
    }
    if (hasActiveTransactionRef.current) {
      pendingRemoteRefreshRef.current = true;
      return;
    }
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
  }, [onRefreshNeeded, isCollab]);
  refreshWithRemoteGuardRef.current = refreshWithRemoteGuard;

  // The WebSocket handlers are registered once per connection (CollaborativeEditor's
  // connect effect doesn't re-run when callbacks change), so they read callbacks
  // through refs instead of capturing the first render's.
  const onRemoteChangeResolvedRef = useRef(onRemoteChangeResolved);
  onRemoteChangeResolvedRef.current = onRemoteChangeResolved;

  // Collaborative mode: refetch the change list after a remote accept/reject, so the
  // sidebar gets the server's status (including cascade-rejected changes). A batch
  // resolve arrives as a burst of messages, so coalesce them into one trailing refetch
  // (overlapping refetches could otherwise land out of order).
  const statusRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
  const scheduleStatusRefresh = useCallback(() => {
    if (statusRefreshTimerRef.current) clearTimeout(statusRefreshTimerRef.current);
    statusRefreshTimerRef.current = setTimeout(() => {
      statusRefreshTimerRef.current = null;
      refreshWithRemoteGuardRef.current();
    }, 300);
  }, []);
  useEffect(() => () => {
    if (statusRefreshTimerRef.current) clearTimeout(statusRefreshTimerRef.current);
  }, []);

  // Run a deferred remote refresh once the local edit is settled and saved. After a
  // save the server's proposed content is this user's latest state, so the refetch
  // can't roll back their keystrokes.
  const flushPendingRemoteRefresh = useCallback(() => {
    if (!pendingRemoteRefreshRef.current || hasActiveTransactionRef.current) return;
    if (transactionManagerRef.current?.getSaveStatus() === 'saving') return;
    pendingRemoteRefreshRef.current = false;
    refreshWithRemoteGuardRef.current();
  }, []);

  // WebSocket connection is now handled by CollaborativeEditor
  // Removed WebSocket connection setup

  // WebSocket connection logic removed - now handled by CollaborativeEditor

  // Cleanup TransactionManager on unmount
  useEffect(() => {
    return () => {
      // Collaborative mode: the editor is unmounted on navigation (it's keyed by
      // submission); save the in-progress edit instead of dropping it with the manager.
      const tm = transactionManagerRef.current;
      if (isCollab && tm?.getActiveTransaction() && lastLocalJsonRef.current) {
        tm.settleTransaction(lastLocalJsonRef.current);
      }
      tm?.destroy();
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
      // Fallback for settles that don't need a save (no save-status change follows)
      setTimeout(flushPendingRemoteRefresh, 3000);
    };
    tm.on('transaction-settled', handleSettledFlag);

    const handleSaveStatus = (status: string) => {
      if (status === 'all-saved') flushPendingRemoteRefresh();
    };
    tm.on('save-status-changed', handleSaveStatus);
    // Don't hold remote state back forever if the local save failed
    tm.on('save-error', flushPendingRemoteRefresh);

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
        if (isCollab) {
          // Collaborative mode: other users' pending markers are in the shared document
          // too. Rename only this user's, in the editor (it syncs, and the editor reports
          // the result back as the new baseline), never with a document-wide replace.
          if (currentJson && currentJson.includes('__pending_deletion__')) {
            window.dispatchEvent(new CustomEvent('commit-pending-deletion', {
              detail: { newId: tx.remoteChangeId, authorId: currentUser.id || currentUser.email }
            }));
          }
        } else if (currentJson && currentJson.includes('__pending_deletion__')) {
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
          richTextOldValue: typeof tx.beforeSnapshot.lexicalState === 'string'
            ? tx.beforeSnapshot.lexicalState
            : JSON.stringify(tx.beforeSnapshot.lexicalState),
          richTextNewValue: typeof tx.afterSnapshot.lexicalState === 'string'
            ? tx.afterSnapshot.lexicalState
            : JSON.stringify(tx.afterSnapshot.lexicalState),
        };
        setLocalAddedChanges(prev => [...prev, optimisticChange]);
      }
    };
    tm.on('transaction-saved', handleSaved);

    return () => {
      tm.off('transaction-settled', handleSettledFlag);
      tm.off('save-status-changed', handleSaveStatus);
      tm.off('save-error', flushPendingRemoteRefresh);
      tm.off('transaction-saved', handleSaved);
    };
  }, [currentUser.email, currentUser.id, isCollab]);

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

    // Collaborative mode: once the editor has reported the shared document, it alone
    // defines editedProposedContent. A refetch (other users' saves, reconnects) only
    // refreshes the changes sidebar; its content may lack edits still being merged.
    if (isCollab && collabEditorReportedRef.current) {
      return;
    }

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

  // Every change (any status): the server's, then the locally saved ones, with the
  // decisions and undos known here applied (statusOverrides). History reads this list.
  const allTrackedChanges: TrackedChange[] = useMemo(() => {
    const serverChanges: TrackedChange[] = submission.changes.map(change => {
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

      return {
        ...change,
        status: change.status || 'pending', // Use status from tracked changes data
        comments: changeComments
      };
    });

    // Merge optimistically added changes (from handleSaved) that aren't yet
    // in the server data.  Once fetchSubmission() runs, the server data will
    // include these changes and the local copies are excluded, so the server's
    // status wins. Until then a local copy keeps any status set on it (e.g. a
    // remote reject that arrived before the refetch).
    // A change hidden by a decision made here (handleChangeDecision adds it to
    // localRemovedChangeIds) stays in this list with its decision, for History and Undo.
    const removed = statusOverrides.size === 0
      ? localRemovedChangeIds
      : new Set(Array.from(localRemovedChangeIds).filter(id => !statusOverrides.has(id)));
    const merged = mergeLocalChanges<TrackedChange>(
      serverChanges,
      localAddedChanges.map(local => ({ ...local, status: local.status || 'pending', comments: [] })),
      removed,
    );
    return applyOverrides(merged, statusOverrides);
  }, [submission.changes, submission.comments, localRemovedChangeIds, localAddedChanges, statusOverrides]);
  const allTrackedChangesRef = useRef(allTrackedChanges);
  allTrackedChangesRef.current = allTrackedChanges;

  // The changes still waiting for a decision: the sidebar's Open list, the editor's
  // highlights and the decision handlers. Filtered after mergeLocalChanges (above), so a
  // change another user resolves disappears as soon as its status arrives.
  const trackedChanges: TrackedChange[] = useMemo(() => {
    const result = pendingOnly(allTrackedChanges);
    console.log('[TrackedChangesEditor] trackedChanges:', {
      submissionChangesCount: submission.changes.length,
      allCount: allTrackedChanges.length,
      pendingCount: result.length,
      localRemovedCount: localRemovedChangeIds.size,
    });
    return result;
  }, [allTrackedChanges, submission.changes.length, localRemovedChangeIds.size]);

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

  // PUT one change's status to the backend. Resolves to the response body (null when it
  // has none), or undefined when the request failed (already reported to the user).
  const putChangeStatus = useCallback(async (changeId: string, status: 'approved' | 'rejected', revertedRichText?: string): Promise<any | undefined> => {
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) return undefined;
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
        return undefined;
      }
      // An older server or an empty body gives null (no cascade ids)
      return await response.json().catch(() => null);
    } catch (error) {
      console.error(`Background sync failed for change ${changeId}:`, error);
      showErrorToast(`Failed to save change status: network error`);
      onRefreshNeeded?.();
      return undefined;
    }
  }, [onRefreshNeeded, submission.id, showErrorToast]);

  // Set below (with the sidebar state): records changes the server cascade-rejected.
  const onCascadeRejectedRef = useRef<(changeId: string, cascadeIds: string[]) => void>(() => {});

  // Background sync: fire-and-forget PUT to backend
  const syncChangeStatusToBackend = useCallback(async (changeId: string, status: 'approved' | 'rejected', revertedRichText?: string) => {
    // Skip individual backend syncs during batch operations — the batch
    // handler will make a single API call with all changes.
    if (batchSyncInProgressRef.current) return;
    const result = await putChangeStatus(changeId, status, revertedRichText);
    if (result === undefined) return;

    // A reject can cascade to dependent changes on the server; the response lists them.
    const cascadeRejectedIds = status === 'rejected'
      ? resolvedChangeIds({ changeId, status, cascadeRejectedIds: result?.cascadeRejectedIds }).slice(1)
      : [];
    // The sidebar shows them rejected, and an undo of this reject undoes them too.
    if (cascadeRejectedIds.length > 0) onCascadeRejectedRef.current(changeId, cascadeRejectedIds);

    if (isCollab && cascadeRejectedIds.length > 0) {
      // Collaborative mode: revert the cascaded changes in the shared document too
      // (newest first), and show them as rejected in this sidebar.
      const reverted = revertCascadedChangesRef.current(cascadeRejectedIds);
      const resolver: ChangeResolver = { id: currentUser.email || currentUser.id, name: currentUser.name };
      for (const id of cascadeRejectedIds) {
        onRemoteChangeResolvedRef.current?.(id, 'rejected', resolver);
      }
      setLocalAddedChanges(prev => applyChangeStatus(prev, cascadeRejectedIds, 'rejected', resolver));
      // The first PUT carried the document before these reverts, so store it again. The
      // cascaded changes are rejected on the server already, so this PUT cascades no
      // further; it isn't broadcast (the single broadcast below covers it).
      if (reverted && editedProposedContentRef.current) {
        await putChangeStatus(changeId, 'rejected', editedProposedContentRef.current);
      }
    }

    // Broadcast to other connected users via WebSocket, once, with the cascade ids
    // included so collaborative-mode clients mark those rejected too.
    const client = webSocketClientRef.current;
    if (client?.sendChangeStatusUpdate) {
      client.sendChangeStatusUpdate(changeId, status, cascadeRejectedIds);
    }
  }, [putChangeStatus, isCollab, currentUser.email, currentUser.id, currentUser.name]);

  // Collaborative mode: changes whose reject by context failed once. A second reject marks
  // them rejected without changing the document.
  const restoreFailedIdsRef = useRef<Set<string>>(new Set());
  // Set below (after handleChangeDecision); returns true when it changed the document.
  const revertCascadedChangesRef = useRef<(cascadedIds: string[]) => boolean>(() => false);

  // Handle change decision (approve/reject) — fully local, no network on hot path.
  // Returns false when a collaborative reject couldn't revert the document (the change
  // stays pending).
  const handleChangeDecision = useCallback((changeId: string, decision: 'approve' | 'reject'): boolean => {
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
      blockIndex?: number;
    }> = [];
    if (change && change.richTextOldValue && change.richTextNewValue) {
      try {
        const oldJson = isLexicalJson(change.richTextOldValue) ? JSON.parse(change.richTextOldValue) : null;
        const newJson = isLexicalJson(change.richTextNewValue) ? JSON.parse(change.richTextNewValue) : null;
        if (oldJson?.root?.children && newJson?.root?.children) {
          // Helper to extract text from any block (paragraph, heading, list, etc.)
          // Must match Lexical's getTextContent() behavior for reliable block matching.
          const extractBlockText = (block: any): string => {
            if (!block.children) return '';
            return block.children
              .map((n: any) => {
                if (n.type === 'text') return n.text || '';
                if (n.type === 'linebreak') return '\n';
                if (n.type === 'tab') return '\t';
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
                blockIndex: i,
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

    // Collaborative mode: settle the user's in-progress edit first (with their own last
    // state) so pausing doesn't discard it, and tell the resolve handler whose pending
    // deletion markers belong to this change.
    let pendingAuthorIds: string[] | undefined;
    if (isCollab) {
      if (transactionManager.getActiveTransaction() && lastLocalJsonRef.current) {
        transactionManager.settleTransaction(lastLocalJsonRef.current);
        hasActiveTransactionRef.current = false;
      }
      if (change?.changedBy) {
        pendingAuthorIds = [change.changedBy];
        if (change.changedBy === currentUser.id || change.changedBy === currentUser.email) {
          pendingAuthorIds.push(currentUser.id, currentUser.email);
        }
      }
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
    //    - collaborative reject: reverts by context from the change's own before/after
    //      documents, and reports the outcome in detail.result (synchronously)
    const resolveDetail: ResolveTrackedChangeDetail = {
      changeId, action: decision === 'approve' ? 'approve' : 'reject', deletedTexts, replacementPairs, insertedTexts, formatChanges, pendingAuthorIds,
      richTextOldValue: change?.richTextOldValue, richTextNewValue: change?.richTextNewValue,
    };
    window.dispatchEvent(new CustomEvent('resolve-tracked-change', { detail: resolveDetail }));

    console.log(`[RESOLVE] editedProposedContentRef AFTER dispatch:`, editedProposedContentRef.current?.substring(0, 200));

    // 2b. Collaborative reject that didn't revert the document (change not found, no rich
    //     text, or no editor listening): nothing was changed. Leave the change pending and
    //     say so; a second reject marks it rejected without touching the document.
    if (isCollab && decision === 'reject' && resolveDetail.result?.restored !== true) {
      if (!restoreFailedIdsRef.current.has(changeId)) {
        restoreFailedIdsRef.current.add(changeId);
        if (pendingResolveCountRef.current <= 0) {
          transactionManager.resumeAfterChangeResolution();
          if (!batchSyncInProgressRef.current) isResolvingChangeRef.current = false;
        }
        showErrorToast("Couldn't revert this change automatically: its text has been edited since. It is still pending. Edit the text by hand, or reject it again to mark it rejected without changing the document.");
        return false;
      }
    }
    restoreFailedIdsRef.current.delete(changeId);

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

      // Broadcast the post-resolution editor state to other users (legacy only: in
      // collaborative mode the resolve already reached everyone through Yjs).
      if (isCollab && currentState && isLexicalJson(currentState)) {
        setLastSavedProposedContent(currentState);
      } else if (currentState && isLexicalJson(currentState) && webSocketClientRef.current) {
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
    return true;
  }, [onApprove, onReject, syncChangeStatusToBackend, trackedChanges, getDisplayableText, isCollab, currentUser.id, currentUser.email, showErrorToast]);

  // Changes the server rejected along with one the reviewer rejected (cascadeRejectedIds):
  // revert them in the shared document too, newest first. Returns true when the document
  // changed; syncChangeStatusToBackend then marks them rejected in the sidebar and stores
  // the document again. Collaborative mode only: the resolve updates are bookkeeping there
  // and never start or join a transaction, so the user's own edit in progress is left
  // alone (no pause).
  revertCascadedChangesRef.current = (cascadedIds: string[]) => {
    const cascaded = cascadedIds
      .map(id => trackedChanges.find(c => c.id === id))
      .filter((c): c is TrackedChange => !!c && !!c.richTextOldValue && !!c.richTextNewValue)
      .sort((x, y) => new Date(y.timestamp).getTime() - new Date(x.timestamp).getTime());
    let reverted = false;
    for (const c of cascaded) {
      const detail: ResolveTrackedChangeDetail = {
        changeId: c.id, action: 'reject', deletedTexts: [], pendingAuthorIds: c.changedBy ? [c.changedBy] : undefined,
        richTextOldValue: c.richTextOldValue, richTextNewValue: c.richTextNewValue,
      };
      window.dispatchEvent(new CustomEvent('resolve-tracked-change', { detail }));
      // A cascaded change that can't be located is left as it is (the server has rejected
      // it already); often the first reject removed its text along with its own.
      if (detail.result?.restored) reverted = true;
      else console.warn(`[RESOLVE] cascaded change ${c.id} not reverted: ${detail.result?.reason ?? 'no editor'}`);
    }
    cascadedIds.forEach(id => removeDecorationsForChange(id));
    return reverted;
  };

  // Batch action (Accept all / Reject all). `onResolved` gets the ids actually resolved,
  // right after the (synchronous) decisions.
  const handleBatchAction = useCallback(async (changeIds: string[], status: 'approved' | 'rejected', onResolved?: (ids: string[]) => void) => {
    setBatchActionLoading(true);
    try {
      // Suppress individual backend syncs — we'll make one batch call.
      // Also keep the resolve guard up for the entire batch so that
      // incoming WebSocket updates can't overwrite reverts mid-batch.
      batchSyncInProgressRef.current = true;
      isResolvingChangeRef.current = true;
      const decision = status === 'approved' ? 'approve' : 'reject';
      // Only the changes that were actually resolved go to the server: a collaborative
      // reject that couldn't revert the document returns false and stays pending.
      const resolvedIds = changeIds.filter(id => handleChangeDecision(id, decision) !== false);
      onResolved?.(resolvedIds);
      // NOTE: cleared before the per-change 500 ms timers fire, so each of them still
      // runs syncChangeStatusToBackend: an individual PUT with the rich text at that
      // moment (plus a re-PUT after any cascade reverts), which also broadcasts
      // change_status_updated to other users. Those PUTs run concurrently, so the
      // batch PUT below is the final, ordered write: it carries the editor state after
      // all the reverts, and the server stores that as the content.
      batchSyncInProgressRef.current = false;

      // Wait for all per-change resolve timeouts to complete (including their PUTs and
      // any cascade re-PUTs) before making the batch API call (they need to broadcast
      // content and resume the TransactionManager).
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

      // Single batch API call for backend persistence, with the editor state after all
      // the reverts (read now, after the per-change timers, not before the decisions).
      const sessionId = localStorage.getItem('sessionId');
      if (sessionId && resolvedIds.length > 0) {
        const body: Record<string, unknown> = { changeIds: resolvedIds, status, submissionId: submission.id };
        const revertedRichText = editedProposedContentRef.current;
        if (revertedRichText && isLexicalJson(revertedRichText)) body.revertedRichText = revertedRichText;
        const response = await fetch(`${API_URL}/tracked-changes/batch-status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionId}` },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          console.error('Batch status update failed:', response.statusText);
        }
      }
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

  // Handle a new comment: on a change (commentTarget), or a general comment
  const handleCommentSubmit = useCallback(() => {
    if (commentText.trim()) {
      const comment: Comment = {
        id: crypto.randomUUID(),
        content: commentTarget ? `@change:${commentTarget} ${commentText}` : commentText,
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
  }, [commentTarget, commentText, currentUser.id, onComment]);

  // Reply to a comment (any comment in a thread)
  const handleCommentReply = useCallback((parentId: string, text: string) => {
    if (!text.trim()) return;
    onComment({
      id: crypto.randomUUID(),
      content: `@reply:${parentId} ${text}`,
      authorId: currentUser.id,
      createdAt: new Date(),
      type: 'COMMENT',
      resolved: false
    });
  }, [currentUser.id, onComment]);


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

  // Scroll to an inline tracked change in the proposed editor (by its deletion marker;
  // the fallback when the change can't be located by context)
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
      // On proposed or original tab - switch to proposed, then scroll to the change's text
      // (located in the live document with the reject locator) and flash it
      const reveal = () => {
        if (!revealChangeInEditor(getActiveTrackedChangesEditor(), change)) scrollToChangeInProposed(change);
      };
      if (activeTab !== 'proposed') {
        setActiveTab('proposed');
        setTimeout(reveal, 300);
      } else {
        reveal();
      }
    }
  }, [activeTab, scrollToChangeInDiff, scrollToChangeInProposed]);

  // ---- Review sidebar: Open (pending changes and comments) / History ----

  const fieldLabel = useCallback((field: string): string | undefined => FIELD_DISPLAY_NAMES[field], []);
  const selfResolver = useMemo<ChangeResolver>(
    () => ({ id: currentUser.email || currentUser.id, name: currentUser.name }),
    [currentUser.email, currentUser.id, currentUser.name],
  );

  // Plain-language descriptions, cached per change record (they diff whole documents)
  const descriptionCacheRef = useRef(new Map<string, { key: string; description: ChangeDescription }>());
  const describe = useCallback((c: TrackedChange): ChangeDescription => {
    const key = [c.field, c.oldValue?.length, c.newValue?.length, c.richTextOldValue?.length, c.richTextNewValue?.length].join('|');
    const cached = descriptionCacheRef.current.get(c.id);
    if (cached && cached.key === key) return cached.description;
    const description = describeChange(c);
    descriptionCacheRef.current.set(c.id, { key, description });
    return description;
  }, []);

  // Document position of each pending change (and of changes with comments), from the
  // reject locator run against the live document. Field changes (subject, ...) come first.
  // Debounced: it diffs whole documents.
  useEffect(() => {
    const timer = setTimeout(() => {
      const live = editedProposedContentRef.current || '';
      let blocks: any[] | null = null;
      try {
        blocks = isLexicalJson(live) ? JSON.parse(live)?.root?.children ?? null : null;
      } catch {
        blocks = null;
      }
      const ids = new Set(trackedChanges.map(c => c.id));
      for (const comment of submission.comments) {
        const id = commentChangeId(comment);
        if (id) ids.add(id);
      }
      const next = new Map<string, number>();
      ids.forEach(id => {
        const c = allTrackedChangesRef.current.find(x => x.id === id);
        if (!c || c.status === 'rejected') return;
        if (c.field && c.field !== 'content') {
          next.set(id, -1);
          return;
        }
        if (!blocks || !c.richTextOldValue || !c.richTextNewValue) return;
        try {
          const location = locateChange(c.richTextOldValue, c.richTextNewValue, blocks);
          if (location) next.set(id, location.order);
        } catch (err) {
          console.warn('[REVIEW] could not locate change', id, err);
        }
      });
      setChangePositions(prev => {
        if (prev.size === next.size && Array.from(next).every(([k, v]) => prev.get(k) === v)) return prev;
        return next;
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [editedProposedContent, trackedChanges, submission.comments]);

  const openItems = useMemo(
    () => buildOpenItems(trackedChanges, submission.comments, changePositions, describe),
    [trackedChanges, submission.comments, changePositions, describe],
  );
  const openItemsRef = useRef(openItems);
  openItemsRef.current = openItems;

  const decidedAt = useMemo(() => {
    const map = new Map<string, number>();
    statusOverrides.forEach((o, id) => { if (o.status !== 'pending') map.set(id, o.at); });
    return map;
  }, [statusOverrides]);
  const history = useMemo(
    () => buildHistory(allTrackedChanges, decidedAt, describe),
    [allTrackedChanges, decidedAt, describe],
  );

  /** Record decisions (or undos) known here before the change records catch up. */
  const recordStatus = useCallback((ids: string[], status: StatusOverride['status'], resolver?: ChangeResolver) => {
    if (ids.length === 0) return;
    const at = Date.now();
    setStatusOverrides(prev => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, { status, resolverId: resolver?.id, resolverName: resolver?.name, at });
      return next;
    });
  }, []);

  // Changes the server cascade-rejected along with one rejected here: rejected in the
  // sidebar now, and undone with it.
  onCascadeRejectedRef.current = (changeId: string, cascadeIds: string[]) => {
    cascadeByChangeRef.current.set(changeId, cascadeIds);
    recordStatus(cascadeIds, 'rejected', selfResolver);
  };

  const dismissUndoToast = useCallback(() => {
    if (undoToastTimerRef.current) clearTimeout(undoToastTimerRef.current);
    undoToastTimerRef.current = null;
    setUndoToast(null);
  }, []);
  const showUndoToast = useCallback((ids: string[], decision: 'approve' | 'reject', cards: number) => {
    if (ids.length === 0) return;
    const verb = decision === 'approve' ? 'Accepted' : 'Rejected';
    setUndoToast({ ids, message: cards > 1 ? `${verb} ${cards} changes` : verb });
    if (undoToastTimerRef.current) clearTimeout(undoToastTimerRef.current);
    undoToastTimerRef.current = setTimeout(() => {
      undoToastTimerRef.current = null;
      setUndoToast(null);
    }, 8000);
  }, []);
  useEffect(() => () => {
    if (undoToastTimerRef.current) clearTimeout(undoToastTimerRef.current);
  }, []);

  /**
   * Accept or reject a card. A move is two changes: they go through handleChangeDecision
   * one at a time, the deletion first, then the insertion (the order validated for a
   * reject: it restores the exact original). If the deletion can't be reverted, the
   * insertion is left alone, so the moved text is never lost.
   */
  const decideCard = useCallback((card: ChangeCard<TrackedChange>, decision: 'approve' | 'reject') => {
    const decided: string[] = [];
    for (const id of card.ids) {
      if (handleChangeDecision(id, decision) === false) break;
      decided.push(id);
    }
    if (decided.length === 0) return;
    recordStatus(decided, decision === 'approve' ? 'approved' : 'rejected', selfResolver);
    showUndoToast(decided, decision, 1);
  }, [handleChangeDecision, recordStatus, selfResolver, showUndoToast]);

  /** Accept all / Reject all, through the batch path, in document order (moves deletion first). */
  const handleBulkDecision = useCallback((status: 'approved' | 'rejected') => {
    const ids = openItemsRef.current.flatMap(item => (item.type === 'comment' ? [] : item.ids));
    if (ids.length === 0) return;
    handleBatchAction(ids, status, (resolved) => {
      recordStatus(resolved, status, selfResolver);
      showUndoToast(resolved, status === 'approved' ? 'approve' : 'reject', resolved.length);
    });
  }, [handleBatchAction, recordStatus, selfResolver, showUndoToast]);

  /**
   * Undo accepts or rejects (with the changes the server cascade-rejected with them).
   *
   * - Undo of an accept flips the status back to pending: the change's text is still in
   *   the document.
   * - Undo of a reject re-applies the change first: a reject changed the document (in
   *   collaborative mode by context, in legacy mode with the marker and text heuristics),
   *   so a pending change whose text isn't there would be meaningless. The change's
   *   "before -> after" is located with the reject's locator and applied in one synced
   *   editor update, oldest change first. If any can't be located, nothing changes, the
   *   user is told, and the status stays as it is.
   *
   * Then the server sets the changes back to pending (and stores the document, which its
   * undo would otherwise drop), and other clients are told (change_status_updated with
   * status 'pending').
   */
  const undoDecision = useCallback(async (ids: string[]): Promise<boolean> => {
    let busyIds = [...ids];
    setUndoBusyIds(prev => new Set([...Array.from(prev), ...busyIds]));
    const finish = () => setUndoBusyIds(prev => {
      const next = new Set(prev);
      busyIds.forEach(id => next.delete(id));
      return next;
    });

    // A decision still in flight (its status PUT, and the cascade the server reports in
    // the response) finishes first, so the undo covers what it did and the server sees
    // the decision before the undo.
    const waitStart = Date.now();
    while (pendingResolveCountRef.current > 0 && Date.now() - waitStart < 10000) await sleep(100);

    const expanded: string[] = [];
    for (const id of ids) {
      if (!expanded.includes(id)) expanded.push(id);
      for (const cascaded of cascadeByChangeRef.current.get(id) || []) {
        if (!expanded.includes(cascaded)) expanded.push(cascaded);
      }
    }
    const changes = expanded
      .map(id => allTrackedChangesRef.current.find(c => c.id === id))
      .filter((c): c is TrackedChange => !!c && c.status !== 'pending');
    if (changes.length === 0) {
      finish();
      return false;
    }
    const undoIds = changes.map(c => c.id);
    busyIds = Array.from(new Set([...busyIds, ...undoIds]));
    const rejected = changes.filter(c => c.status === 'rejected');
    if (rejected.some(c => (c.field && c.field !== 'content') || !c.richTextOldValue || !c.richTextNewValue)) {
      finish();
      showErrorToast("This reject can't be undone automatically: the change has no rich text to put back.");
      return false;
    }

    let documentChanged = false;
    if (rejected.length > 0) {
      // Like a decision: settle the user's own edit in progress first, and keep the
      // re-apply out of change tracking and away from incoming whole-document updates.
      if (isCollab && transactionManager.getActiveTransaction() && lastLocalJsonRef.current) {
        transactionManager.settleTransaction(lastLocalJsonRef.current);
        hasActiveTransactionRef.current = false;
      }
      transactionManager.pauseForChangeResolution();
      isResolvingChangeRef.current = true;
      const ordered = [...rejected].sort((x, y) => new Date(x.timestamp).getTime() - new Date(y.timestamp).getTime());
      const result = reapplyRejectedChanges(
        getActiveTrackedChangesEditor(),
        ordered.map(c => ({ id: c.id, before: c.richTextOldValue!, after: c.richTextNewValue! })),
        isCollab,
      );
      if (!result.ok) {
        if (pendingResolveCountRef.current <= 0) {
          transactionManager.resumeAfterChangeResolution();
          if (!batchSyncInProgressRef.current) isResolvingChangeRef.current = false;
        }
        finish();
        console.warn(`[UNDO] re-apply failed for ${undoIds.join(', ')}: ${result.reason}`);
        showErrorToast(`Couldn't undo the reject: ${result.reason}. The change is still rejected.`);
        return false;
      }
      documentChanged = true;
    }

    // Optimistic: pending again here, before the server answers.
    recordStatus(undoIds, 'pending');
    setLocalRemovedChangeIds(prev => {
      if (!undoIds.some(id => prev.has(id))) return prev;
      const next = new Set(prev);
      undoIds.forEach(id => next.delete(id));
      return next;
    });
    undoIds.forEach(id => {
      restoreFailedIdsRef.current.delete(id);
      cascadeByChangeRef.current.delete(id);
    });

    pendingResolveCountRef.current++;
    try {
      if (documentChanged) {
        // Let the editor report the new content (onContentChange) before reading it.
        await sleep(500);
        transactionManager.resumeAfterChangeResolution();
      }
      const doc = editedProposedContentRef.current;
      const hasDoc = !!doc && isLexicalJson(doc);
      if (hasDoc) setLastSavedProposedContent(doc);
      // Legacy mode: other users get the document as a whole (collaborative mode synced it
      // through Yjs already).
      const client = webSocketClientRef.current;
      if (!isCollab && documentChanged && hasDoc && client) {
        try {
          client.send({
            type: 'content_updated',
            data: { field: 'proposedVersions.richTextContent', newValue: extractTextFromLexical(doc), lexicalContent: doc, isAutoSave: true },
          });
        } catch (e) {
          console.error('Failed to broadcast content after undo:', e);
        }
      }

      const sessionId = localStorage.getItem('sessionId');
      let failed = 0;
      for (const id of undoIds) {
        try {
          const response = await fetch(`${API_URL}/tracked-changes/${id}/undo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionId}` },
            body: JSON.stringify({ submissionId: submission.id, ...(hasDoc ? { proposedVersionsRichText: doc } : {}) }),
          });
          if (!response.ok) {
            failed++;
            console.error(`Undo failed for ${id}: ${response.status} ${await response.text().catch(() => '')}`);
          }
        } catch (err) {
          failed++;
          console.error(`Undo failed for ${id}:`, err);
        }
      }
      if (failed > 0) {
        showErrorToast(`Couldn't save the undo on the server (${failed} of ${undoIds.length}). Reload to see the current state.`);
        onRefreshNeeded?.();
      }

      if (client?.send) {
        try {
          client.send({ type: 'change_status_updated', data: { changeId: undoIds[0], status: 'pending', undoneIds: undoIds } });
        } catch (e) {
          console.error('Failed to broadcast undo:', e);
        }
      }
      return failed === 0;
    } finally {
      pendingResolveCountRef.current--;
      if (pendingResolveCountRef.current <= 0) {
        pendingResolveCountRef.current = 0;
        if (!batchSyncInProgressRef.current) isResolvingChangeRef.current = false;
      }
      finish();
    }
  }, [isCollab, transactionManager, submission.id, onRefreshNeeded, recordStatus, showErrorToast]);

  const handleToastUndo = useCallback(() => {
    const toast = undoToast;
    dismissUndoToast();
    if (toast) undoDecision(toast.ids);
  }, [undoToast, dismissUndoToast, undoDecision]);

  const canUndoEntry = useCallback((entry: HistoryEntry<TrackedChange>): boolean => {
    if (!canMakeEditorialDecisions()) return false;
    const changes = entry.ids.map(id => allTrackedChanges.find(c => c.id === id));
    if (changes.some(c => !c || c.status !== entry.status)) return false;
    if (entry.status === 'approved') return true;
    return changes.every(c => !!c && (!c.field || c.field === 'content') && !!c.richTextOldValue && !!c.richTextNewValue);
  }, [allTrackedChanges, canMakeEditorialDecisions]);

  /** Select a card: scroll the editor to its text (a move: where the text is now). */
  const selectItem = useCallback((item: OpenItem<TrackedChange>) => {
    setSelectedKey(item.key);
    const targetId = item.type === 'move' ? item.insertion.id : item.type === 'change' ? item.change.id : item.changeId;
    if (!targetId) return;
    const change = allTrackedChangesRef.current.find(c => c.id === targetId);
    if (change) handleChangeClick(change);
    else setSelectedChange(targetId);
  }, [handleChangeClick]);

  // Clicking a change's text in the editor selects its card and scrolls it into view
  const handleEditorTrackedChangeClick = useCallback((changeId: string) => {
    // Ignore live (unsaved) change IDs — they have no sidebar card
    if (changeId.startsWith('__live__')) return;
    setSelectedChange(changeId);
    setSidebarTab('open');
    const item = openItemsRef.current.find(i => i.ids.includes(changeId));
    if (item) setSelectedKey(item.key);
    setTimeout(() => {
      const card = document.querySelector(`.rp-card[data-change-ids~="${CSS.escape(changeId)}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('sidebar-highlighted');
        setTimeout(() => card.classList.remove('sidebar-highlighted'), 2000);
      }
    }, 50);
  }, []);

  // Hovering a change's highlighted text in the editor highlights its card
  useEffect(() => {
    let frame = 0;
    let last: string | null = null;
    let event: MouseEvent | null = null;
    const onMove = (e: MouseEvent) => {
      event = e;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const ev = event;
        if (!ev) return;
        const target = ev.target instanceof Element ? ev.target : null;
        const inEditor = !!target?.closest('.proposed-collaborative-editor');
        const id = inEditor ? changeIdAtPoint(target, ev.clientX, ev.clientY) : null;
        if (id !== last) {
          last = id;
          setHoveredChangeId(id);
        }
      });
    };
    document.addEventListener('mousemove', onMove);
    return () => {
      document.removeEventListener('mousemove', onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  const linkedIds = useMemo(() => new Set(hoveredChangeId ? [hoveredChangeId] : []), [hoveredChangeId]);

  // Keyboard shortcuts: j / k move through the Open list, a / r accept or reject the
  // selected change
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs or in the editor itself (contenteditable):
      // otherwise typing j/k is swallowed and a/r approve or reject the selected change.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (sidebarTab !== 'open') return;

      const items = openItemsRef.current;
      if (items.length === 0) return;
      const idx = selectedKey ? items.findIndex(i => i.key === selectedKey) : -1;

      if (e.key === 'j') {
        e.preventDefault();
        selectItem(items[Math.min(idx + 1, items.length - 1)]);
      } else if (e.key === 'k') {
        e.preventDefault();
        selectItem(items[Math.max(idx - 1, 0)]);
      } else if ((e.key === 'a' || e.key === 'r') && idx >= 0 && canMakeEditorialDecisions()) {
        const item = items[idx];
        if (item.type === 'comment') return;
        e.preventDefault();
        decideCard(item, e.key === 'a' ? 'approve' : 'reject');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sidebarTab, selectedKey, selectItem, decideCard, canMakeEditorialDecisions]);

  // Another user accepted, rejected or undid: keep the sidebar's statuses in step.
  const onRemoteStatusRef = useRef<(ids: string[], status: StatusOverride['status'], resolver?: ChangeResolver) => void>(() => {});
  onRemoteStatusRef.current = (ids, status, resolver) => {
    recordStatus(ids, status, resolver);
    if (status === 'pending') {
      setLocalRemovedChangeIds(prev => {
        if (!ids.some(id => prev.has(id))) return prev;
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    }
  };

  const reviewPanelProps = {
    tab: sidebarTab,
    onTabChange: setSidebarTab,
    openItems,
    history,
    pendingCount: trackedChanges.length,
    canReview: canMakeEditorialDecisions(),
    currentUserId: currentUser.email || currentUser.id,
    selectedKey,
    linkedIds,
    busy: batchActionLoading,
    undoBusyIds,
    fieldLabel,
    onSelect: selectItem,
    onAccept: (card: ChangeCard<TrackedChange>) => decideCard(card, 'approve'),
    onReject: (card: ChangeCard<TrackedChange>) => decideCard(card, 'reject'),
    onAcceptAll: () => handleBulkDecision('approved'),
    onRejectAll: () => handleBulkDecision('rejected'),
    onComment: (changeId: string | null) => {
      setCommentTarget(changeId);
      if (changeId) setSelectedChange(changeId);
      setShowCommentDialog(true);
    },
    onReply: handleCommentReply,
    canUndo: canUndoEntry,
    onUndo: (entry: HistoryEntry<TrackedChange>) => { undoDecision(entry.ids); },
  };

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
      // Collaborative mode: content arrives through Yjs only; never apply whole-document
      // updates from the room socket.
      // Listen for content updates
      if (!isCollab) client.on('content_updated', handleWebSocketUpdate);

      // Listen for real-time content updates (character-by-character)
      if (!isCollab) client.on('realtime_content_update', handleWebSocketUpdate);

      // Listen for cursor position updates to track current user's position
      if (!isCollab) client.on('cursor_position', (message: any) => {
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
        refreshWithRemoteGuardRef.current();
      });

      // Listen for gap detection — refetch from REST API
      client.on('sync_needed', () => {
        console.log('🔄 Sync needed — refetching from REST API');
        refreshWithRemoteGuardRef.current();
      });

      // Listen for transaction-settled from remote users
      client.on('transaction_settled', (message: WebSocketMessage) => {
        if (message.userId === effectiveUserId) return;
        const data = message.data;
        if (!data?.changeId) return;
        // Trigger a refresh so the new tracked change appears in the sidebar
        refreshWithRemoteGuardRef.current();
      });

      // Listen for transaction-undone from remote users
      client.on('transaction_undone', (message: WebSocketMessage) => {
        if (message.userId === effectiveUserId) return;
        const data = message.data;
        if (!data?.removedChangeIds || !Array.isArray(data.removedChangeIds)) return;
        // Remove decorations for each undone change (legacy only: in collaborative mode
        // the shared document already reflects the undo, and the refreshed sidebar drops
        // the change's highlights)
        if (!isCollab) for (const id of data.removedChangeIds) {
          try {
            removeDecorationsForChange(id);
          } catch (err) {
            console.error('Failed to remove decorations for undone change:', id, err);
          }
        }
        // Trigger a refresh so the sidebar updates
        refreshWithRemoteGuardRef.current();
      });

      // Listen for transaction-redone from remote users
      client.on('transaction_redone', (message: WebSocketMessage) => {
        if (message.userId === effectiveUserId) return;
        const data = message.data;
        if (!data?.changeId) return;
        // Trigger a refresh so the re-added tracked change appears
        refreshWithRemoteGuardRef.current();
      });

      // Listen for change status updates (accept/reject) from remote users
      client.on('change_status_updated', (message: WebSocketMessage) => {
        console.log(`[WS-STATUS] change_status_updated: userId=${message.userId}, effectiveUserId=${effectiveUserId}, changeId=${message.data?.changeId}, status=${message.data?.status}`);
        if (message.userId === effectiveUserId) return;
        const data = message.data;
        if (!data?.changeId || !data?.status) return;
        // Another user undid a decision: the changes are pending again (an undone reject's
        // text came back through Yjs, or in legacy mode in the content_updated before this).
        if (data.status === 'pending') {
          const undone: string[] = [data.changeId];
          if (Array.isArray(data.undoneIds)) {
            for (const id of data.undoneIds) if (typeof id === 'string' && id && !undone.includes(id)) undone.push(id);
          }
          onRemoteStatusRef.current(undone, 'pending');
          if (isCollab) scheduleStatusRefresh();
          return;
        }
        console.log(`[WS-STATUS] Processing remote change_status_updated — removing decorations and updating status locally`);
        // Collaborative mode: the resolving client changed the shared document through
        // Yjs; here only the sidebar updates (its highlights go with the pending change).
        if (!isCollab) {
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
        }
        // Update the change status locally right away. In legacy mode this replaces
        // onRefreshNeeded(): a full submission refetch would trigger
        // proposedEditorContent → initialContent change → editor re-initialization →
        // phantom tracked change. Collaborative mode also applies the changes the server
        // cascade-rejected, and covers changes this user saved that are only in
        // localAddedChanges (not yet in submission.changes).
        if (data.status !== 'approved' && data.status !== 'rejected') return;
        const ids = isCollab ? resolvedChangeIds(data) : [data.changeId];
        const resolver: ChangeResolver = { id: message.userEmail || message.userId, name: message.userName };
        for (const id of ids) {
          onRemoteChangeResolvedRef.current?.(id, data.status, resolver);
        }
        setLocalAddedChanges(prev => applyChangeStatus(prev, ids, data.status, resolver));
        onRemoteStatusRef.current(ids, data.status, resolver);
        // Collaborative mode: then refetch the change list so the server's status wins
        // (a refetch only updates the sidebar there; the editor never re-initializes).
        if (isCollab) scheduleStatusRefresh();
      });
    }
  }, [handleWebSocketUpdate, currentUser.id, currentUser.email, effectiveUserId, isCollab, scheduleStatusRefresh]);

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

  // ---- Collaborative mode (Yjs) editor callbacks ----

  /**
   * The local user's own edit (the editor never reports remote or programmatic changes
   * here in collaborative mode). Starts a transaction from the current baseline, which
   * already includes every edit merged from other users.
   */
  const handleCollabLocalChange = useCallback((json: string) => {
    collabEditorReportedRef.current = true;
    const tm = transactionManagerRef.current;
    const tracking = !!tm && hasInitializedContentRef.current &&
      !tm.isPausedForResolution() && !(window as any).__isApplyingDecorations;
    if (tm && tracking) {
      if (!tm.getActiveTransaction()) {
        const beforeState = editedProposedContentRef.current || json;
        hasActiveTransactionRef.current = !!tm.startTransaction('content', beforeState);
        // The editor reports a local edit before @lexical/yjs writes it to the Y.Doc, so
        // the session also records this first edit.
        if (hasActiveTransactionRef.current && collabSessionRef.current) {
          localEditSessionRef.current = collabSessionRef.current.tracker.begin();
        }
      }
      tm.notifyActivity(json);
      lastLocalJsonRef.current = json;
    }
    editedProposedContentRef.current = json;
    setEditedProposedContent(json);
  }, []);

  /**
   * Content the local user didn't just type: 'remote' (another user's edit merged through
   * Yjs) or 'baseline' (the initial seed or sync, tracked-change bookkeeping). Updates the
   * baseline without starting a transaction. A remote edit during a local transaction
   * settles that transaction first, with the local user's last own state.
   */
  const handleCollabRemoteChange = useCallback((json: string, kind: 'remote' | 'baseline') => {
    collabEditorReportedRef.current = true;
    const tm = transactionManagerRef.current;
    if (tm && tm.getActiveTransaction()) {
      if (kind === 'remote') {
        // With a local-edit session the transaction stays open: its before-state is
        // rebuilt at settle time without this user's edits. Without one, settle now with
        // the user's own last state so the other user's edit isn't credited to them.
        if (!localEditSessionRef.current) {
          if (lastLocalJsonRef.current) {
            tm.settleTransaction(lastLocalJsonRef.current);
          }
          hasActiveTransactionRef.current = false;
          lastLocalJsonRef.current = null;
        }
      } else {
        // Local bookkeeping during the user's own transaction: part of their after-state.
        lastLocalJsonRef.current = json;
      }
    }
    editedProposedContentRef.current = json;
    setEditedProposedContent(json);
  }, []);

  /** The live Yjs session came or went (a long outage starts a new one with a new doc). */
  const handleCollabSessionReady = useCallback((session: CollabSession | null) => {
    if (session === null && localEditSessionRef.current) {
      // The session's doc is going away: settle the open transaction with the user's own
      // last state while the recorded edits can't be used any more.
      const tm = transactionManagerRef.current;
      localEditSessionRef.current = null;
      if (tm?.getActiveTransaction() && lastLocalJsonRef.current) {
        tm.settleTransaction(lastLocalJsonRef.current);
        hasActiveTransactionRef.current = false;
      }
    }
    collabSessionRef.current = session;
  }, []);

  /** Before-state text for DeletionInterceptionPlugin: the document without this user's open edits. */
  const getCollabBeforeText = useCallback((): string | null => {
    const tm = transactionManagerRef.current;
    const session = localEditSessionRef.current;
    const collab = collabSessionRef.current;
    if (!tm?.getActiveTransaction()) return null;
    if (session && collab) {
      try {
        return extractTextFromLexical(collab.tracker.baselineJson(session));
      } catch (error) {
        console.error('[YJS] Could not rebuild the before-state', error);
      }
    }
    return tm.getActiveTransaction()?.beforeSnapshot?.text ?? null;
  }, []);

  /**
   * Seed for an empty room (read only on the client the server picks as seeder): the
   * newest content this client knows (its own saves don't refetch the submission), else
   * the fetched content. Never the placeholder text.
   */
  const getCollabSeedContent = useCallback((): string => {
    return editedProposedContentRef.current || savedContentRef.current || '';
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
      {/* "Rejected · Undo" after a decision */}
      {undoToast && (
        <UndoToast
          message={undoToast.message}
          onUndo={handleToastUndo}
          onDismiss={dismissUndoToast}
          busy={undoToast.ids.some(id => undoBusyIds.has(id))}
        />
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

            {/* Save status in words; edits save on pause, hide, unload and unmount (no Save button) */}
            <SaveStatus transactionManager={transactionManager} />
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
              {`${allTrackedChanges.filter(c => c.status === 'approved').length} approved`}
            </span>
            <span className="stat rejected">
              {`${allTrackedChanges.filter(c => c.status === 'rejected').length} rejected`}
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

          <div className="document-field-row required-approvers-row">
            <span className="field-row-label">Approvers:</span>
            <div className="required-approvers-content">
              {(submission.requiredApprovers || []).length === 0 && !canEditRequiredApprovers && (
                <span className="field-row-value" style={{ color: '#9ca3af' }}>None assigned</span>
              )}
              {(submission.requiredApprovers || []).map((email) => {
                const user = allApproverUsers.find(u => u.email === email);
                const displayName = user?.name || email.split('@')[0];
                return (
                  <span key={email} className="approver-chip" title={email}>
                    {displayName}
                    {canEditRequiredApprovers && (
                      <button onClick={() => handleRemoveRequiredApprover(email)} className="approver-chip-remove" title="Remove approver">
                        <i className="fas fa-times" />
                      </button>
                    )}
                  </span>
                );
              })}
              {canEditRequiredApprovers && (
                <div className="approver-search-wrap">
                  <input
                    type="text"
                    placeholder="Search by name or email..."
                    autoComplete="new-password"
                    value={newApproverEmail}
                    onChange={(e) => handleApproverSearchChange(e.target.value)}
                    onFocus={() => { if (!newApproverEmail) showApproverDefaults(); }}
                    onBlur={() => setTimeout(() => setApproverSuggestions([]), 200)}
                    onKeyDown={handleApproverKeyDown}
                    className="approver-search-input"
                  />
                  {approverSuggestions.length > 0 && (
                    <div className="approver-dropdown">
                      {approverSuggestions.slice(0, 6).map((u, i) => {
                        const isManager = councilManagersList.some(m => m.email === u.email);
                        return (
                          <div
                            key={u.email}
                            className={`approver-dropdown-item ${i === activeSuggestionIdx ? 'active' : ''}`}
                            onMouseDown={(e) => { e.preventDefault(); handleSuggestionSelect(u.email); }}
                          >
                            <div className="approver-dropdown-info">
                              <span className="approver-dropdown-name">{u.name || u.email.split('@')[0]}</span>
                              <span className="approver-dropdown-email">{u.email}</span>
                            </div>
                            {isManager && <span className="approver-badge-cm">Council Manager</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="document-meta">
            <span>Submitted by <UserName value={submission.submittedBy} /></span>
            <span className="separator">•</span>
            <span>{new Date(submission.submittedAt).toLocaleDateString()}</span>
          </div>

          <div className="document-body">
            {/* Save status, view switch (Proposed | Compare | Original) and Send */}
            <DocumentViewBar
              view={activeTab}
              onViewChange={setActiveTab}
              submissionStatus={submission.status}
              transactionManager={reviewMode ? transactionManager : undefined}
            />

            {/* Proposed Version */}
            {activeTab === 'proposed' && <div className="proposed-version-section">
              {/* Action bar - only shown when there are actions available */}
              <div className="proposed-content">
                <div className="rich-text-editor-container">
                  <CollaborativeEditor
                    key={isCollab ? `proposed-collaborative-editor:${submission.id}` : 'proposed-collaborative-editor'}
                    documentId={submission.id}
                    currentUser={currentUser}
                    initialContent={proposedEditorContent}
                    collabMode={collabMode}
                    onRemoteContentChange={isCollab ? handleCollabRemoteChange : undefined}
                    getCollabSeedContent={isCollab ? getCollabSeedContent : undefined}
                    onCollabSessionReady={isCollab ? handleCollabSessionReady : undefined}
                    getCollabBeforeText={isCollab ? getCollabBeforeText : undefined}
                    onContentChange={isCollab ? handleCollabLocalChange : (json, cursorPosition) => {
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
                          Sent{submission.sentBy ? <> by <UserName value={submission.sentBy} /></> : ''}
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
                    <ReviewPanel {...reviewPanelProps} />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Desktop sidebar - only shown on larger screens (always visible in review mode) */}
        {(!isSmallScreen || reviewMode) && (
          <div className={`editor-sidebar ${reviewMode ? 'review-panel' : ''} ${sidebarCollapsed && !reviewMode ? 'collapsed' : ''} ${sidebarAutoCollapsed ? 'auto-collapsed' : ''}`}>
            {sidebarCollapsed && !reviewMode && (
              <div className="sidebar-header">
                <button
                  className="sidebar-toggle-btn"
                  onClick={toggleSidebar}
                  title="Expand sidebar"
                >
                  ◀
                </button>
              </div>
            )}
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
                <ReviewPanel
                  {...reviewPanelProps}
                  headerExtra={!reviewMode ? (
                    <button
                      className="sidebar-toggle-btn"
                      onClick={toggleSidebar}
                      title="Collapse sidebar"
                    >
                      ▶
                    </button>
                  ) : undefined}
                />
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