import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ContentSubmission } from '../../types/content';
import { EMPTY_NEWSLETTER_REQUEST, KeyDate, NewsletterRequest, isBlankRichText } from '../../types/newsletter';
import { newsletterService } from '../../services/newsletterService';
import NewsletterItemFields, { cleanNewsletterItem, newsletterItemError } from './NewsletterItemFields';
import KeyDatesEditor, { filledKeyDates, keyDatesError } from './KeyDatesEditor';
import './newsletter.css';

interface NewsletterReviewPanelProps {
  submission: ContentSubmission;
  /** The request's current audience keys (an Audience change in review counts). */
  audienceKeys: string[];
  currentUser: { id?: string; email?: string; name?: string };
  /** The Comms Cadre / Admins (to see the edition link). */
  isCommsCadre: boolean;
}

const statusLabel: Record<string, string> = { draft: 'draft', in_review: 'in review', approved: 'approved', sent: 'sent' };

/**
 * The review page's Newsletter item: the blurb, photos, links, Read more and key dates, edited
 * directly (not as tracked changes) and saved with PATCH /content/submissions/:id/newsletter.
 * Shows where the item is: not yet in an edition, in edition #N, or sent in #N.
 */
export const NewsletterReviewPanel: React.FC<NewsletterReviewPanelProps> = ({ submission, audienceKeys, currentUser, isCommsCadre }) => {
  const [open, setOpen] = useState(true);
  const [item, setItem] = useState<NewsletterRequest>({ ...EMPTY_NEWSLETTER_REQUEST, ...(submission.newsletter || {}) });
  const [keyDates, setKeyDates] = useState<KeyDate[]>(submission.keyDates || []);
  const [helpWithBlurb, setHelpWithBlurb] = useState(!!submission.writingHelp?.blurb);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [editorKey, setEditorKey] = useState(0);

  // A newer copy from the server (another reviewer saved) replaces the form unless it has edits
  useEffect(() => {
    if (dirty) return;
    setItem({ ...EMPTY_NEWSLETTER_REQUEST, ...(submission.newsletter || {}) });
    setKeyDates(submission.keyDates || []);
    setHelpWithBlurb(!!submission.writingHelp?.blurb);
    setEditorKey((k) => k + 1);
  }, [submission.newsletter, submission.keyDates, submission.writingHelp]);

  const inNewsletter = audienceKeys.includes('newsletter');
  if (!inNewsletter && !(submission.keyDates && submission.keyDates.length)) return null;

  const sentIn = submission.newsletterSentIn;
  const placement = submission.newsletterPlacement;
  const locked = !!sentIn;
  const hasDocument = !!submission.writingHelp?.document
    || !isBlankRichText(submission.richTextContent || submission.content);

  const change = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setDirty(true);
    setMessage(null);
  };

  const save = async () => {
    const error = (inNewsletter ? newsletterItemError(item, { helpWithBlurb, hasDocument }) : null) || keyDatesError(keyDates);
    if (error) {
      setMessage({ kind: 'error', text: error });
      return;
    }
    setSaving(true);
    try {
      const result = await newsletterService.updateRequestNewsletter(submission.id, {
        ...(inNewsletter ? { newsletter: cleanNewsletterItem(item) } : {}),
        keyDates: filledKeyDates(keyDates),
        writingHelp: { ...(submission.writingHelp || {}), blurb: helpWithBlurb },
      });
      setItem({ ...EMPTY_NEWSLETTER_REQUEST, ...(result.newsletter || {}) });
      setKeyDates(result.keyDates);
      setDirty(false);
      setMessage({ kind: 'ok', text: 'Saved' });
    } catch (err: any) {
      setMessage({ kind: 'error', text: err?.message || 'Could not save' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="nl-panel nl-review-panel" aria-label="Newsletter item">
      <div className="nl-review-head">
        <button type="button" className="nl-review-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <i className={`fas fa-chevron-${open ? 'down' : 'right'}`} aria-hidden="true" />
          <span className="nl-panel-title"><i className="fas fa-newspaper" aria-hidden="true" /> {inNewsletter ? 'Newsletter item' : 'Key dates'}</span>
        </button>
        <div className="nl-review-badges">
          {submission.writingHelp?.blurb && !sentIn && <span className="nl-badge nl-badge-help">Asked for help with the blurb</span>}
          {submission.writingHelp?.document && <span className="nl-badge nl-badge-help">Asked for help with the text</span>}
          {inNewsletter && (sentIn
            ? <span className="nl-badge nl-badge-sent">Sent in Ranger News #{sentIn}</span>
            : placement
              ? (isCommsCadre
                ? <Link className={`nl-badge nl-badge-${placement.status}`} to={`/newsletter/editions/${placement.editionId}`}>In #{placement.number} ({statusLabel[placement.status] || placement.status})</Link>
                : <span className={`nl-badge nl-badge-${placement.status}`}>In Ranger News #{placement.number}</span>)
              : <span className="nl-badge nl-badge-status">Not in an edition yet</span>)}
        </div>
      </div>

      {open && (
        <div className="nl-review-body">
          {placement && !sentIn && (
            <p className="nl-panel-intro">
              Edits here don't change edition #{placement.number}; its editors will see that the item changed and can refresh it.
            </p>
          )}
          {inNewsletter && (
            <NewsletterItemFields
              value={item}
              onChange={change(setItem)}
              helpWithBlurb={helpWithBlurb}
              onHelpWithBlurbChange={change(setHelpWithBlurb)}
              hasDocument={hasDocument}
              singularSelected={audienceKeys.includes('singular')}
              userId={currentUser.id || currentUser.email || ''}
              uploader={currentUser.name || currentUser.email || ''}
              disabled={locked}
              editorKey={`review-blurb-${editorKey}`}
            />
          )}
          <div className="form-field">
            <label>Key dates</label>
            <KeyDatesEditor
              value={keyDates}
              onChange={change(setKeyDates)}
              disabled={locked}
              hint="They go in the newsletter's “Mark your calendar!” table."
            />
          </div>
          {!locked && (
            <div className="nl-review-actions">
              <button type="button" className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save newsletter item'}
              </button>
              {message && <span className={message.kind === 'error' ? 'field-error' : 'nl-saved'} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</span>}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default NewsletterReviewPanel;
