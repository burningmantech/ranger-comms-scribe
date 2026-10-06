import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SendPreview, EmailPreview, copyEmailToClipboard, handleFrameClick } from '../SendPreview';
import { API_URL } from '../../../config';

const PREVIEW: EmailPreview = {
  subject: 'Ticketing is OPEN: claim by July 12',
  to: 'announce-test@example.org',
  replyTo: 'ranger-ticketing@example.org',
  audience: 'Allcom',
  signature: 'Thanks,\nThe Ticketing Team',
  html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p style="margin:0;">You <strong>must</strong> claim.</p>'
    + '<img src="https://dev.scrivenly.com/api/gallery/1_pasted-image.png" alt="" width="513"></body></html>',
  text: 'You must claim.\n\nThanks,\nThe Ticketing Team\n',
};

function mockFetch(body: unknown, status = 200) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

describe('SendPreview', () => {
  const originalFetch = (global as any).fetch;

  beforeEach(() => {
    localStorage.setItem('sessionId', 'session-123');
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it('renders the HTML from the email-preview endpoint in a sandboxed frame, with the header', async () => {
    const fetchMock = mockFetch(PREVIEW);
    render(<SendPreview submissionId="sub-1" />);

    const frame = await screen.findByTitle('Email preview');
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_URL}/content/submissions/sub-1/email-preview`,
      expect.objectContaining({ headers: { Authorization: 'Bearer session-123' } }),
    );

    // The body is exactly the endpoint's HTML, never the editor's text
    const srcdoc = frame.getAttribute('srcdoc') || '';
    expect(srcdoc).toBe(PREVIEW.html);
    expect(srcdoc).toContain('You <strong>must</strong> claim.');
    expect(srcdoc).toContain('<img src="https://dev.scrivenly.com/api/gallery/1_pasted-image.png"');

    // Sandboxed: no scripts, no popups (links are opened by this page, see handleFrameClick)
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');

    expect(screen.getByTestId('send-preview-to')).toHaveTextContent('announce-test@example.org');
    expect(screen.getByTestId('send-preview-reply-to')).toHaveTextContent('ranger-ticketing@example.org');
    expect(screen.getByTestId('send-preview-subject')).toHaveTextContent('Ticketing is OPEN: claim by July 12');
    expect(screen.getByText('Allcom')).toBeInTheDocument();
  });

  it('says when sending is not configured and when the Reply-To is not an address', async () => {
    mockFetch({ ...PREVIEW, to: null, replyTo: null, replyToInvalid: 'not an address' });
    render(<SendPreview submissionId="sub-1" />);
    expect(await screen.findByTestId('send-preview-to')).toHaveTextContent('Not configured');
    expect(screen.getByTestId('send-preview-reply-to')).toHaveTextContent('not an address is not an email address');
  });

  it('shows the error from the endpoint', async () => {
    mockFetch({ error: 'Access denied' }, 403);
    render(<SendPreview submissionId="sub-1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Access denied');
    expect(screen.queryByTitle('Email preview')).not.toBeInTheDocument();
  });

  it('passes the loaded preview to the actions', async () => {
    mockFetch(PREVIEW);
    render(<SendPreview submissionId="sub-1" renderActions={(p) => <span>{p ? `send to ${p.to}` : 'loading'}</span>} />);
    expect(await screen.findByText('send to announce-test@example.org')).toBeInTheDocument();
  });

  it('copies HTML and plain text with Copy to Clipboard', async () => {
    mockFetch(PREVIEW);
    const write = jest.fn().mockResolvedValue(undefined);
    const items: any[] = [];
    (global as any).ClipboardItem = class {
      types: string[];
      constructor(public data: Record<string, Blob>) {
        this.types = Object.keys(data);
        items.push(this);
      }
    };
    Object.defineProperty(navigator, 'clipboard', { value: { write, writeText: jest.fn() }, configurable: true });

    render(<SendPreview submissionId="sub-1" />);
    await screen.findByTitle('Email preview');
    await act(async () => {
      fireEvent.click(screen.getByText('Copy to Clipboard'));
    });

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(items).toHaveLength(1);
    expect(items[0].types).toEqual(['text/html', 'text/plain']);
    expect(items[0].data['text/html'].type).toBe('text/html');
    expect(items[0].data['text/plain'].type).toBe('text/plain');
    expect(await screen.findByText('Copied!')).toBeInTheDocument();
    delete (global as any).ClipboardItem;
  });
});

describe('handleFrameClick', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function clickOn(html: string): { event: MouseEvent; open: jest.SpyInstance } {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    document.body.innerHTML = html;
    const target = document.querySelector('[data-click]') as Element;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    handleFrameClick(event);
    return { event, open };
  }

  it('opens http(s) and mailto links in a new tab and never navigates the frame', () => {
    const { event, open } = clickOn('<a href="https://example.org/faq"><strong data-click>FAQ</strong></a>');
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.org/faq', '_blank', 'noopener,noreferrer');

    const mail = clickOn('<a data-click href="mailto:a@example.org">mail</a>');
    expect(mail.open).toHaveBeenCalledWith('mailto:a@example.org', '_blank', 'noopener,noreferrer');
  });

  it('ignores other links', () => {
    const { event, open } = clickOn('<a data-click href="javascript:alert(1)">x</a>');
    expect(event.defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('copyEmailToClipboard', () => {
  afterEach(() => {
    delete (global as any).ClipboardItem;
  });

  it('falls back to plain text without ClipboardItem', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await copyEmailToClipboard({ html: '<p>x</p>', text: 'x' });
    expect(writeText).toHaveBeenCalledWith('x');
  });
});
