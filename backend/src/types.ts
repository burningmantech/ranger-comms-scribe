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
  isAdmin: boolean; // Admin (services/access.ts)
  userType: UserType; // Derived from the access fields on every save: Admin › CouncilManager › CommsCadre › Member › Public
  groups: string[]; // Array of group IDs the user belongs to
  roles: string[]; // Derived from the access fields below on every save (services/access.ts); never set directly
  /** Comms Cadre: reviews requests, builds and sends the newsletter (services/access.ts). */
  commsCadre?: boolean;
  /** Council roles held (any number), e.g. CommunicationsManager. */
  councilRoles?: CouncilRole[];
  /** 1 once the record holds the access fields above (migrations/peopleAccess.ts). */
  accessVersion?: number;
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
  /**
   * The content as submitted: copies of `content` and `richTextContent` taken when the
   * submission is created and never changed afterwards (PUT keeps them). Accepting or
   * rejecting tracked changes rewrites `content` / `richTextContent`, so the review tool's
   * Original view and Compare baseline read these. Missing on submissions created before
   * they existed.
   */
  originalContent?: string;
  originalRichTextContent?: string;
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
  /** Audience keys ('newsletter', 'singular', ...). Older submissions only have the labels in formFields.audience; read both through audienceKeys(). */
  audiences?: string[];
  /** The submitter asked Comms to write the full document and/or the newsletter blurb. */
  writingHelp?: WritingHelp;
  /** The newsletter item, when the audience includes the newsletter. Edited directly, not through tracked changes. */
  newsletter?: NewsletterRequest;
  /** Dates and deadlines; they go in the newsletter calendar. */
  keyDates?: KeyDate[];
  /** The public "Read more" page (/news/<slug>). The slug is made when an edition links the document; the page is served once published. */
  publicSlug?: string;
  publicPublishedAt?: string;
  /** The edition this item is placed in (cleared when its section is removed). */
  newsletterEditionId?: string;
  /** The number of the edition this item went out in. */
  newsletterSentIn?: number;
  /** The mailing lists the announcement was sent to (send-email). */
  sentTo?: Array<{ id: string; name: string; address: string }>;
  /** Approval reminders sent (POST /submissions/:id/remind), newest last. */
  reminders?: SubmissionReminder[];
  updatedAt?: string;
}

/** A reminder to approve: to one required approver (target = their email), or to everyone
 *  who can meet a gate (target 'council' or 'commsCadre'). */
export interface SubmissionReminder {
  target: string;
  to: string[];
  by: string;
  byName: string;
  at: string;
}

/** A mailing list approved announcements can be sent to (Requests → Settings). */
export interface MailingList {
  id: string;
  name: string;
  address: string;
  description?: string;
  /** Request audiences (keys) that suggest this list when sending. */
  audiences: string[];
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Ranger Announce: from ANNOUNCE_EMAIL_TO, not editable. */
  builtIn?: boolean;
}

export interface WritingHelp {
  document?: boolean;
  blurb?: boolean;
}

/** A date or deadline (YYYY-MM-DD, with an optional end date) for the newsletter calendar. */
export interface KeyDate {
  date: string;
  endDate?: string;
  label: string;
  link?: string;
  linkLabel?: string;
}

export interface NewsletterLink {
  label: string;
  url: string;
}

export interface NewsletterPhoto {
  /** Gallery URL (/api/gallery/<file>) or an absolute http(s) URL. */
  src: string;
  mediumSrc?: string;
  alt: string;
  credit?: string;
  caption?: string;
}

/**
 * Where an item's "Read more" goes: nowhere, the full document (its public page), or a URL.
 * In an edition, `submissionId` names the document; in a request it is the request's own.
 */
export interface NewsletterReadMore {
  kind: 'none' | 'document' | 'url';
  submissionId?: string;
  url?: string;
  label?: string;
}

/** What the submitter asks to have in the newsletter. */
export interface NewsletterRequest {
  /** Defaults to the submission title. */
  headline?: string;
  /** A few lines (Lexical JSON). */
  blurb?: string;
  photos: NewsletterPhoto[];
  links: NewsletterLink[];
  readMore: NewsletterReadMore;
}

export type NewsletterEditionStatus = 'draft' | 'in_review' | 'approved' | 'sent';

/** One section of an edition: a snapshot of a request's newsletter item, or written by the cadre. */
export interface NewsletterSection {
  id: string;
  kind: 'item' | 'custom';
  /** The request this section was made from, and a hash of its newsletter item at that time. */
  sourceSubmissionId?: string;
  sourceHash?: string;
  heading: string;
  /** Shown as a highlighted panel ("Important: ..."). */
  important?: boolean;
  /** Lexical JSON. */
  body: string;
  photos: NewsletterPhoto[];
  links: NewsletterLink[];
  readMore: NewsletterReadMore;
  keyDates: KeyDate[];
}

