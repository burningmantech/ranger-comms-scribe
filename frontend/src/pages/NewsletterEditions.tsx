import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { newsletterService } from '../services/newsletterService';
import { EditionStatus, EditionSummary } from '../types/newsletter';
import { canEditNewsletter, storedUser } from '../utils/newsletterAccess';
import '../components/newsletter/newsletter.css';
import './NewsletterEditor.css';

const GROUPS: Array<{ status: EditionStatus; title: string }> = [
  { status: 'draft', title: 'Drafts' },
  { status: 'in_review', title: 'Waiting for approval' },
  { status: 'approved', title: 'Approved, ready to send' },
  { status: 'sent', title: 'Sent' },
];

export const STATUS_LABELS: Record<EditionStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  sent: 'Sent',
};

const formatDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

/** The Comms Cadre's list of newsletter editions, and where a new one starts. */
export const NewsletterEditions: React.FC = () => {
  const [editions, setEditions] = useState<EditionSummary[] | null>(null);
  const [nextNumber, setNextNumber] = useState<number | null>(null);
  const [subject, setSubject] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  // Only the Comms Cadre and Admins build editions; the Communications Manager reviews them
  const canEdit = canEditNewsletter(storedUser());

  useEffect(() => {
    newsletterService.listEditions()
      .then((r) => {
        setEditions(r.editions);
        setNextNumber(r.nextNumber);
      })
      .catch((err) => setError(err.message));
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const view = await newsletterService.createEdition({ subject: subject.trim() });
      navigate(`/newsletter/editions/${view.edition.id}`);
    } catch (err: any) {
      setError(err.message);
      setCreating(false);
    }
  };

  return (
    <div className="nle-page nle-list-page">
      <header className="nle-list-header">
        <div>
          <h1>Ranger Newsletter</h1>
          <p>Build each edition from approved requests and your own sections, get it approved, and send it to Announce.</p>
        </div>
        <Link to="/newsletter" className="nle-link">Public archive <i className="fas fa-external-link-alt" aria-hidden="true" /></Link>
      </header>

      {canEdit ? (
      <form className="nle-new" onSubmit={create}>
        <label htmlFor="nle-new-subject" className="nle-new-label">
          Start Ranger News #{nextNumber ?? '…'}
        </label>
        <div className="nle-new-row">
          <input
            id="nle-new-subject"
            className="form-control"
            type="text"
            value={subject}
            placeholder="Subject, e.g. Tickets & Stuff, Travel, and Opportunities!"
            onChange={(e) => setSubject(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={creating || nextNumber === null}>
            {creating ? 'Creating…' : 'New edition'}
          </button>
        </div>
        <div className="field-hint">You can change the subject later. Standing dates from the last edition's calendar carry over.</div>
      </form>
      ) : (
        <p className="nle-muted">The Comms Cadre build the editions. Open one to read it, approve it or request changes.</p>
      )}

      {error && <div className="field-error" role="alert">{error}</div>}
      {!editions && !error && <p className="nle-muted">Loading…</p>}

      {editions && GROUPS.map(({ status, title }) => {
        const group = editions.filter((e) => e.status === status);
        if (group.length === 0) return null;
        return (
          <section key={status} className="nle-group">
            <h2>{title}</h2>
            <ul className="nle-edition-list">
              {group.map((e) => (
                <li key={e.id}>
                  <Link to={`/newsletter/editions/${e.id}`} className="nle-edition-row">
                    <span className="nle-edition-number">#{e.number}</span>
                    <span className="nle-edition-subject">{e.subject || <em>No subject yet</em>}</span>
                    <span className="nle-edition-meta">
                      {e.sectionCount} section{e.sectionCount === 1 ? '' : 's'}
                      {e.status === 'in_review' && (
                        <> · {[e.approval.commsCadre.met && 'Cadre ✓', e.approval.commsManager.met && 'Comms Manager ✓'].filter(Boolean).join(', ') || 'no approvals yet'}</>
                      )}
                      {' · '}{e.status === 'sent' ? `sent ${formatDate(e.sentAt)}` : `edited ${formatDate(e.updatedAt)}`}
                    </span>
                    <span className={`nl-badge nl-badge-${e.status}`}>{STATUS_LABELS[e.status]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {editions && editions.length === 0 && <p className="nle-muted">No editions yet.{canEdit ? ' Start the first one above.' : ''}</p>}
    </div>
  );
};

export default NewsletterEditions;
