import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { API_URL } from '../config';
import './FeedbackAdmin.css';

/** A report as GET /api/admin/feedback lists it (without the diagnostics). */
interface FeedbackSummary {
  id: string;
  createdAt: string;
  user: { id: string; email: string; name: string };
  message: string;
  url: string;
  hasScreenshot: boolean;
  handled: boolean;
  handledBy?: string;
  handledAt?: string;
  notes?: string;
  emailedTo: string[];
  emailError?: string;
  counts: { network: number; failed: number; errors: number };
}

/** One report, with what the browser collected (frontend/src/utils/diagnostics.ts). */
interface FeedbackReport extends Omit<FeedbackSummary, 'counts'> {
  diagnostics: Record<string, any>;
}

type Show = 'open' | 'handled' | 'all';

const authHeaders = (json = false): HeadersInit => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  Authorization: `Bearer ${localStorage.getItem('sessionId') || ''}`,
});

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '');
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString() : '');
const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
/** The page's address as a link, only if it is http(s) (the browser sent it, so it isn't trusted). */
const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? url : undefined);
const pathOf = (url: string) => {
  try {
    const u = new URL(url, window.location.origin);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

/** The global switch for the feedback tab. */
function GlobalSwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/admin/feedback/settings`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the setting'))))
      .then((body) => setEnabled(body.settings.enabled === true))
      .catch((err) => setError(err.message));
  }, []);

  const change = async (next: boolean) => {
    const before = enabled;
    setEnabled(next);
    setError(null);
    const response = await fetch(`${API_URL}/admin/feedback/settings`, { method: 'PUT', headers: authHeaders(true), body: JSON.stringify({ enabled: next }) }).catch(() => null);
    if (!response?.ok) {
      setEnabled(before);
      setError('Could not save');
    }
  };

  return (
    <div className="feedback-switch">
      <label className="people-switch">
        <input type="checkbox" checked={enabled === true} disabled={enabled === null} onChange={(e) => change(e.target.checked)} aria-label="Feedback tab for everyone" />
        <span><strong>Feedback tab for everyone</strong>: {enabled === null ? '…' : enabled ? 'On' : 'Off'}</span>
      </label>
      <p className="admin-hint">
        The tab sits on the right edge of every page. When this is on, everyone signed in sees it. When it is off, only people set to On
        on the People tab see it. A person set to On or Off on the People tab keeps that whatever this switch says (for example, on for
        a tester while it's off for everyone).
      </p>
      {error && <div className="error-message" role="alert">{error}</div>}
    </div>
  );
}

/** A screenshot fetched with the session (an <img src> can't send it). */
function Screenshot({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    fetch(`${API_URL}/admin/feedback/${id}/screenshot`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('no screenshot'))))
      .then((blob) => {
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => setFailed(true));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  if (failed) return <p className="admin-hint">The screenshot couldn't be loaded.</p>;
  if (!src) return <p className="admin-hint">Loading the screenshot…</p>;
  return (
    <a href={src} target="_blank" rel="noreferrer" title="Open full size">
      <img className="feedback-admin-shot" src={src} alt="What the person saw" />
    </a>
  );
}

function Section({ title, count, open, children }: { title: string; count?: number; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="feedback-section" open={open}>
      <summary>{title}{count !== undefined && <span className="people-count">{count}</span>}</summary>
      <div className="feedback-section-body">{children}</div>
    </details>
  );
}

const isFailed = (n: any) => !!n?.error || (typeof n?.status === 'number' && n.status >= 400);

/** One report: the message, the screenshot and everything collected. */
function FeedbackDetail({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: (report: FeedbackReport | null) => void }) {
  const [report, setReport] = useState<FeedbackReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setReport(null);
    fetch(`${API_URL}/admin/feedback/${id}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? 'That feedback was deleted' : 'Could not load it'))))
      .then((body) => {
        setReport(body.feedback);
        setNotes(body.feedback.notes || '');
      })
      .catch((err) => setError(err.message));
  }, [id]);

  const update = async (patch: { handled?: boolean; notes?: string }) => {
    const response = await fetch(`${API_URL}/admin/feedback/${id}`, { method: 'PUT', headers: authHeaders(true), body: JSON.stringify(patch) }).catch(() => null);
    if (!response?.ok) {
      setError('Could not save');
      return;
    }
    const updated = (await response.json()).feedback as FeedbackReport;
    setReport(updated);
    onChanged(updated);
  };

  const remove = async () => {
    const response = await fetch(`${API_URL}/admin/feedback/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => null);
    if (response?.ok) {
      onChanged(null);
      onBack();
    } else {
      setError('Could not delete');
    }
  };

  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `feedback-${report.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (error && !report) {
    return <div><button type="button" className="feedback-link" onClick={onBack}>← All feedback</button><div className="error-message" role="alert">{error}</div></div>;
  }
  if (!report) return <p className="admin-hint">Loading…</p>;

  const d = report.diagnostics || {};
  const network = list(d.network);
  const errors = list(d.errors);
  const consoleEntries = list(d.console);
  const steps = list(d.breadcrumbs);
  const viewport = d.environment?.viewport || {};

  return (
    <div className="feedback-detail">
      <button type="button" className="feedback-link" onClick={onBack}>← All feedback</button>
      <div className="feedback-detail-head">
        <div>
          <h3>{report.user.name} <a href={`mailto:${report.user.email}`} className="feedback-email">{report.user.email}</a></h3>
          <div className="admin-hint">{when(report.createdAt)} · <a href={safeHref(report.url)} target="_blank" rel="noreferrer">{pathOf(report.url)}</a></div>
        </div>
        <div className="feedback-detail-actions">
          <label className="people-switch">
            <input type="checkbox" checked={report.handled} onChange={(e) => update({ handled: e.target.checked })} />
            <span>Handled{report.handled && report.handledBy ? ` by ${report.handledBy}` : ''}</span>
          </label>
          <button type="button" className="btn btn-neutral btn-sm" onClick={download}><i className="fas fa-download" aria-hidden="true" /> JSON</button>
          {confirmDelete ? (
            <span className="people-confirm">
              Delete?
              <button type="button" className="btn btn-danger btn-sm" onClick={remove}>Delete</button>
              <button type="button" className="btn btn-neutral btn-sm" onClick={() => setConfirmDelete(false)}>Keep</button>
            </span>
          ) : (
            <button type="button" className="people-delete" onClick={() => setConfirmDelete(true)} aria-label="Delete this feedback" title="Delete">
              <i className="fas fa-trash" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {error && <div className="error-message" role="alert">{error}</div>}

      <blockquote className="feedback-message">{report.message}</blockquote>
      <textarea
        className="feedback-notes"
        rows={2}
        placeholder="Notes (only Admins see these)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => notes !== (report.notes || '') && update({ notes })}
        aria-label="Notes"
      />
      {report.emailError && <p className="admin-hint">Not emailed: {report.emailError}</p>}

      {report.hasScreenshot ? <Screenshot id={report.id} /> : <p className="admin-hint">No screenshot was sent.</p>}

      <table className="feedback-facts">
        <tbody>
          <tr><th>Browser</th><td>{d.environment?.userAgent}</td></tr>
          <tr><th>Window</th><td>{viewport.width ? `${viewport.width}×${viewport.height} @${viewport.devicePixelRatio}x` : ''}{d.environment?.online === false ? ' · offline' : ''}</td></tr>
          <tr><th>Time zone</th><td>{d.environment?.timezone}</td></tr>
          <tr><th>Build</th><td>{d.app?.build} {d.app?.upForSeconds !== undefined && <span className="admin-hint">(page open {Math.round(d.app.upForSeconds / 60)} min)</span>}</td></tr>
          {list(d.visibleAlerts).length > 0 && <tr><th>On screen</th><td>{list(d.visibleAlerts).map((a, i) => <div key={i} className="feedback-alert">{a}</div>)}</td></tr>}
        </tbody>
      </table>

      <Section title="Errors" count={errors.length} open={errors.length > 0}>
        {errors.length === 0 ? <p className="admin-hint">None.</p> : errors.slice().reverse().map((e, i) => (
          <div key={i} className="feedback-error-entry">
            <div><span className="feedback-time">{time(e.at)}</span> <strong>{e.message}</strong> <span className="admin-hint">{e.kind}{e.source ? ` · ${e.source}` : ''}</span></div>
            {e.stack && <pre>{e.stack}</pre>}
          </div>
        ))}
      </Section>

      <Section title="Network" count={network.length} open={network.some(isFailed)}>
        <table className="feedback-network">
          <thead><tr><th>Time</th><th>Request</th><th>Status</th><th>ms</th></tr></thead>
          <tbody>
            {network.slice().reverse().map((n, i) => (
              <tr key={i} className={isFailed(n) ? 'failed' : ''}>
                <td className="feedback-time">{time(n.at)}</td>
                <td>
                  <details>
                    <summary><code>{n.method} {pathOf(n.url)}</code></summary>
                    {n.responsePreview && <><div className="admin-hint">Response</div><pre>{n.responsePreview}</pre></>}
                    {n.initiator && <><div className="admin-hint">Called from</div><pre>{n.initiator}</pre></>}
                  </details>
                </td>
                <td>{n.error || n.status || '…'}</td>
                <td>{n.durationMs ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Steps" count={steps.length}>
        <ol className="feedback-steps">
          {steps.map((s, i) => <li key={i}><span className="feedback-time">{time(s.at)}</span> {s.kind === 'navigation' ? '→ ' : 'Clicked '}<code>{s.detail}</code></li>)}
        </ol>
      </Section>

      <Section title="Console" count={consoleEntries.length}>
        {consoleEntries.slice().reverse().map((c, i) => (
          <pre key={i} className={`feedback-console ${c.level}`}><span className="feedback-time">{time(c.at)}</span> [{c.level}] {c.message}</pre>
        ))}
      </Section>

      <Section title="Connections" count={list(d.websockets).length}>
        <pre>{JSON.stringify(d.websockets, null, 2)}</pre>
      </Section>

      <Section title="Slow or failed resources" count={list(d.resources).length}>
        <pre>{JSON.stringify(d.resources, null, 2)}</pre>
      </Section>

      <Section title="Browser, page and person">
        <pre>{JSON.stringify({ page: d.page, environment: d.environment, app: d.app, user: d.user, permissions: d.permissions }, null, 2)}</pre>
      </Section>
    </div>
  );
}

/** Admin → Feedback: the global switch and the feedback received. */
export const FeedbackAdmin: React.FC<{ selectedId: string | null; onSelect: (id: string | null) => void }> = ({ selectedId, onSelect }) => {
  const [reports, setReports] = useState<FeedbackSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Show>('open');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/admin/feedback`, { headers: authHeaders() });
      if (!response.ok) throw new Error('Could not load feedback');
      setReports((await response.json()).feedback || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load feedback');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () => (reports || []).filter((r) => (show === 'all' ? true : show === 'handled' ? r.handled : !r.handled)),
    [reports, show],
  );

  const changed = (id: string, report: FeedbackReport | null) => {
    setReports((all) => {
      if (!all) return all;
      if (!report) return all.filter((r) => r.id !== id);
      return all.map((r) => (r.id === id ? { ...r, handled: report.handled, handledBy: report.handledBy, notes: report.notes } : r));
    });
  };

  return (
    <div className="admin-section feedback-admin">
      <h2>Feedback</h2>
      <GlobalSwitch />

      {selectedId ? (
        <FeedbackDetail id={selectedId} onBack={() => onSelect(null)} onChanged={(report) => changed(selectedId, report)} />
      ) : (
        <>
          <div className="people-toolbar">
            <div className="people-filters" role="group" aria-label="Show">
              {(['open', 'handled', 'all'] as Show[]).map((s) => (
                <button key={s} type="button" className={`people-filter ${show === s ? 'active' : ''}`} aria-pressed={show === s} onClick={() => setShow(s)}>
                  {s === 'open' ? 'To look at' : s === 'handled' ? 'Handled' : 'All'}{' '}
                  <span className="people-count">{(reports || []).filter((r) => (s === 'all' ? true : s === 'handled' ? r.handled : !r.handled)).length}</span>
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-neutral btn-sm" onClick={load}><i className="fas fa-sync-alt" aria-hidden="true" /> Refresh</button>
          </div>
          {error && <div className="error-message" role="alert">{error}</div>}
          {!reports && !error && <p className="admin-hint">Loading…</p>}
          {reports && shown.length === 0 && <p className="admin-hint">Nothing here.</p>}
          {shown.length > 0 && (
            <ul className="feedback-list">
              {shown.map((r) => (
                <li key={r.id}>
                  <button type="button" className={`feedback-row ${r.handled ? 'handled' : ''}`} onClick={() => onSelect(r.id)}>
                    <span className="feedback-row-head">
                      <strong>{r.user.name}</strong>
                      <span className="admin-hint">{when(r.createdAt)} · {pathOf(r.url)}</span>
                    </span>
                    <span className="feedback-row-message">{r.message.length > 200 ? `${r.message.slice(0, 200)}…` : r.message}</span>
                    <span className="feedback-row-tags">
                      {r.hasScreenshot && <span className="feedback-tag"><i className="fas fa-image" aria-hidden="true" /> Screenshot</span>}
                      {r.counts.failed > 0 && <span className="feedback-tag bad">{r.counts.failed} failed {r.counts.failed === 1 ? 'request' : 'requests'}</span>}
                      {r.counts.errors > 0 && <span className="feedback-tag bad">{r.counts.errors} {r.counts.errors === 1 ? 'error' : 'errors'}</span>}
                      {r.handled && <span className="feedback-tag">Handled</span>}
                      {r.notes && <span className="feedback-tag">Notes</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
};

export default FeedbackAdmin;