/** A calendar row added by hand (rows from sections are derived when rendering). */
export interface CalendarRow extends KeyDate {
  id: string;
}

export interface EditionApproval {
  id: string;
  approverId: string;
  approverEmail: string;
  approverName: string;
  /** Which gates this person counted for when they decided. */
  asCommsCadre: boolean;
  asCommsManager: boolean;
  status: 'approved' | 'rejected';
  comment?: string;
  /** The edition version this decision is about; a later edit makes it stale. */
  version: number;
  createdAt: string;
}

export interface NewsletterEdition {
  id: string;
  number: number;
  /** Masthead. */
  title: string;
  tagline: string;
  /** Subject before " - Ranger News #N". */
  subject: string;
  /** Optional opening text under the masthead (Lexical JSON). */
  intro?: string;
  sections: NewsletterSection[];
  calendar: CalendarRow[];
  /** Keys (calendarRowKey) of derived calendar rows the cadre removed. */
  calendarHidden: string[];
  /** Footnotes (Lexical JSON). */
  footnotes?: string;
  replyTo?: string;
  status: NewsletterEditionStatus;
  /** Bumped on every content change; saves must name the version they edited. */
  version: number;
  approvals: EditionApproval[];
  approvedVersion?: number;
  approvalOverride?: { by: string; byName: string; reason: string; at: string; version: number };
  comments: ContentComment[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
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
  /** Who resolved the thread (email, else id) and when; cleared when it is reopened. */
  resolvedBy?: string;
  resolvedByName?: string;
  resolvedAt?: string;
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

export interface ApprovalGateDetail {
  met: boolean;
  approver?: string;
  approverName?: string;
  date?: string;
  comment?: string;
}

export interface ApprovalGates {
  councilManager: ApprovalGateDetail;
  commsCadre: ApprovalGateDetail;
  requiredApprovers: {
    met: boolean;
    approved: number;
    total: number;
    details: Array<{
      email: string;
      name?: string;
      status: 'approved' | 'rejected' | 'pending';
      date?: string;
    }>;
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
  groupKey?: string; // For grouping related events (e.g., same author within 2 min)
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

export interface SubmissionTemplate {
  id: string;
  name: string;
  description: string;
  fields: {
    audience?: string[];
    signatureText?: string;
    suggestedSubjectLine?: string;
    description?: string;
    [key: string]: any;
  };
  sortOrder: number;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** How a communication went out: the Announce list, the Ranger Newsletter, both, or neither. */
export type CommsMethod = 'Announce' | 'Newsletter' | 'Both' | 'N/A';

/** One "would you like to send this again?" email to a team. */
export interface CommsCalendarNudge {
  at: string;
  /** Email of the person who sent the nudge. */
  by: string;
  byName: string;
  /** Who it was meant for (the team contacts), even when NUDGE_EMAIL_OVERRIDE redirected it. */
  to: string[];
  note?: string;
}

/**
 * A communication sent (or planned) in one Sep→Aug cycle, stored at comms_calendar/<id>.
 * Next year's version of it is a new entry whose carriedFromId points here.
 */
export interface CommsCalendarEntry {
  id: string;
  subject: string;
  /** Last year's message (http/https only). */
  link?: string;
  /** YYYY-MM-DD */
  targetDate?: string;
  /** YYYY-MM-DD (Pacific date) */
  dateSent?: string;
  /** The cycle (its start year) of an entry with neither date, e.g. an undated row imported from last year's sheet. */
  cycleYear?: number;
  method: CommsMethod;
  /** Free text: Council, Volunteer Coordinators, Camp Hosts, ... */
  team: string;
  contactEmails: string[];
  comments: string;
  /** The Scribe request this was sent from. Subject and dates are copied from it on send. */
  submissionId?: string;
  /** The Ranger News edition the request's newsletter item went out in. */
  newsletterSentIn?: number;
  /** Last year's entry that this one continues. */
  carriedFromId?: string;
  /** The team won't send it again: it leaves the Upcoming list. */
  notRepeating?: boolean;
  nudges: CommsCalendarNudge[];
  source: 'manual' | 'import' | 'submission';
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
}

export type NotificationType =
  | 'approval_received'
  | 'rejection_received'
  | 'changes_made'
  | 'assigned_as_approver'
  | 'submission_waiting'
  | 'ready_to_send'
  | 'comment_on_change'
  | 'comment_reply'
  | 'changes_requested'
  | 'newsletter_review';

export interface AppNotification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  submissionId?: string;
  submissionTitle?: string;
  actorName?: string;
  /** Where the notification opens, when it isn't a request's review page. */
  link?: string;
  read: boolean;
  createdAt: string;
}
