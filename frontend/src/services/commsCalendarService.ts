import { API_URL } from '../config';
import {
  CommsCalendarEntry, CommsCalendarInput, ImportResult, UpcomingItem,
} from '../types/commsCalendar';

/** Client for /api/comms-calendar. Every method throws an Error with the server's message. */
class CommsCalendarService {
  private getAuthHeaders(): HeadersInit {
    const sessionId = localStorage.getItem('sessionId');
    return {
      'Content-Type': 'application/json',
      'Authorization': sessionId ? `Bearer ${sessionId}` : ''
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API_URL}/comms-calendar${path}`, {
      ...init,
      headers: this.getAuthHeaders(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error((body as { error?: string }).error || `Request failed (${response.status})`);
    }
    return body as T;
  }

  list(): Promise<{ entries: CommsCalendarEntry[]; canEdit: boolean }> {
    return this.request('/');
  }

  upcoming(days: number, today: string, lookback = 14): Promise<{ items: UpcomingItem[] }> {
    const params = new URLSearchParams({ days: String(days), today, lookback: String(lookback) });
    return this.request(`/upcoming?${params}`);
  }

  create(input: CommsCalendarInput): Promise<CommsCalendarEntry> {
    return this.request('/', { method: 'POST', body: JSON.stringify(input) });
  }

  update(id: string, input: CommsCalendarInput): Promise<CommsCalendarEntry> {
    return this.request(`/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) });
  }

  remove(id: string): Promise<void> {
    return this.request(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  nudge(id: string, to: string[], note?: string): Promise<{ entry: CommsCalendarEntry; sentTo: string[] }> {
    return this.request(`/${encodeURIComponent(id)}/nudge`, {
      method: 'POST',
      body: JSON.stringify({ to, ...(note ? { note } : {}) }),
    });
  }

  importEntries(entries: CommsCalendarInput[]): Promise<ImportResult> {
    return this.request('/import', { method: 'POST', body: JSON.stringify({ entries }) });
  }

  fromSubmission(submissionId: string): Promise<CommsCalendarEntry> {
    return this.request(`/from-submission/${encodeURIComponent(submissionId)}`, { method: 'POST' });
  }

  /** A past message (from its document) as a sent Scribe request on the entry for the cycle it went out in. */
  attachMessage(
    entryId: string,
    message: { title: string; content: string; richTextContent: string; link: string; publishedOn?: string },
  ): Promise<{ entry: CommsCalendarEntry; holder: CommsCalendarEntry; submissionId: string }> {
    return this.request(`/${encodeURIComponent(entryId)}/message`, { method: 'POST', body: JSON.stringify(message) });
  }
}

export const commsCalendarService = new CommsCalendarService();
