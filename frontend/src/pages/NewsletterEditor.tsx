import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { API_URL } from '../config';
import RichTextField from '../components/newsletter/RichTextField';
import { EditionPatch, NewsletterApiError, newsletterService } from '../services/newsletterService';
import {
  CalendarRow,
  EditionPreview,
  EditionView,
  KeyDate,
  NewsletterEdition,
  NewsletterLink,
  NewsletterReadMore,
  NewsletterSection,
} from '../types/newsletter';
import SectionCard, { DocumentOption } from '../components/newsletter/SectionCard';
import CalendarEditor from '../components/newsletter/CalendarEditor';
import TrayPanel from '../components/newsletter/TrayPanel';
import HtmlFrame from '../components/newsletter/HtmlFrame';
import { isWebUrl } from '../components/newsletter/urls';
import { STATUS_LABELS } from './NewsletterEditions';
import { canEditNewsletter, storedUser } from '../utils/newsletterAccess';
import '../components/newsletter/newsletter.css';
import './NewsletterEditor.css';

const AUTOSAVE_MS = 1500;

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
type SideTab = 'preview' | 'tray' | 'activity';

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

// ---------------------------------------------------------------------------
// What autosave sends: complete rows only. Half-filled rows (a new date, a link being typed)
// stay in the page and go out once they're complete.
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function completeKeyDates(dates: KeyDate[]): KeyDate[] {
  return dates
    .filter((d) => ISO_DATE.test(d.date) && d.label.trim() && (!d.endDate || (ISO_DATE.test(d.endDate) && d.endDate >= d.date)))
    .map((d) => ({
      date: d.date,
      label: d.label.trim(),
      ...(d.endDate && d.endDate !== d.date ? { endDate: d.endDate } : {}),
      ...(d.link && isWebUrl(d.link) ? { link: d.link.trim(), ...(d.linkLabel?.trim() ? { linkLabel: d.linkLabel.trim() } : {}) } : {}),
      ...(d.annualDateId ? { annualDateId: d.annualDateId } : {}),
    }));
}

function completeLinks(links: NewsletterLink[]): NewsletterLink[] {
  return links.filter((l) => isWebUrl(l.url)).map((l) => ({ label: l.label.trim() || l.url.trim(), url: l.url.trim() }));
}

function completeReadMore(r: NewsletterReadMore): NewsletterReadMore {
  if (r.kind === 'url') return isWebUrl(r.url || '') ? { kind: 'url', url: r.url!.trim(), ...(r.label?.trim() ? { label: r.label.trim() } : {}) } : { kind: 'none' };
  if (r.kind === 'document') return r.submissionId ? { kind: 'document', submissionId: r.submissionId, ...(r.label?.trim() ? { label: r.label.trim() } : {}) } : { kind: 'none' };
  return { kind: 'none' };
}

function savePayload(edition: NewsletterEdition): EditionPatch {
  const replyTo = (edition.replyTo || '').trim();
  return {
    ...(Number.isInteger(edition.number) && edition.number > 0 ? { number: edition.number } : {}),
    title: edition.title,
    tagline: edition.tagline,
    subject: edition.subject,
    intro: edition.intro || '',
    footnotes: edition.footnotes || '',
    ...(replyTo === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo) || /<[^\s@]+@[^\s@]+>$/.test(replyTo) ? { replyTo } : {}),
    sections: edition.sections.map((s) => ({
      ...s,
      photos: s.photos.filter((p) => p.src),
      links: completeLinks(s.links),
      readMore: completeReadMore(s.readMore),
      keyDates: completeKeyDates(s.keyDates),
    })),
    calendar: edition.calendar
      .map((row) => ({ id: row.id, ...(completeKeyDates([row])[0] || {}) }))
      .filter((row): row is CalendarRow => 'date' in row),
    calendarHidden: edition.calendarHidden,
  };
}

// ---------------------------------------------------------------------------

