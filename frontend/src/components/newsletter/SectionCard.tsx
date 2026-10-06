import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import LexicalEditorComponent from '../editor/LexicalEditor';
import { NewsletterSection, ReadMoreKind, SectionSource } from '../../types/newsletter';
import PhotoListEditor from './PhotoListEditor';
import LinksEditor from './LinksEditor';
import KeyDatesEditor from './KeyDatesEditor';

export interface DocumentOption {
  id: string;
  title: string;
  status: string;
}

interface SectionCardProps {
  section: NewsletterSection;
  index: number;
  count: number;
  source?: SectionSource;
  /** Public page addresses of linked documents (from the last save). */
  documentUrl?: string | null;
  documentOptions: DocumentOption[] | null;
  onLoadDocumentOptions: () => void;
  onChange: (next: NewsletterSection) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onRefresh: () => void;
  disabled: boolean;
  editorKey: string;
  userId: string;
  uploader: string;
}

/** One section of an edition: heading, Important, text, photos, links, Read more, key dates. */
export const SectionCard: React.FC<SectionCardProps> = ({
  section,
  index,
  count,
  source,
  documentUrl,
  documentOptions,
  onLoadDocumentOptions,
  onChange,
  onMove,
  onRemove,
  onRefresh,
  disabled,
  editorKey,
  userId,
  uploader,
}) => {
  const [open, setOpen] = useState(true);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const set = (patch: Partial<NewsletterSection>) => onChange({ ...section, ...patch });
  const setReadMore = (kind: ReadMoreKind) => {
    if (kind === 'document') onLoadDocumentOptions();
    set({ readMore: { ...section.readMore, kind, ...(kind === 'document' && !section.readMore.submissionId && section.sourceSubmissionId ? { submissionId: section.sourceSubmissionId } : {}) } });
  };
  const headingId = `nle-section-${section.id}-heading`;

  return (
    <article className={`nle-section ${section.important ? 'nle-section-important' : ''}`} aria-labelledby={headingId}>
      <header className="nle-section-head">
        <button type="button" className="nle-collapse" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Collapse section' : 'Expand section'}>
          <i className={`fas fa-chevron-${open ? 'down' : 'right'}`} aria-hidden="true" />
        </button>
        <span className="nle-section-index">{index + 1}</span>
        <h3 id={headingId} className="nle-section-title">{section.heading || <em>Untitled section</em>}</h3>
        {source && (
          <span className="nle-source">
            <Link to={`/tracked-changes/${source.submissionId}`} title="Open the request">From a request</Link>
            {source.status === 'missing' && <span className="nl-badge nl-badge-help">request deleted</span>}
            {source.changed && !disabled && (
              <button type="button" className="nle-refresh" onClick={onRefresh} title="The request's newsletter item changed. Replace this section with it.">
                <i className="fas fa-sync-alt" aria-hidden="true" /> Request changed: refresh
              </button>
            )}
          </span>
        )}
        {!disabled && (
          <span className="nle-section-actions">
            <button type="button" className="nl-icon-btn" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move section up" title="Move up">
              <i className="fas fa-arrow-up" />
            </button>
            <button type="button" className="nl-icon-btn" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move section down" title="Move down">
              <i className="fas fa-arrow-down" />
            </button>
            {confirmRemove ? (
              <span className="nle-confirm">
                Remove?
                <button type="button" className="btn btn-sm btn-danger" onClick={onRemove}>Remove</button>
                <button type="button" className="btn btn-sm btn-neutral" onClick={() => setConfirmRemove(false)}>Keep</button>
              </span>
            ) : (
              <button type="button" className="nl-remove" onClick={() => setConfirmRemove(true)} aria-label="Remove section" title={section.sourceSubmissionId ? 'Remove (the request goes back to the tray)' : 'Remove'}>
                &times;
              </button>
            )}
          </span>
        )}
      </header>

      {open && (
        <div className="nle-section-body">
          <div className="form-field">
            <label htmlFor={`${headingId}-input`}>Heading</label>
            <input
              id={`${headingId}-input`}
              type="text"
              className="form-control"
              value={section.heading}
              disabled={disabled}
              onChange={(e) => set({ heading: e.target.value })}
            />
          </div>
          <label className={`urgent-checkbox-label nle-important ${section.important ? 'checked' : ''}`}>
            <input type="checkbox" checked={!!section.important} disabled={disabled} onChange={(e) => set({ important: e.target.checked || undefined })} />
            <span>Important: show it in a highlighted panel</span>
          </label>

          <div className="form-field">
            <label>Text</label>
            <div className="nl-blurb-editor">
              <LexicalEditorComponent
                key={editorKey}
                initialContent={section.body}
                onChange={(_editor, json) => set({ body: json })}
                readOnly={disabled}
                autoFocus={false}
                currentUserId={userId}
                canCreateSuggestions={false}
                placeholder="A few lines. Readers who want more follow Read more."
              />
            </div>
          </div>

          <div className="form-field">
            <label>Photos</label>
            <PhotoListEditor value={section.photos} onChange={(photos) => set({ photos })} max={6} disabled={disabled} uploader={uploader} />
          </div>

          <div className="form-field">
            <label>Links</label>
            <LinksEditor value={section.links} onChange={(links) => set({ links })} disabled={disabled} />
          </div>

          <fieldset className="form-field nl-read-more" disabled={disabled}>
            <legend>Read more</legend>
            <div className="nle-read-more-row">
              <select
                className="form-control nle-select"
                value={section.readMore.kind}
                onChange={(e) => setReadMore(e.target.value as ReadMoreKind)}
                aria-label="Read more goes to"
              >
                <option value="none">No Read more button</option>
                <option value="document">A request's full announcement (web page)</option>
                <option value="url">A link</option>
              </select>
              {section.readMore.kind === 'document' && (
                <select
                  className="form-control nle-select"
                  value={section.readMore.submissionId || ''}
                  onFocus={onLoadDocumentOptions}
                  onChange={(e) => set({ readMore: { ...section.readMore, submissionId: e.target.value || undefined } })}
                  aria-label="Which request"
                >
                  <option value="">Choose a request…</option>
                  {section.readMore.submissionId && !(documentOptions || []).some((d) => d.id === section.readMore.submissionId) && (
                    <option value={section.readMore.submissionId}>{source?.submissionId === section.readMore.submissionId ? source.title : 'This request'}</option>
                  )}
                  {(documentOptions || []).map((d) => (
                    <option key={d.id} value={d.id}>{d.title}{d.status === 'sent' ? ' (sent)' : ''}</option>
                  ))}
                </select>
              )}
              {section.readMore.kind === 'url' && (
                <input
                  type="url"
                  className="form-control"
                  value={section.readMore.url || ''}
                  placeholder="https://"
                  aria-label="Read more link"
                  onChange={(e) => set({ readMore: { ...section.readMore, url: e.target.value } })}
                />
              )}
              {section.readMore.kind !== 'none' && (
                <input
                  type="text"
                  className="form-control nle-button-label"
                  value={section.readMore.label || ''}
                  placeholder="Read more"
                  aria-label="Button text"
                  onChange={(e) => set({ readMore: { ...section.readMore, label: e.target.value || undefined } })}
                />
              )}
            </div>
            {section.readMore.kind === 'document' && documentUrl && (
              <div className="field-hint">Links to <a href={documentUrl} target="_blank" rel="noopener noreferrer">{documentUrl}</a> (public once this edition is sent).</div>
            )}
          </fieldset>

          <div className="form-field">
            <label>Key dates</label>
            <KeyDatesEditor value={section.keyDates} onChange={(keyDates) => set({ keyDates })} disabled={disabled} hint="These go in the calendar at the bottom." />
          </div>
        </div>
      )}
    </article>
  );
};

export default SectionCard;
