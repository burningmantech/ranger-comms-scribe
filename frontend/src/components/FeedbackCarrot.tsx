import React, { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '../config';
import { collectDiagnostics, rawFetch, redactUrl } from '../utils/diagnostics';
import { captureScreenshot } from '../utils/screenshot';
import './FeedbackCarrot.css';

const authHeaders = (json = false): HeadersInit => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  Authorization: `Bearer ${localStorage.getItem('sessionId') || ''}`,
});

/** Whether the signed-in person gets the feedback tab (GET /feedback/config), read again when the tab regains focus. */
function useFeedbackEnabled(signedInAs: string | null): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!signedInAs) {
      setEnabled(false);
      return;
    }
    let cancelled = false;
    const check = () => {
      rawFetch(`${API_URL}/feedback/config`, { headers: authHeaders() })
        .then((res) => (res.ok ? res.json() : { enabled: false }))
        .then((body) => !cancelled && setEnabled(body?.enabled === true))
        .catch(() => {});
    };
    const onVisible = () => document.visibilityState === 'visible' && check();
    check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [signedInAs]);
  return enabled;
}

type Phase = 'closed' | 'capturing' | 'open' | 'sending' | 'sent';

/**
 * The feedback tab on the right edge: opens a small panel to say what happened. Sends the
 * message with a screenshot of the page and what the browser collected (utils/diagnostics.ts)
 * to the Admins. Admins turn it on for everyone or for one person (Admin → Feedback, People).
 */
export const FeedbackCarrot: React.FC<{ signedInAs: string | null }> = ({ signedInAs }) => {
  const enabled = useFeedbackEnabled(signedInAs);
  const [phase, setPhase] = useState<Phase>('closed');
  const [message, setMessage] = useState('');
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const carrotRef = useRef<HTMLButtonElement>(null);

  const [retaking, setRetaking] = useState(false);

  // The tab and panel are marked data-feedback-ignore, so they never appear in the screenshot
  const open = useCallback(async () => {
    setPhase('capturing');
    setScreenshot(await captureScreenshot());
    setIncludeScreenshot(true);
    setPhase('open');
  }, []);

  const retake = useCallback(async () => {
    setRetaking(true);
    setScreenshot(await captureScreenshot());
    setRetaking(false);
  }, []);

  const close = useCallback(() => {
    setPhase((p) => (p === 'sending' ? p : 'closed'));
    setPreview(false);
    carrotRef.current?.focus();
  }, []);

  useEffect(() => {
    if (phase === 'open') textRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (phase === 'closed' || phase === 'capturing') return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [phase, close]);

  const send = async () => {
    if (!message.trim() || phase === 'sending') return;
    setPhase('sending');
    setError(null);
    try {
      const response = await rawFetch(`${API_URL}/feedback`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          message: message.trim(),
          url: redactUrl(window.location.href),
          screenshot: includeScreenshot ? screenshot : null,
          diagnostics: collectDiagnostics(),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || `Could not send (${response.status})`);
      }
      setPhase('sent');
      setMessage('');
      setScreenshot(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send');
      setPhase('open');
    }
  };

  if (!enabled) return null;
  const isOpen = phase === 'open' || phase === 'sending' || phase === 'sent';

  return (
    <div className={`feedback-carrot ${isOpen ? 'is-open' : ''}`} data-feedback-ignore="">
      <button
        ref={carrotRef}
        type="button"
        className="feedback-tab"
        aria-label={isOpen ? 'Close feedback' : 'Send feedback'}
        aria-expanded={isOpen}
        aria-controls="feedback-panel"
        title={isOpen ? 'Close feedback' : 'Send feedback'}
        disabled={phase === 'capturing'}
        onClick={() => (isOpen ? close() : open())}
      >
        {phase === 'capturing'
          ? <i className="fas fa-circle-notch fa-spin" aria-hidden="true" />
          : <i className={`fas ${isOpen ? 'fa-chevron-right' : 'fa-chevron-left'}`} aria-hidden="true" />}
      </button>

      {isOpen && (
        <section id="feedback-panel" className="feedback-panel" role="dialog" aria-label="Send feedback">
          <header className="feedback-head">
            <h2>Send feedback</h2>
            <button type="button" className="feedback-close" onClick={close} aria-label="Close">
              <i className="fas fa-times" aria-hidden="true" />
            </button>
          </header>

          {phase === 'sent' ? (
            <div className="feedback-sent" role="status">
              <i className="fas fa-check-circle" aria-hidden="true" />
              <p><strong>Thank you!</strong> Your feedback went to the Scribe Admins.</p>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setPhase('closed')}>Close</button>
            </div>
          ) : (
            <div className="feedback-body">
              <label htmlFor="feedback-message">What happened? What did you expect?</label>
              <textarea
                id="feedback-message"
                ref={textRef}
                rows={5}
                value={message}
                maxLength={5000}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
                }}
                placeholder="I clicked Save and…"
              />

              <div className="feedback-shot">
                {screenshot ? (
                  <>
                    <img src={screenshot} alt="Screenshot of the page" className={includeScreenshot ? '' : 'excluded'} />
                    <div className="feedback-shot-controls">
                      <label>
                        <input type="checkbox" checked={includeScreenshot} onChange={(e) => setIncludeScreenshot(e.target.checked)} /> Include screenshot
                      </label>
                      <button type="button" className="feedback-link" onClick={retake} disabled={retaking || phase === 'sending'}>{retaking ? 'Taking…' : 'Retake'}</button>
                    </div>
                  </>
                ) : (
                  <div className="feedback-noshot">
                    No screenshot (the page couldn't be drawn).{' '}
                    <button type="button" className="feedback-link" onClick={retake} disabled={retaking || phase === 'sending'}>{retaking ? 'Trying…' : 'Try again'}</button>
                  </div>
                )}
              </div>

              <details className="feedback-included" onToggle={(e) => setPreview((e.target as HTMLDetailsElement).open)}>
                <summary>What's sent with it</summary>
                <ul>
                  <li>{screenshot && includeScreenshot ? 'The screenshot above' : 'No screenshot'}</li>
                  <li>This page's address and your browser and window size</li>
                  <li>Recent requests to Scribe, with where in the app each was made</li>
                  <li>Recent errors and console messages, and the steps you took (pages, buttons; never what you typed)</li>
                </ul>
                {preview && <FeedbackPreview />}
              </details>

              {error && <div className="feedback-error" role="alert">{error}</div>}

              <button type="button" className="btn btn-primary feedback-send" onClick={send} disabled={!message.trim() || phase === 'sending'}>
                {phase === 'sending' ? <><i className="fas fa-circle-notch fa-spin" aria-hidden="true" /> Sending…</> : <><i className="fas fa-paper-plane" aria-hidden="true" /> Send to the Admins</>}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
};

/** The counts of what would be sent right now. */
const FeedbackPreview: React.FC = () => {
  const d = collectDiagnostics();
  const failed = d.network.filter((n) => n.error || (n.status !== undefined && n.status >= 400)).length;
  return (
    <p className="feedback-counts">
      {d.network.length} requests ({failed} failed), {d.errors.length} errors, {d.console.length} console messages, {d.breadcrumbs.length} steps.
    </p>
  );
};

export default FeedbackCarrot;
