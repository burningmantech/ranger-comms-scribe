import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import UserSettings from '../UserSettings';

jest.mock('../../config', () => ({ API_URL: 'http://test-api' }));

const user = { id: 'u1', email: 'sam@x.org', name: 'Sam', userType: 'Member', roles: [] };

function setup(settings: Record<string, boolean> = {}) {
  localStorage.setItem('user', JSON.stringify(user));
  localStorage.setItem('sessionId', 'sess');
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return { ok: true, json: async () => ({}) } as Response;
    return { ok: true, json: async () => ({ notificationSettings: settings }) } as Response;
  });
  (global as any).fetch = fetchMock;
  render(<MemoryRouter><UserSettings skipNavbar /></MemoryRouter>);
  return fetchMock;
}

afterEach(() => {
  localStorage.clear();
});

describe('UserSettings', () => {
  it('shows the two email settings, both on by default, and the note', async () => {
    setup();
    const replies = await screen.findByLabelText('Email me about replies to my blog and gallery posts and comments');
    const updates = screen.getByLabelText('Email me when my requests change: changes requested, approved, sent');
    expect((replies as HTMLInputElement).checked).toBe(true);
    expect((updates as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Requests to approve something and reminders always come by email. Everything also shows under the bell.')).toBeTruthy();
    expect(screen.queryByText(/groups/i)).toBeNull();
  });

  it('saves both settings', async () => {
    const fetchMock = setup({ notifyOnReplies: true, submitterUpdates: true });
    const updates = await screen.findByLabelText('Email me when my requests change: changes requested, approved, sent');
    fireEvent.click(updates);
    fireEvent.click(screen.getByText('Save Settings'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]?.body))).toEqual({ notificationSettings: { notifyOnReplies: true, submitterUpdates: false } });
  });
});