function ApprovalSummary({ view }: { view: EditionView }) {
  const { approval, edition } = view;
  if (edition.status === 'sent') return null;
  return (
    <div className="nle-gates" aria-label="Approvals">
      <span className={`nle-gate ${approval.commsCadre.met || approval.override ? 'met' : ''}`}>
        <i className={`fas ${approval.commsCadre.met || approval.override ? 'fa-check-circle' : 'fa-circle'}`} aria-hidden="true" />
        Comms Cadre{approval.commsCadre.by ? `: ${approval.commsCadre.by}` : ''}
      </span>
      <span
        className={`nle-gate ${approval.commsManager.met || approval.override ? 'met' : ''} ${!approval.commsManager.met && !approval.override && view.commsManagers.length === 0 ? 'rejected' : ''}`}
        title={view.commsManagers.length ? `Communications Manager: ${view.commsManagers.map((m) => m.name).join(', ')}` : 'Nobody is set up as the Communications Manager (Admin → Council)'}
      >
        <i className={`fas ${approval.commsManager.met || approval.override ? 'fa-check-circle' : 'fa-circle'}`} aria-hidden="true" />
        Communications Manager{approval.commsManager.by
          ? `: ${approval.commsManager.by}`
          : approval.override ? '' : view.commsManagers.length
            ? ` (waiting for ${view.commsManagers.map((m) => m.name).join(' or ')})`
            : ': nobody is set up (Admin → Council), or an Admin can override'}
      </span>
      {approval.override && <span className="nle-gate met">Override: {edition.approvalOverride?.byName}</span>}
      {approval.rejectedBy.length > 0 && (
        <span className="nle-gate rejected"><i className="fas fa-exclamation-circle" aria-hidden="true" /> Changes requested by {approval.rejectedBy.join(', ')}</span>
      )}
    </div>
  );
}

