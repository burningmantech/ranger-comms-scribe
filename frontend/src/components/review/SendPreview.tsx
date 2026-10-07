import React, { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '../../config';

/**
 * The announcement email exactly as the backend would send it
 * (GET /content/submissions/:id/email-preview, built by the same code as send-email).
 */
export interface EmailPreview {
  subject: string;
  /** The recipient (ANNOUNCE_EMAIL_TO), or null when sending isn't configured. */
  to: string | null;
  replyTo: string | null;
  /** The approved Reply-To when it isn't a valid address (left out of the email). */
  replyToInvalid?: string;
  /** The approved Audience (labels, comma separated). */
  audience: string;
  signature: string;
  html: string;
  text: string;
  /** A sent announcement can be sent again here (dev only). */
  resendAllowed?: boolean;
  /** The mailing lists it can go to (Requests → Settings), Ranger Announce first. */
  lists?: Array<{ id: string; name: string; address: string; builtIn?: boolean }>;
  /** The lists its audience suggests (ticked to start with). */
  suggestedListIds?: string[];
  /** Where it went, once sent. */
  sentTo?: Array<{ id: string; name: string; address: string }>;
  /** On dev and staging every list send goes to this address instead. */
  redirectedTo?: string | null;
}

export async function fetchEmailPreview(submissionId: string, signal?: AbortSignal): Promise<EmailPreview> {
  const sessionId = localStorage.getItem('sessionId');
  const response = await fetch(`${API_URL}/content/submissions/${encodeURIComponent(submissionId)}/email-preview`, {
    headers: sessionId ? { Authorization: `Bearer ${sessionId}` } : {},
    signal,
  });
  if (!response.ok) {
    let message = `Could not load the email preview (${response.status})`;
    try {
      const body = await response.json();
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  return response.json();
}

function copyWithTextarea(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

/**
 * Copy the email as rich HTML (pastes formatted, with images, into a mail client) plus a
 * plain-text alternative. Falls back to plain text where ClipboardItem isn't supported.
 */
export async function copyEmailToClipboard(preview: Pick<EmailPreview, 'html' | 'text'>): Promise<void> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard && typeof clipboard.write === 'function' && typeof ClipboardItem !== 'undefined') {
    try {
      await clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([preview.html], { type: 'text/html' }),
          'text/plain': new Blob([preview.text], { type: 'text/plain' }),
        }),
      ]);
      return;
    } catch {
      // Fall through to plain text (e.g. the browser refused rich clipboard content)
    }
  }
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(preview.text);
      return;
    } catch {
      // Fall through to the textarea copy
    }
  }
  copyWithTextarea(preview.text);
}

const OPENABLE_LINK = /^(https?:|mailto:)/i;

/**
 * A click on a link in the preview frame: open http(s)/mailto links in a new tab from this
 * page (the frame can't open windows or run scripts), and never navigate the frame.
 */
export function handleFrameClick(event: MouseEvent): void {
  const target = event.target as Element | null;
  const anchor = target && typeof target.closest === 'function' ? target.closest('a') : null;
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute('href') || '';
  if (OPENABLE_LINK.test(href.trim())) {
    window.open(href.trim(), '_blank', 'noopener,noreferrer');
  }
}

export interface SendPreviewProps {
  submissionId: string;
  /** Changes when the submission changes, to refetch the preview. */
  refreshKey?: string;
  /** Actions next to Copy to Clipboard (Send, sent state, errors), given the loaded preview. */
  renderActions?: (preview: EmailPreview | null, listIds: string[]) => React.ReactNode;
}

/**
 * The review page's Send view: the email's header (To, Audience, Reply-To, Subject) and its
 * HTML body in a sandboxed frame (no scripts), loaded from the backend so it is exactly what
 * Send Email sends.
 */
