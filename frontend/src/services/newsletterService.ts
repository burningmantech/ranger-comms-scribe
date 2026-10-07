import { API_URL } from '../config';
import {
  EditionPreview,
  EditionSummary,
  EditionView,
  KeyDate,
  NewsletterEdition,
  NewsletterRequest,
  TrayItem,
  WritingHelp,
} from '../types/newsletter';

/** An API error with the server's message and status (409 conflicts carry the newer edition). */
export class NewsletterApiError extends Error {
  constructor(public status: number, message: string, public body: any = {}) {
    super(message);
  }
}

/** The fields of an edition the editor saves (PUT /newsletter/editions/:id). */
export type EditionPatch = Partial<Pick<NewsletterEdition,
  'number' | 'title' | 'tagline' | 'subject' | 'intro' | 'sections' | 'calendar' | 'calendarHidden' | 'footnotes' | 'replyTo'>>;

class NewsletterService {
  private getAuthHeaders(): HeadersInit {
    const sessionId = localStorage.getItem('sessionId');
    return {
      'Content-Type': 'application/json',
      Authorization: sessionId ? `Bearer ${sessionId}` : '',
    };
  }

  private async request<T>(path: string, init: RequestInit = {}, base = `${API_URL}/newsletter`): Promise<T> {
    const response = await fetch(`${base}${path}`, { ...init, headers: { ...this.getAuthHeaders(), ...(init.headers || {}) } });
    let body: any = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw new NewsletterApiError(response.status, body?.error || `Request failed (${response.status})`, body || {});
    }
    return body as T;
  }

  listEditions(): Promise<{ editions: EditionSummary[]; nextNumber: number }> {
    return this.request('/editions');
  }

  createEdition(input: { number?: number; subject?: string } = {}): Promise<EditionView> {
    return this.request('/editions', { method: 'POST', body: JSON.stringify(input) });
  }

  getEdition(id: string): Promise<EditionView> {
    return this.request(`/editions/${id}`);
  }

  /** Saves the patch onto `version`; a 409 means someone else saved first. */
  updateEdition(id: string, version: number, patch: EditionPatch): Promise<EditionView> {
    return this.request(`/editions/${id}`, { method: 'PUT', body: JSON.stringify({ ...patch, version }) });
  }

  deleteEdition(id: string): Promise<{ success: true }> {
    return this.request(`/editions/${id}`, { method: 'DELETE' });
  }

  getTray(): Promise<{ ready: TrayItem[]; upcoming: TrayItem[] }> {
    return this.request('/tray');
  }

  addFromSubmission(id: string, submissionId: string): Promise<EditionView> {
    return this.request(`/editions/${id}/sections/from-submission`, { method: 'POST', body: JSON.stringify({ submissionId }) });
  }

  refreshSection(id: string, sectionId: string): Promise<EditionView> {
    return this.request(`/editions/${id}/sections/${sectionId}/refresh`, { method: 'POST' });
  }

  preview(id: string, signal?: AbortSignal): Promise<EditionPreview> {
    return this.request(`/editions/${id}/preview`, { signal });
  }

  submitForApproval(id: string): Promise<EditionView> {
    return this.request(`/editions/${id}/submit`, { method: 'POST' });
  }

  decide(id: string, version: number, status: 'approved' | 'rejected', comment?: string): Promise<EditionView> {
    return this.request(`/editions/${id}/approve`, { method: 'POST', body: JSON.stringify({ status, comment, version }) });
  }

  override(id: string, version: number, reason: string): Promise<EditionView> {
    return this.request(`/editions/${id}/override-approve`, { method: 'POST', body: JSON.stringify({ reason, version }) });
  }

  comment(id: string, content: string): Promise<EditionView> {
    return this.request(`/editions/${id}/comments`, { method: 'POST', body: JSON.stringify({ content }) });
  }

  sendTest(id: string): Promise<{ to: string }> {
    return this.request(`/editions/${id}/send-test`, { method: 'POST' });
  }

  send(id: string): Promise<EditionView> {
    return this.request(`/editions/${id}/send`, { method: 'POST' });
  }

  /** A request's newsletter item, key dates and writing help (PATCH /content/submissions/:id/newsletter). */
  updateRequestNewsletter(
    submissionId: string,
    fields: { newsletter?: NewsletterRequest | null; keyDates?: KeyDate[]; writingHelp?: WritingHelp },
  ): Promise<{ newsletter: NewsletterRequest | null; keyDates: KeyDate[]; writingHelp: WritingHelp; updatedAt: string }> {
    return this.request(`/submissions/${submissionId}/newsletter`, { method: 'PATCH', body: JSON.stringify(fields) }, `${API_URL}/content`);
  }

  // Public pages (no session needed)

  listPublished(): Promise<{ editions: Array<{ number: number; subject: string; sentAt: string }> }> {
    return this.request('/newsletter', {}, `${API_URL}/public`);
  }

  getPublishedEdition(number: number): Promise<{ number: number; subject: string; sentAt: string; html: string }> {
    return this.request(`/newsletter/${number}`, {}, `${API_URL}/public`);
  }

  getPublishedDocument(slug: string): Promise<{ subject: string; publishedAt: string; html: string }> {
    return this.request(`/news/${encodeURIComponent(slug)}`, {}, `${API_URL}/public`);
  }
}

export const newsletterService = new NewsletterService();
export default newsletterService;
