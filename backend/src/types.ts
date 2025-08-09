// Shared types for the backend

import { Router } from 'itty-router';

export enum UserType {
  Public = 'Public',
  Member = 'Member',
  Lead = 'Lead',
  Admin = 'Admin',
  CommsCadre = 'CommsCadre',
  CouncilManager = 'CouncilManager'
}

export enum CouncilRole {
  CommunicationsManager = 'CommunicationsManager',
  IntakeManager = 'IntakeManager',
  LogisticsManager = 'LogisticsManager',
  OperationsManager = 'OperationsManager',
  PersonnelManager = 'PersonnelManager',
  DepartmentManager = 'DepartmentManager',
  DeputyDepartmentManager = 'DeputyDepartmentManager'
}

export interface Page {
  id: string;
  title: string;
  slug: string;
  content: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  published: boolean;
  isPublic: boolean;
  groupId?: string; // Optional group ID if not public
  order: number; // For ordering in navigation
  showInNavigation: boolean; // Whether to show in main navigation
  isHome?: boolean; // Whether this is the home page
  parentPageId?: string; // Optional parent page ID for hierarchical navigation
}

export interface User {
  id: string;
  name: string;
  email: string;
  approved: boolean;
  isAdmin: boolean; // Keeping for backward compatibility
  userType: UserType;
  groups: string[]; // Array of group IDs the user belongs to
  roles: string[]; // Array of role names
  passwordHash?: string; // Added for email/password authentication
  verified?: boolean; // Added for email verification
  notificationSettings?: {
    notifyOnReplies: boolean; // Notify when someone replies to posts or comments
    notifyOnGroupContent: boolean; // Notify when content is posted in groups
  };
}

export interface Group {
  id: string;
  name: string;
  description: string;
  createdBy: string; // User ID of creator
  createdAt: string;
  updatedAt: string;
  members: string[]; // Array of user IDs
}

export interface MediaItem {
  id: string;
  fileName: string;
  fileType: string;
  url: string;
  thumbnailUrl: string;
  mediumUrl?: string; // URL for medium-sized version (max 1024px)
  uploadedBy: string;
  uploaderName?: string; // Name of the user who uploaded the item
  uploadedAt: string;
  takenBy?: string; // Photographer or content creator name
  size: number;
  isPublic: boolean;
  groupId?: string; // Optional group ID if not public
  groupName?: string; // Optional group name if item belongs to a group
}

export interface BlogPost {
  id: string;
  title: string;
  content: string;
  author: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  published: boolean;
  commentsEnabled: boolean;
  media?: string[]; // Array of media item IDs
  isPublic: boolean;
  groupId?: string; // Optional group ID if not public
}

export interface BlogComment {
  id: string;
  postId: string;
  content: string;
  author: string;
  authorId: string;
  createdAt: string;
  isBlocked: boolean;
  parentId?: string; // If this is a reply, this points to the parent comment
  replies?: BlogComment[]; // Array of reply comments
  level?: number; // Comment nesting level (0, 1, 2 for up to 3 levels)
}

export interface BlockedUser {
  userId: string;
  blockedAt: string;
  blockedBy: string;
  reason?: string;
}

export interface GalleryComment {
  id: string;
  mediaId: string;
  content: string;
  author: string;
  authorId: string;
  createdAt: string;
  isBlocked: boolean;
  parentId?: string; // If this is a reply, this points to the parent comment
  replies?: GalleryComment[]; // Array of reply comments
  level: number; // Comment nesting level (0, 1, 2 for up to 3 levels)
}

export interface CouncilMember {
  id: string;
  userId: string;
  role: CouncilRole;
  email: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContentSubmission {
  id: string;
  title: string;
  content: string;
  richTextContent?: string; // Stores the Lexical editor state as JSON
  submittedBy: string;
  submittedAt: string;
  status: 'draft' | 'submitted' | 'in_review' | 'approved' | 'rejected' | 'sent';
  formFields: FormField[];
  comments: ContentComment[];
  approvals: ContentApproval[];
  changes: ContentChange[];
  commsCadreApprovals: number;
  councilManagerApprovals: ContentApproval[];
  finalApprovalDate?: string;
  announcementSent: boolean;
  assignedCouncilManagers: string[];
  requiredApprovers?: string[]; // Array of email addresses of required approvers
  // Optional metadata fields for overrides and sending
  approvalOverride?: boolean;
  approvalOverrideBy?: string; // user id or email
  approvalOverrideReason?: string;
  approvalOverrideAt?: string;
  sentBy?: string;
  sentAt?: string;
}

export interface FormField {
  id: string;
  name: string;
  type: 'text' | 'date' | 'time' | 'select' | 'multiselect';
  label: string;
  required: boolean;
  options?: string[]; // For select/multiselect fields
  value: string | string[];
}

export interface ContentComment {
  id: string;
  submissionId: string;
  content: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  isSuggestion: boolean;
  resolved: boolean;
  parentId?: string;
  replies?: ContentComment[];
}

export interface ContentApproval {
  id: string;
  submissionId: string;
  approverId: string;
  approverEmail: string; // Add email field for easier matching
  approverName: string;
  approverType: UserType;
  approverRoles?: string[]; // Capture all roles to support multi-role approvers
  status: 'approved' | 'rejected';
  comment?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentChange {
  id: string;
  submissionId: string;
  field: string;
  oldValue: string;
  newValue: string;
  changedBy: string;
  changedAt: string;
  reason?: string;
}

export interface Reminder {
  id: string;
  submissionId: string;
  approverId: string;
  lastSentAt: string;
  nextSendAt: string;
  status: 'pending' | 'sent' | 'approved';
}

export interface Request {
  params?: { [key: string]: string };
  user?: User;
}

export interface CustomRequest extends Request {
  params?: { [key: string]: string };
  user?: User;
  json(): Promise<any>;
}

export type CustomRequestHandler = (request: CustomRequest, env: any) => Promise<Response>;

// === COLLABORATIVE DOCUMENT TYPES ===

export interface CollaborativeDocument {
  id: string;
  title: string;
  content: string;
  richTextContent: string; // Lexical editor state as JSON
  createdBy: string;
  createdAt: string;
  lastModifiedBy: string;
  lastModifiedAt: string;
  version: number;
  permissions: DocumentPermissions;
  collaborators: DocumentCollaborator[];
  isPublic: boolean;
  groupId?: string; // Optional group access
  tags: string[];
  metadata: Record<string, any>;
  status: 'draft' | 'published' | 'archived';
  parentDocumentId?: string; // For document hierarchies
  forkFromDocumentId?: string; // For document forking
}

export interface DocumentPermissions {
  owner: string;
  editors: string[]; // Can edit content
  viewers: string[]; // Can view content
  commenters: string[]; // Can add comments
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
  transformedAgainst: string[]; // IDs of operations this was transformed against
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