export function SendPreview({ submissionId, refreshKey, renderActions }: SendPreviewProps) {
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [frameHeight, setFrameHeight] = useState(480);
  const [listIds, setListIds] = useState<string[]>([]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchEmailPreview(submissionId, controller.signal)
      .then((loaded) => {
        setPreview(loaded);
        setListIds(loaded.suggestedListIds || []);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Could not load the email preview');
        setLoading(false);
      });
    return () => controller.abort();
  }, [submissionId, refreshKey]);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  // Size the frame to its content and handle its link clicks. This page can reach the
  // frame's document because the sandbox allows same-origin; the frame itself can't run
  // scripts or open windows.
  const onFrameLoad = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    doc.addEventListener('click', handleFrameClick);
    const height = doc.documentElement?.scrollHeight || doc.body?.scrollHeight;
    if (height && height > 0) setFrameHeight(height + 8);
  }, []);

  const handleCopy = async () => {
    if (!preview) return;
    try {
      await copyEmailToClipboard(preview);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to the clipboard');
    }
  };

  return (
    <div className="send-mode-preview">
      <div className="send-mode-email">
        {loading && !preview && <div className="send-mode-note">Loading the email preview…</div>}
        {preview && (
          <>
            <div className="send-mode-field">
              <span className="send-mode-label">To:</span>
              <span className="send-mode-value" data-testid="send-preview-to">
                {!preview.to
                  ? 'Not configured (ANNOUNCE_EMAIL_TO is not set)'
                  : preview.sentTo && preview.sentTo.length > 0 && !preview.resendAllowed
                    ? preview.sentTo.map((l) => `${l.name} <${l.address}>`).join(', ')
                    : !preview.lists || preview.lists.length === 0
                      ? preview.to
                      : (
                      <span className="send-mode-lists" role="group" aria-label="Send to">
                        {(preview.lists || []).map((l) => (
                          <label key={l.id} className="send-mode-list">
                            <input
                              type="checkbox"
                              checked={listIds.includes(l.id)}
                              onChange={(e) => setListIds((ids) => (e.target.checked ? [...ids, l.id] : ids.filter((x) => x !== l.id)))}
                            />
                            <span><strong>{l.name}</strong> <span className="send-mode-list-address">{l.address}</span></span>
                          </label>
                        ))}
                        {preview.redirectedTo && (
                          <span className="send-mode-note">On this site, list emails go to {preview.redirectedTo} instead.</span>
                        )}
                      </span>
                    )}
              </span>
            </div>
            {preview.audience && (
              <div className="send-mode-field">
                <span className="send-mode-label">Audience:</span>
                <span className="send-mode-value">{preview.audience}</span>
              </div>
            )}
            {(preview.replyTo || preview.replyToInvalid) && (
              <div className="send-mode-field">
                <span className="send-mode-label">Reply-To:</span>
                <span className="send-mode-value" data-testid="send-preview-reply-to">
                  {preview.replyTo || (
                    <span className="send-mode-error">
                      {preview.replyToInvalid} is not an email address and will be left out
                    </span>
                  )}
                </span>
              </div>
            )}
            <div className="send-mode-field">
              <span className="send-mode-label">Subject:</span>
              <span className="send-mode-value" data-testid="send-preview-subject">{preview.subject}</span>
            </div>
            <div className="send-mode-divider" />
            <iframe
              ref={frameRef}
              className="send-mode-frame"
              title="Email preview"
              // No allow-scripts and no popups: the email can't run code or open windows.
              // allow-same-origin only lets this page size the frame and handle link clicks.
              sandbox="allow-same-origin"
              srcDoc={preview.html}
              onLoad={onFrameLoad}
              style={{ height: frameHeight }}
            />
          </>
        )}
        {error && (
          <div className="send-mode-error" role="alert">
            <i className="fas fa-exclamation-circle" style={{ marginRight: '4px' }} />
            {error}
          </div>
        )}
      </div>

      <div className="send-mode-actions">
        <button className="btn btn-neutral" onClick={handleCopy} disabled={!preview}>
          <i className={`fas ${copied ? 'fa-check' : 'fa-copy'}`} style={{ marginRight: '6px' }} />
          {copied ? 'Copied!' : 'Copy to Clipboard'}
        </button>
        {renderActions && renderActions(preview, listIds)}
      </div>
    </div>
  );
}

export default SendPreview;
