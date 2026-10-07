import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FeedbackCarrot } from '../FeedbackCarrot';

jest.mock('../../utils/screenshot', () => ({
  captureScreenshot: () => Promise.resolve('data:image/jpeg;base64,/9j/AAAA'),
}));

let fetchMock: jest.Mock;
let enabled = true;

function json(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  enabled = true;
  localStorage.setItem('sessionId', 's');
  fetchMock = jest.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/feedback/config')) return json({ enabled });
    if (url.endsWith('/feedback') && init?.method === 'POST') return json({ id: 'f1', emailed: true }, 201);
    return json({ error: 'not found' }, 404);
  });
  (global as any).fetch = fetchMock;
});

describe('the feedback tab', () => {
  it('is hidden unless it is on for the signed-in person', async () => {
    enabled = false;
    render(<FeedbackCarrot signedInAs="pat@x.org" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Send feedback' })).not.toBeInTheDocument();
  });

  it('is never shown when signed out', () => {
    render(<FeedbackCarrot signedInAs={null} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Send feedback' })).not.toBeInTheDocument();
  });

  it('takes a screenshot, then sends the message with it and the diagnostics', async () => {
    render(<FeedbackCarrot signedInAs="pat@x.org" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));
    const box = await screen.findByLabelText('What happened? What did you expect?');
    expect(screen.getByAltText('Screenshot of the page')).toHaveAttribute('src', 'data:image/jpeg;base64,/9j/AAAA');
    expect(screen.getByRole('button', { name: /Send to the Admins/ })).toBeDisabled();

    fireEvent.change(box, { target: { value: 'Save did nothing' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to the Admins/ }));
    await screen.findByText(/Your feedback went to the Scribe Admins/);

    const [, init] = fetchMock.mock.calls.find(([url, i]) => url.endsWith('/feedback') && i?.method === 'POST');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ message: 'Save did nothing', screenshot: 'data:image/jpeg;base64,/9j/AAAA' });
    expect(body.diagnostics).toEqual(expect.objectContaining({ page: expect.any(Object), network: expect.any(Array), errors: expect.any(Array) }));
    expect(init.headers.Authorization).toBe('Bearer s');
  });

  it('can leave the screenshot out, and shows why a send failed', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/feedback/config')) return json({ enabled: true });
      return json({ error: 'That is a lot of feedback this hour. Please try again later.' }, 429);
    });
    render(<FeedbackCarrot signedInAs="pat@x.org" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));
    fireEvent.change(await screen.findByLabelText('What happened? What did you expect?'), { target: { value: 'Hi' } });
    fireEvent.click(screen.getByLabelText('Include screenshot'));
    fireEvent.click(screen.getByRole('button', { name: /Send to the Admins/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That is a lot of feedback this hour');
    const [, init] = fetchMock.mock.calls.find(([url, i]) => url.endsWith('/feedback') && i?.method === 'POST');
    expect(JSON.parse(init.body).screenshot).toBeNull();
    // The message is kept to try again
    expect(screen.getByLabelText('What happened? What did you expect?')).toHaveValue('Hi');
  });
});
