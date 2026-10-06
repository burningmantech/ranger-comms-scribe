import { KeyDate, NewsletterRequest, WritingHelp } from './newsletter';

/** A reminder to approve: to one required approver (target = email), or 'council' / 'commsCadre'. */
export interface SubmissionReminder {
  target: string;
  to: string[];
  by: string;
  byName: string;
  at: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  roles: UserRole[];
}

export type UserRole =
  | 'Public'
  | 'Member'
  | 'Lead'
  | 'Admin'
  | 'CommsCadre'
  | 'CouncilManager'
  | 'REVIEWER'
  | 'SUBMITTER';

export interface CouncilManager {
  id: string;
  email: string;
  name: string;
  role: CouncilRole;
}

export type CouncilRole =
  | 'CommunicationsManager'
  | 'IntakeManager'
  | 'LogisticsManager'
  | 'OperationsManager'
  | 'PersonnelManager'
  | 'DepartmentManager'
  | 'DeputyDepartmentManager';

export interface ContentSubmission {
  id: string;
  title: string;
  content: string;
  richTextContent?: string;
  /**
   * The content as submitted (set at creation, never changed; see originalDocument() in
   * utils/originalContent.ts). content / richTextContent follow accepted and rejected changes.
   */
  originalContent?: string;
  originalRichTextContent?: string;
  status: SubmissionStatus;
  submittedBy: string;
  submittedAt: Date;
  formFields: FormField[];
  comments: Comment[];
  approvals: Approval[];
  changes: Change[];
  assignedReviewers: string[];
  assignedCouncilManagers: string[];
  suggestedEdits: SuggestedEdit[];
  requiredApprovers: string[];
  commsApprovedBy?: string;
  sentBy?: string;
  sentAt?: Date;
  proposedVersions?: Record<string, string>;
  approvalGates?: ApprovalGates;
  approvalOverride?: boolean;
  approvalOverrideBy?: string;
  approvalOverrideReason?: string;
  approvalOverrideAt?: Date;
  /** Audience keys ('newsletter', 'singular', ...); older requests only have formFields.audience. */
  audiences?: string[];
  writingHelp?: WritingHelp;
  /** The newsletter item (when the audience includes the newsletter). */
  newsletter?: NewsletterRequest;
  keyDates?: KeyDate[];
  publicSlug?: string;
  publicPublishedAt?: string;
  newsletterEditionId?: string;
  newsletterSentIn?: number;
  /** The mailing lists it was sent to. */
  sentTo?: Array<{ id: string; name: string; address: string }>;
  /** Approval reminders sent (POST /content/submissions/:id/remind). */
  reminders?: SubmissionReminder[];
  /** Set by GET /content/submissions/:id when the item is in an edition. */
  newsletterPlacement?: { editionId: string; number: number; status: string };
}

export type SubmissionStatus =
  | 'draft'
  | 'submitted'
  | 'in_review'
  | 'approved'
  | 'comms_approved'
  | 'sent'
  | 'rejected';

export interface FormField {
  id: string;
  label: string;
  type: 'text' | 'date' | 'time' | 'select' | 'multiselect';
  value: string | string[];
  required: boolean;
  options?: string[];
}

export interface SuggestedEdit {
  id: string;
  originalText: string;
  suggestedText: string;
  range: {
    startOffset: number;
    endOffset: number;
    startKey: string;
    endKey: string;
  };
  authorId: string;
  createdAt: Date;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewerId?: string;
  reviewedAt?: Date;
  reason?: string;
  contextBefore?: string;
  contextAfter?: string;
}

export interface Comment {
  id: string;
  content: string;
  authorId: string;
  createdAt: Date;
  type: 'COMMENT' | 'SUGGESTION';
  resolved: boolean;
  /** Who resolved the thread (email, else id), their name, and when (cleared on reopen). */
  resolvedBy?: string;
  resolvedByName?: string;
  resolvedAt?: Date | string;
  suggestedEdit?: SuggestedEdit;
}

export interface Approval {
  id: string;
  approverId: string;
  approverEmail: string; // Add email field for easier matching
  status: 'APPROVED' | 'REJECTED' | 'PENDING';
  comment?: string;
  timestamp: Date;
}

export interface Change {
  id: string;
  field: string;
  oldValue: string;
  newValue: string;
  changedBy: string;
  timestamp: Date;
  status?: 'pending' | 'approved' | 'rejected';
  approvedBy?: string;
  approvedByName?: string;
  rejectedBy?: string;
  rejectedByName?: string;
  approvedAt?: Date;
  rejectedAt?: Date;
  isIncremental?: boolean;
  previousVersionId?: string;
  completeProposedVersion?: string;
  richTextOldValue?: string;
  richTextNewValue?: string;
  regionMap?: { field: string; ranges: Array<{ start: number; end: number }> };
}

