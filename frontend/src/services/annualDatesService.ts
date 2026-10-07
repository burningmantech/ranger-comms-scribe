import { API_URL } from '../config';
import { AnnualDate, AnnualDateInput, DateLink } from '../types/annualDates';
import { ContentSubmission } from '../types/content';

/** Client for /api/annual-dates and a request's linked dates. Every method throws an Error with the server's message. */
class AnnualDatesService {
  private getAuthHeaders(): HeadersInit {
    const sessionId = localStorage.getItem('sessionId');
    return {
      'Content-Type': 'application/json',
      'Authorization': sessionId ? `Bearer ${sessionId}` : ''
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: this.getAuthHeaders(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error((body as { error?: string }).error || `Request failed (${response.status})`);
    }
    return body as T;
  }

  list(): Promise<{ entries: AnnualDate[]; canEditAll: boolean }> {
    return this.request('/annual-dates/');
  }

  create(input: AnnualDateInput): Promise<AnnualDate> {
    return this.request('/annual-dates/', { method: 'POST', body: JSON.stringify(input) });
  }

  update(id: string, input: AnnualDateInput): Promise<AnnualDate> {
    return this.request(`/annual-dates/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) });
  }

  remove(id: string): Promise<void> {
    return this.request(`/annual-dates/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** A request as stored (for its text, blurb and linked dates). */
  getSubmission(submissionId: string): Promise<ContentSubmission> {
    return this.request(`/content/submissions/${encodeURIComponent(submissionId)}`);
  }

  saveDateLinks(submissionId: string, dateLinks: DateLink[]): Promise<{ dateLinks: DateLink[] }> {
    return this.request(`/content/submissions/${encodeURIComponent(submissionId)}/date-links`, {
      method: 'PUT',
      body: JSON.stringify({ dateLinks }),
    });
  }
}

export const annualDatesService = new AnnualDatesService();
