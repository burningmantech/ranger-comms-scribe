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
  approvalOverride?: boolean;
  approvalOverrideBy?: string;
  approvalOverrideReason?: string;
  approvalOverrideAt?: Date;
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
  rejectedBy?: string;
  approvedAt?: Date;
  rejectedAt?: Date;
  isIncremental?: boolean;
  previousVersionId?: string;
  completeProposedVersion?: string;
  richTextOldValue?: string;
  richTextNewValue?: string;
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