export interface ApprovalGateDetail {
  met: boolean;
  approver?: string;
  approverName?: string;
  date?: string;
  comment?: string;
}

/** One person on a request's approvers list and their decision. */
export interface ApproverDetail {
  email: string;
  name?: string;
  status: 'approved' | 'rejected' | 'pending';
  date?: string;
  /** Their council role, for a council member. */
  councilRole?: string;
}

/**
 * The approval gates (backend computeApprovalGates). The approvers list holds both kinds of
 * approver: its council members are the Council gate (at least one listed, all approved), the
 * rest `requiredApprovers` ("other approvers": all approved, met when there are none).
 */
export interface ApprovalGates {
  councilManager: ApprovalGateDetail & {
    /** The council members on the approvers list; none means the Comms Cadre still has to pick one. */
    approvers?: ApproverDetail[];
  };
  commsCadre: ApprovalGateDetail;
  requiredApprovers: {
    met: boolean;
    approved: number;
    total: number;
    /** The approvers on the list who are not on Council. */
    details: ApproverDetail[];
  };
  trackedChanges: {
    met: boolean;
    pending: number;
    total: number;
  };
}

export type TimelineEventType =
  | 'submission_created'
  | 'status_changed'
  | 'approval_decision'
  | 'tracked_changes_made'
  | 'tracked_change_reviewed'
  | 'comment_added'
  | 'approver_added'
  | 'approver_removed'
  | 'override_approval';

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  timestamp: string;
  actorId: string;
  actorName: string;
  actorEmail: string;
  summary: string;
  details?: Record<string, any>;
  groupKey?: string;
}

interface RolePermissions {
  canEdit: boolean;
  canApprove: boolean;
  canCreateSuggestions: boolean;
  canApproveSuggestions: boolean;
  canReviewSuggestions: boolean;
  canViewFilteredSubmissions: boolean;
}

// === COLLABORATIVE DOCUMENT TYPES ===

export interface CollaborativeDocument {
  id: string;
  title: string;
  content: string;
  richTextContent: string;
  createdBy: string;
  createdAt: string;
  lastModifiedBy: string;
  lastModifiedAt: string;
  version: number;
  permissions: DocumentPermissions;
  collaborators: DocumentCollaborator[];
  isPublic: boolean;
  groupId?: string;
  tags: string[];
  metadata: Record<string, any>;
  status: 'draft' | 'published' | 'archived';
  parentDocumentId?: string;
  forkFromDocumentId?: string;
}

export interface DocumentPermissions {
  owner: string;
  editors: string[];
  viewers: string[];
  commenters: string[];
  isPublic: boolean;
  allowFork: boolean;
  allowComments: boolean;
}

export interface DocumentCollaborator {
  userId: string;
  userName: string;
  userEmail: string;
  role: 'owner' | 'editor' | 'viewer' | 'commenter';
  joinedAt: string;
  lastActiveAt: string;
  cursor?: CursorPosition;
  isOnline: boolean;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  content: string;
  richTextContent: string;
  createdBy: string;
  createdAt: string;
  changeDescription?: string;
  operations: TextOperation[];
  parentVersionId?: string;
}

export interface DocumentComment {
  id: string;
  documentId: string;
  content: string;
  authorId: string;
  authorName: string;
  authorEmail: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  position?: CommentPosition;
  threadId?: string;
  parentCommentId?: string;
}

export interface CommentPosition {
  startOffset: number;
  endOffset: number;
  startKey: string;
  endKey: string;
}

export interface DocumentOperation {
  id: string;
  documentId: string;
  version: number;
  operations: TextOperation[];
  createdBy: string;
  createdAt: string;
  applied: boolean;
  transformedAgainst: string[];
}

export interface TextOperation {
  type: 'insert' | 'delete' | 'retain' | 'format';
  position: number;
  content?: string;
  length?: number;
  attributes?: Record<string, any>;
  version: number;
}

export interface CursorPosition {
  userId: string;
  userName: string;
  position: number;
  selectionStart?: number;
  selectionEnd?: number;
  timestamp: string;
}

export interface CollaborativeDocumentState {
  content: string;
  richTextContent: string;
  version: number;
  collaborators: Array<{
    userId: string;
    userName: string;
    isOnline: boolean;
    cursor?: CursorPosition;
  }>;
} 