function ActivityPanel({ view, onComment, busy }: { view: EditionView; onComment: (text: string) => Promise<void>; busy: boolean }) {
  const [text, setText] = useState('');
  const { edition } = view;
  const items = [
    ...edition.approvals.map((a) => ({
      at: a.createdAt,
      key: `a-${a.id}`,
      node: (
        <>
          <strong>{a.approverName || a.approverEmail}</strong> {a.status === 'approved' ? 'approved' : 'asked for changes'} version {a.version}
          {a.version !== edition.version && edition.status !== 'sent' && <span className="nle-muted"> (since edited)</span>}
        </>
      ),
    })),
    ...edition.comments.map((c) => ({
      at: c.createdAt,
      key: `c-${c.id}`,
      node: (<><strong>{c.authorName}</strong>: {c.content}</>),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="nle-activity">
      {edition.status !== 'sent' && (
        <form
          className="nle-comment-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            await onComment(text.trim());
            setText('');
          }}
        >
          <label htmlFor="nle-comment" className="visually-hidden">Comment</label>
          <textarea id="nle-comment" className="form-control" rows={2} value={text} placeholder="Comment for the other editors and approvers" onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !text.trim()}>Comment</button>
        </form>
      )}
      {items.length === 0 ? <p className="nle-muted">No approvals or comments yet.</p> : (
        <ul className="nle-activity-list">
          {items.map((i) => (
            <li key={i.key}>
              <div>{i.node}</div>
              <div className="nle-activity-time">{new Date(i.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Build, approve and send one newsletter edition (/newsletter/editions/:id). */
export const NewsletterEditor: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const user = storedUser();
  const userId = user?.id || user?.email || '';
  const uploader = user?.name || user?.email || '';

  const [view, setView] = useState<EditionView | null>(null);
  const [draft, setDraft] = useState<NewsletterEdition | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<NewsletterEdition | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [sideTab, setSideTab] = useState<SideTab>('preview');
  const [preview, setPreview] = useState<EditionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [dialog, setDialog] = useState<null | 'send' | 'changes' | 'override'>(null);
  const [dialogText, setDialogText] = useState('');
  const [documentOptions, setDocumentOptions] = useState<DocumentOption[] | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const draftRef = useRef<NewsletterEdition | null>(null);
  const versionRef = useRef(0);
  const editSeq = useRef(0);
  const savedSeq = useRef(0);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false); // a conflict stops autosave until it is resolved
  // Only the Comms Cadre and Admins edit (the server says, once loaded); others see it read-only
  const canEditRef = useRef(canEditNewsletter(user));

  /** Take the server's edition (after load or an action); `remount` refreshes the rich text editors. */
  const applyView = useCallback((next: EditionView, remount: boolean) => {
    setView(next);
    if (typeof next.permissions.canEdit === 'boolean') canEditRef.current = next.permissions.canEdit;
    versionRef.current = next.edition.version;
    if (remount || !draftRef.current) {
      draftRef.current = next.edition;
      setDraft(next.edition);
      savedSeq.current = editSeq.current;
      setSaveState('saved');
      setEditorKey((k) => k + 1);
    }
    setPreviewKey((k) => k + 1);
  }, []);

  useEffect(() => {
    newsletterService.getEdition(id)
      .then((v) => applyView(v, true))
      .catch((err) => setLoadError(err.message));
  }, [id, applyView]);

  // ---- Saving ----

  const save = useCallback(async (): Promise<void> => {
    if (saving.current) {
      await saving.current;
    }
    if (stopped.current || !draftRef.current || editSeq.current === savedSeq.current) return;
    const seq = editSeq.current;
    const run = (async () => {
      setSaveState('saving');
      try {
        const next = await newsletterService.updateEdition(id, versionRef.current, savePayload(draftRef.current!));
        setView(next);
        versionRef.current = next.edition.version;
        savedSeq.current = seq;
        setSaveError(null);
        setSaveState(editSeq.current === seq ? 'saved' : 'dirty');
        setPreviewKey((k) => k + 1);
      } catch (err) {
        if (err instanceof NewsletterApiError && err.status === 409 && err.body?.conflict) {
          stopped.current = true;
          setConflict(err.body.edition as NewsletterEdition);
          setSaveState('conflict');
        } else {
          setSaveError(err instanceof Error ? err.message : 'Could not save');
          setSaveState('error');
        }
      }
    })();
    saving.current = run;
    try {
      await run;
    } finally {
      if (saving.current === run) saving.current = null;
    }
  }, [id]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void save(); }, AUTOSAVE_MS);
  }, [save]);

  /** Save now (before an action that needs the latest version). */
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    await save();
    if (stopped.current) throw new Error('Resolve the conflict first');
    if (editSeq.current !== savedSeq.current) throw new Error(saveError || 'Your changes are not saved yet');
  }, [save, saveError]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Warn before leaving with unsaved edits
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (canEditRef.current && editSeq.current !== savedSeq.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const edit = useCallback((change: (d: NewsletterEdition) => NewsletterEdition) => {
    const current = draftRef.current;
    if (!current || !canEditRef.current) return;
    const next = change(current);
    draftRef.current = next;
    setDraft(next);
    editSeq.current += 1;
    setSaveState((s) => (s === 'conflict' ? s : 'dirty'));
    if (!stopped.current) schedule();
  }, [schedule]);

  const setField = <K extends keyof NewsletterEdition>(key: K, value: NewsletterEdition[K]) => edit((d) => ({ ...d, [key]: value }));
  const setSection = (index: number, section: NewsletterSection) => edit((d) => ({ ...d, sections: d.sections.map((s, i) => (i === index ? section : s)) }));

  // ---- Preview ----

  useEffect(() => {
    if (!view) return undefined;
    const controller = new AbortController();
    const t = setTimeout(() => {
      newsletterService.preview(id, controller.signal)
        .then((p) => { setPreview(p); setPreviewError(null); })
        .catch((err) => { if (!controller.signal.aborted) setPreviewError(err.message); });
    }, 300);
    return () => { clearTimeout(t); controller.abort(); };
  }, [id, previewKey]);

  // ---- Actions ----

  const act = async (name: string, work: () => Promise<EditionView | void>, options: { remount?: boolean; ok?: string } = {}) => {
    setBusy(name);
    setActionMessage(null);
    try {
      await flush();
      const result = await work();
      if (result) applyView(result, !!options.remount);
      if (options.ok) setActionMessage({ kind: 'ok', text: options.ok });
      return true;
    } catch (err) {
      setActionMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Something went wrong' });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const loadDocumentOptions = useCallback(() => {
    if (documentOptions) return;
    const sessionId = localStorage.getItem('sessionId');
    fetch(`${API_URL}/content/submissions`, { headers: sessionId ? { Authorization: `Bearer ${sessionId}` } : {} })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: any[]) => setDocumentOptions(
        (Array.isArray(list) ? list : [])
          .filter((s) => s && (s.status === 'approved' || s.status === 'sent'))
          .map((s) => ({ id: s.id, title: s.title, status: s.status }))
          .sort((a, b) => a.title.localeCompare(b.title)),
      ))
      .catch(() => setDocumentOptions([]));
  }, [documentOptions]);

  const resolveConflict = (keepMine: boolean) => {
    if (!conflict) return;
    stopped.current = false;
    versionRef.current = conflict.version;
    if (keepMine) {
      // Save this page's edition over theirs
      setConflict(null);
      editSeq.current += 1;
      void save();
    } else {
      setConflict(null);
      newsletterService.getEdition(id).then((v) => applyView(v, true)).catch((err) => setLoadError(err.message));
    }
  };

  /** Open a dialog fresh: no text, and no error from an earlier action. */
  const openDialog = (kind: 'send' | 'changes' | 'override') => {
    setDialogText('');
    setActionMessage((m) => (m?.kind === 'error' ? null : m));
    setDialog(kind);
  };

  /** Close the confirm dialog; an error it showed goes with it. */
  const closeDialog = () => {
    setDialog(null);
    setActionMessage((m) => (m?.kind === 'error' ? null : m));
  };

  const sectionIdsKey = useMemo(() => (draft ? draft.sections.map((s) => s.id).join(',') : ''), [draft]);

  if (loadError) {
    return (
      <div className="nle-page">
        <div className="field-error" role="alert">{loadError}</div>
        <Link to="/newsletter/editions">← All editions</Link>
      </div>
    );
  }
  if (!view || !draft) return <div className="nle-page nle-muted">Loading…</div>;

  const { edition, permissions } = view;
  const sent = edition.status === 'sent';
  const canEdit = permissions.canEdit ?? canEditNewsletter(user);
  const locked = sent || !canEdit;
  const subjectLine = `${draft.subject.trim() ? `${draft.subject.trim()} - ` : ''}Ranger News #${draft.number}`;
  const myEmail = (user?.email || '').toLowerCase();
  const myDecision = edition.approvals
    .filter((a) => a.version === edition.version && a.approverEmail.toLowerCase() === myEmail)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  const saveLabel: Record<SaveState, string> = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes…',
    saving: 'Saving…',
    error: `Not saved: ${saveError || 'error'}`,
    conflict: 'Not saved: someone else saved',
  };

  return (
    <div className="nle-page nle-editor">
      <header className="nle-topbar">
        <div className="nle-topbar-title">
          <Link to="/newsletter/editions" className="nle-back">← Editions</Link>
          <h1>Ranger News #{draft.number}</h1>
          <span className={`nl-badge nl-badge-${edition.status}`}>{STATUS_LABELS[edition.status]}</span>
          {!sent && canEdit && <span className={`nle-save nle-save-${saveState}`} role="status">{saveLabel[saveState]}</span>}
        </div>
        <ApprovalSummary view={view} />
        <div className="nle-actions">
          {edition.status === 'draft' && canEdit && (
            <button type="button" className="btn btn-neutral" disabled={!!busy} onClick={() => act('submit', () => newsletterService.submitForApproval(id), { ok: 'Approvers have been notified' })}>
              Ask for approval
            </button>
          )}
          {!sent && edition.status !== 'approved' && (
            <>
              {permissions.canApprove && (<>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!!busy || myDecision?.status === 'approved'}
                title={myDecision?.status === 'approved' ? 'You approved this version' : `Approve version ${edition.version}`}
                onClick={() => act('approve', async () => {
                  const v = await newsletterService.decide(id, versionRef.current, 'approved');
                  const as = v.permissions.approvesAs;
                  const counted = [as.commsCadre && 'the Comms Cadre', as.commsManager && 'the Communications Manager'].filter(Boolean).join(' and ');
                  const waiting = v.edition.status === 'approved' ? '' : !v.approval.commsManager.met
                    ? ` Still needed: the Communications Manager${v.commsManagers.length ? ` (${v.commsManagers.map((m) => m.name).join(' or ')})` : ' (nobody is set up: Admin → Council)'}.`
                    : !v.approval.commsCadre.met ? ' Still needed: a Comms Cadre member.' : '';
                  setActionMessage({ kind: 'ok', text: `Your approval counts for ${counted}.${waiting}` });
                  return v;
                })}
              >
                {myDecision?.status === 'approved' ? 'Approved ✓' : 'Approve'}
              </button>
              <button type="button" className="btn btn-neutral" disabled={!!busy} onClick={() => openDialog('changes')}>
                Request changes
              </button>
              </>)}
              {permissions.canOverride && (
                <button type="button" className="btn btn-neutral" disabled={!!busy} onClick={() => openDialog('override')}>
                  Override
                </button>
              )}
            </>
          )}
          {!sent && (
            <button type="button" className="btn btn-neutral" disabled={!!busy} onClick={() => act('test', async () => {
              const r = await newsletterService.sendTest(id);
              setActionMessage({ kind: 'ok', text: `Test sent to ${r.to}` });
            })}>
              {busy === 'test' ? 'Sending…' : 'Send test to me'}
            </button>
          )}
          {edition.status === 'approved' && canEdit && (
            <button
              type="button"
              className="btn btn-primary nle-send"
              disabled={!!busy || !permissions.announceConfigured || saveState !== 'saved'}
              title={!permissions.announceConfigured ? 'Sending is not configured here (ANNOUNCE_EMAIL_TO)' : ''}
              onClick={() => openDialog('send')}
            >
              <i className="fas fa-paper-plane" aria-hidden="true" /> Send to Announce
            </button>
          )}
          {sent && (
            <Link className="btn btn-neutral" to={`/newsletter/${edition.number}`}>View the public page</Link>
          )}
        </div>
        {actionMessage && !(dialog && actionMessage.kind === 'error') && (
          <div className={actionMessage.kind === 'error' ? 'field-error' : 'nle-ok'} role={actionMessage.kind === 'error' ? 'alert' : 'status'}>{actionMessage.text}</div>
        )}
        {!sent && !canEdit && (
          <div className="nle-muted nle-readonly-note">
            Only the Comms Cadre edit the newsletter{permissions.canApprove ? '; you can approve or request changes.' : '.'}
          </div>
        )}
        {edition.status === 'approved' && (
          <div className="nle-muted">Approved as it is now. Any edit sends it back for approval.</div>
        )}
        {edition.status === 'approved' && canEdit && !permissions.announceConfigured && (
          <div className="nle-muted">Sending is not configured in this environment.</div>
        )}
      </header>

      {conflict && (
        <div className="nle-conflict" role="alert">
          <strong>Someone else saved this edition</strong> ({conflict.updatedByName || conflict.updatedBy}, version {conflict.version}) while you were editing. Your latest changes are not saved.
          <div className="nle-conflict-actions">
            <button type="button" className="btn btn-sm btn-neutral" onClick={() => resolveConflict(false)}>Load their version (drop my changes)</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => resolveConflict(true)}>Keep mine (replace theirs)</button>
          </div>
        </div>
      )}
      {sent && (
        <div className="nle-sent-note">
          Sent {edition.sentAt ? new Date(edition.sentAt).toLocaleString() : ''}. A sent edition can't change.
        </div>
      )}

      <div className="nle-columns">
        <main className="nle-main">
          <section className="nle-card" aria-label="Masthead and subject">
            <div className="nle-masthead-grid">
              <div className="form-field nle-number">
                <label htmlFor="nle-number">Issue #</label>
                <input id="nle-number" type="number" min={1} className="form-control" value={Number.isFinite(draft.number) ? draft.number : ''} disabled={locked} onChange={(e) => setField('number', parseInt(e.target.value, 10))} />
              </div>
              <div className="form-field nle-grow">
                <label htmlFor="nle-subject">Subject</label>
                <input id="nle-subject" type="text" className="form-control" value={draft.subject} disabled={locked} placeholder="Tickets & Stuff, Travel, and Opportunities!" onChange={(e) => setField('subject', e.target.value)} />
                <div className="field-hint">Sent as: <strong>{subjectLine}</strong></div>
              </div>
            </div>
            <button type="button" className="nle-more" onClick={() => setMoreOpen(!moreOpen)} aria-expanded={moreOpen}>
              <i className={`fas fa-chevron-${moreOpen ? 'down' : 'right'}`} aria-hidden="true" /> Masthead, introduction, reply-to and footnotes
            </button>
            {moreOpen && (
              <div className="nle-more-body">
                <div className="nle-masthead-grid">
                  <div className="form-field nle-grow">
                    <label htmlFor="nle-title">Masthead</label>
                    <input id="nle-title" type="text" className="form-control" value={draft.title} disabled={locked} onChange={(e) => setField('title', e.target.value)} />
                  </div>
                  <div className="form-field nle-grow">
                    <label htmlFor="nle-tagline">Tagline</label>
                    <input id="nle-tagline" type="text" className="form-control" value={draft.tagline} disabled={locked} onChange={(e) => setField('tagline', e.target.value)} />
                  </div>
                </div>
                <div className="form-field">
                  <label htmlFor="nle-reply-to">Reply-To (optional)</label>
                  <input id="nle-reply-to" type="email" className="form-control" value={draft.replyTo || ''} disabled={locked} placeholder="e.g. ranger-comm-cadre-list@burningman.org" onChange={(e) => setField('replyTo', e.target.value)} />
                </div>
                <div className="form-field">
                  <label>Introduction (optional)</label>
                  <div className="nl-blurb-editor">
                    <RichTextField key={`intro-${editorKey}`} value={draft.intro || ''} onChange={(json) => setField('intro', json)} readOnly={locked} userId={userId} placeholder="A few words above the first section" />
                  </div>
                </div>
                <div className="form-field">
                  <label>Footnotes (optional)</label>
                  <div className="nl-blurb-editor">
                    <RichTextField key={`foot-${editorKey}`} value={draft.footnotes || ''} onChange={(json) => setField('footnotes', json)} readOnly={locked} userId={userId} placeholder="* The Ranger Council is…" />
                  </div>
                </div>
              </div>
            )}
          </section>

          <h2 className="nle-heading">Sections</h2>
          {draft.sections.length === 0 && locked && <p className="nle-muted">No sections yet.</p>}
          {draft.sections.length === 0 && !locked && (
            <p className="nle-muted">No sections yet. Add approved requests from the <button type="button" className="nle-linkbtn" onClick={() => setSideTab('tray')}>tray</button>, or write your own.</p>
          )}
          {draft.sections.map((section, i) => (
            <SectionCard
              key={section.id}
              section={section}
              index={i}
              count={draft.sections.length}
              source={view.sources[section.id]}
              documentUrl={section.readMore.submissionId ? view.documents[section.readMore.submissionId]?.url : null}
              documentOptions={documentOptions}
              onLoadDocumentOptions={loadDocumentOptions}
              onChange={(next) => setSection(i, next)}
              onMove={(delta) => edit((d) => {
                const sections = [...d.sections];
                const [moved] = sections.splice(i, 1);
                sections.splice(i + delta, 0, moved);
                return { ...d, sections };
              })}
              onRemove={() => edit((d) => ({ ...d, sections: d.sections.filter((s) => s.id !== section.id) }))}
              onRefresh={() => act('refresh', () => newsletterService.refreshSection(id, section.id), { remount: true })}
              disabled={locked}
              editorKey={`${section.id}-${editorKey}`}
              userId={userId}
              uploader={uploader}
            />
          ))}
          {!locked && (
            <div className="nle-add-row">
              <button
                type="button"
                className="add-approver-btn"
                onClick={() => edit((d) => ({
                  ...d,
                  sections: [...d.sections, { id: newId(), kind: 'custom', heading: '', body: '', photos: [], links: [], readMore: { kind: 'none' }, keyDates: [] }],
                }))}
              >
                + Add your own section
              </button>
              <button type="button" className="add-approver-btn" onClick={() => setSideTab('tray')}>
                + Add from requests
              </button>
            </div>
          )}

          <h2 className="nle-heading">Mark your calendar!</h2>
          <section className="nle-card" aria-label="Calendar">
            <CalendarEditor
              derived={view.calendar}
              sections={draft.sections}
              manual={draft.calendar}
              hidden={draft.calendarHidden}
              onManualChange={(rows) => setField('calendar', rows)}
              onHiddenChange={(keys) => setField('calendarHidden', keys)}
              disabled={locked}
            />
          </section>
        </main>

        <aside className="nle-side">
          <div className="nle-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={sideTab === 'preview'} className={sideTab === 'preview' ? 'active' : ''} onClick={() => setSideTab('preview')}>Preview</button>
            {!locked && <button type="button" role="tab" aria-selected={sideTab === 'tray'} className={sideTab === 'tray' ? 'active' : ''} onClick={() => setSideTab('tray')}>Add from requests</button>}
            <button type="button" role="tab" aria-selected={sideTab === 'activity'} className={sideTab === 'activity' ? 'active' : ''} onClick={() => setSideTab('activity')}>
              Activity{edition.comments.length ? ` (${edition.comments.length})` : ''}
            </button>
          </div>
          <div className="nle-side-body">
            {sideTab === 'preview' && (
              <>
                {preview && (
                  <div className="nle-preview-head">
                    <div><span className="nle-muted">To:</span> {preview.to || 'not configured here'}</div>
                    <div><span className="nle-muted">Subject:</span> {preview.subject}</div>
                    <div className="nle-muted">{Math.round(preview.sizeBytes / 1024)} KB{saveState !== 'saved' && !sent ? ' · shows the last saved version' : ''}</div>
                    {preview.warnings.length > 0 && (
                      <ul className="nle-warnings">
                        {preview.warnings.map((w) => <li key={w}><i className="fas fa-exclamation-triangle" aria-hidden="true" /> {w}</li>)}
                      </ul>
                    )}
                  </div>
                )}
                {previewError && <div className="field-error" role="alert">{previewError}</div>}
                {preview ? <HtmlFrame html={preview.html} title="Newsletter preview" className="nle-preview-frame" /> : !previewError && <p className="nle-muted">Loading the preview…</p>}
              </>
            )}
            {sideTab === 'tray' && !locked && (
              <TrayPanel
                disabled={!!busy}
                refreshKey={sectionIdsKey}
                onAdd={async (submissionId) => {
                  await flush();
                  const next = await newsletterService.addFromSubmission(id, submissionId);
                  applyView(next, true);
                }}
              />
            )}
            {sideTab === 'activity' && (
              <ActivityPanel view={view} busy={!!busy} onComment={async (text) => { await act('comment', () => newsletterService.comment(id, text)); }} />
            )}
          </div>
        </aside>
      </div>

      {dialog && (
        <div className="request-changes-overlay" onClick={closeDialog}>
          <div className="request-changes-dialog" role="dialog" aria-modal="true" aria-labelledby="nle-dialog-title" onClick={(e) => e.stopPropagation()}>
            {dialog === 'send' && (
              <>
                <h3 id="nle-dialog-title">Send Ranger News #{edition.number}?</h3>
                <p>It goes to <strong>{preview?.to || 'Announce'}</strong> with the subject <strong>{preview?.subject || subjectLine}</strong>. This can't be undone.</p>
                <p className="nle-muted">The edition and its Read more pages become public web pages.</p>
              </>
            )}
            {dialog === 'changes' && (
              <>
                <h3 id="nle-dialog-title">Request changes</h3>
                <textarea className="form-control" rows={3} value={dialogText} placeholder="What needs to change?" onChange={(e) => setDialogText(e.target.value)} aria-label="What needs to change" />
              </>
            )}
            {dialog === 'override' && (
              <>
                <h3 id="nle-dialog-title">Approve without the usual approvals</h3>
                <textarea className="form-control" rows={3} value={dialogText} placeholder="Why? (recorded on the edition)" onChange={(e) => setDialogText(e.target.value)} aria-label="Reason for the override" />
              </>
            )}
            {actionMessage?.kind === 'error' && (
              <div className="field-error" role="alert">{actionMessage.text}</div>
            )}
            <div className="request-changes-actions">
              <button type="button" className="btn btn-neutral" onClick={closeDialog}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!!busy || (dialog !== 'send' && !dialogText.trim())}
                onClick={async () => {
                  const done = dialog === 'send'
                    ? await act('send', () => newsletterService.send(id), { remount: true, ok: `Sent to ${preview?.to || 'Announce'}` })
                    : dialog === 'changes'
                      ? await act('changes', () => newsletterService.decide(id, versionRef.current, 'rejected', dialogText.trim()))
                      : await act('override', () => newsletterService.override(id, versionRef.current, dialogText.trim()));
                  if (done) setDialog(null);
                }}
              >
                {busy ? 'Working…' : dialog === 'send' ? 'Send now' : dialog === 'changes' ? 'Request changes' : 'Approve'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NewsletterEditor;
