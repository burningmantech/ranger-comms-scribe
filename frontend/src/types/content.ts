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
}

interface RolePermissions {
  canEdit: boolean;
  canApprove: boolean;
  canCreateSuggestions: boolean;
  canApproveSuggestions: boolean;
  canReviewSuggestions: boolean;
  canViewFilteredSubmissions: boolean;
} 