/** The newsletter ("Black Rock Ranger News"); mirrors backend/src/types.ts. */

/** A date or deadline (YYYY-MM-DD, optional end date) for the newsletter calendar. */
export interface KeyDate {
  date: string;
  endDate?: string;
  label: string;
  link?: string;
  linkLabel?: string;
  /** The annual date this row follows; the date stays as written and is flagged when the table disagrees. */
  annualDateId?: string;
}

export interface NewsletterLink {
  label: string;
  url: string;
}

export interface NewsletterPhoto {
  /** Gallery URL (/api/gallery/<file>) or an absolute URL. */
  src: string;
  mediumSrc?: string;
  alt: string;
  credit?: string;
  caption?: string;
}

export type ReadMoreKind = 'none' | 'document' | 'url';

export interface NewsletterReadMore {
  kind: ReadMoreKind;
  submissionId?: string;
  url?: string;
  label?: string;
}

/** What a request asks to have in the newsletter. */
export interface NewsletterRequest {
  headline?: string;
  /** Lexical JSON. */
  blurb?: string;
  photos: NewsletterPhoto[];
  links: NewsletterLink[];
  readMore: NewsletterReadMore;
}

export interface WritingHelp {
  document?: boolean;
  blurb?: boolean;
}

export type EditionStatus = 'draft' | 'in_review' | 'approved' | 'sent';

export interface NewsletterSection {
  id: string;
  kind: 'item' | 'custom';
  sourceSubmissionId?: string;
  sourceHash?: string;
  heading: string;
  important?: boolean;
  body: string;
  photos: NewsletterPhoto[];
  links: NewsletterLink[];
  readMore: NewsletterReadMore;
  keyDates: KeyDate[];
}

export interface CalendarRow extends KeyDate {
  id: string;
}

export interface EditionApproval {
  id: string;
  approverId: string;
  approverEmail: string;
  approverName: string;
  asCommsCadre: boolean;
  asCommsManager: boolean;
  status: 'approved' | 'rejected';
  comment?: string;
  version: number;
  createdAt: string;
}

export interface EditionComment {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export interface NewsletterEdition {
  id: string;
  number: number;
  title: string;
  tagline: string;
  subject: string;
  intro?: string;
  sections: NewsletterSection[];
  calendar: CalendarRow[];
  calendarHidden: string[];
  footnotes?: string;
  replyTo?: string;
  status: EditionStatus;
  version: number;
  approvals: EditionApproval[];
  approvedVersion?: number;
  approvalOverride?: { by: string; byName: string; reason: string; at: string; version: number };
  comments: EditionComment[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  sentBy?: string;
  sentAt?: string;
}

export interface ApprovalState {
  version: number;
  commsCadre: { met: boolean; by?: string };
  commsManager: { met: boolean; by?: string };
  rejectedBy: string[];
  override: boolean;
}

export interface SectionSource {
  submissionId: string;
  title: string;
  status: string;
  changed: boolean;
}

export interface EditorCalendarEntry extends KeyDate {
  key: string;
  source: 'section' | 'manual';
  sectionId?: string;
  rowId?: string;
  hidden: boolean;
  past: boolean;
}

/** GET/PUT /newsletter/editions/:id and the action endpoints. */
export interface EditionView {
  edition: NewsletterEdition;
  approval: ApprovalState;
  sources: Record<string, SectionSource>;
  calendar: EditorCalendarEntry[];
  documents: Record<string, { title: string; status: string; url: string | null }>;
  /** Who can give the Communications Manager approval (Admin → Council). */
  commsManagers: Array<{ name: string; email: string }>;
  permissions: {
    canApprove: boolean;
    /** The gates the signed-in user's approval counts for. */
    approvesAs: { commsCadre: boolean; commsManager: boolean };
    canOverride: boolean;
    isCommsManager: boolean;
    announceConfigured: boolean;
  };
}

export interface EditionSummary {
  id: string;
  number: number;
  subject: string;
  status: EditionStatus;
  sectionCount: number;
  updatedAt: string;
  sentAt?: string;
  approval: ApprovalState;
}

export interface TrayItem {
  id: string;
  title: string;
  status: string;
  submittedAt: string;
  publishBy?: string;
  headline: string;
  hasBlurb: boolean;
  photoCount: number;
  keyDateCount: number;
  readMore: ReadMoreKind;
  writingHelp: { document: boolean; blurb: boolean };
}

export interface EditionPreview {
  subject: string;
  html: string;
  text: string;
  sizeBytes: number;
  warnings: string[];
  to: string | null;
  replyTo: string | null;
  version: number;
}

export const EMPTY_NEWSLETTER_REQUEST: NewsletterRequest = {
  headline: '',
  blurb: '',
  photos: [],
  links: [],
  readMore: { kind: 'none' },
};

/** Lexical JSON with no text in it (an empty editor), or no content at all. */
export function isBlankRichText(value: string | undefined | null): boolean {
  if (!value || !value.trim()) return true;
  try {
    const parsed = JSON.parse(value);
    const walk = (node: any): boolean => {
      if (!node || typeof node !== 'object') return false;
      if (typeof node.text === 'string' && node.text.trim()) return true;
      if (node.type === 'image') return true;
      return Array.isArray(node.children) && node.children.some(walk);
    };
    return !walk(parsed.root || parsed.editorState?.root);
  } catch {
    return !value.trim();
  }
}
