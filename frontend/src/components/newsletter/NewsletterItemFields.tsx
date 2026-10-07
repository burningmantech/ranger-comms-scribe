import React from 'react';
import RichTextField from './RichTextField';
import { NewsletterRequest, ReadMoreKind, isBlankRichText } from '../../types/newsletter';
import PhotoListEditor from './PhotoListEditor';
import LinksEditor, { filledLinks, linksError } from './LinksEditor';
import { isWebUrl } from './urls';
import './newsletter.css';

export const MAX_REQUEST_PHOTOS = 2;

interface NewsletterItemFieldsProps {
  value: NewsletterRequest;
  onChange: (next: NewsletterRequest) => void;
  helpWithBlurb: boolean;
  onHelpWithBlurbChange: (help: boolean) => void;
  /** The request has a full document (written, or Comms asked to write it). */
  hasDocument: boolean;
  /** The request also goes out as a singular announcement. */
  singularSelected?: boolean;
  /** For uploads (the editor's images and the photo list). */
  userId: string;
  uploader: string;
  disabled?: boolean;
  /** Changing it remounts the blurb editor with the current value (e.g. after a reload). */
  editorKey?: string;
}

/**
 * The newsletter item of a request: a headline, a short blurb (or "please write it for me"),
 * up to two photos, links, and where "Read more" goes. Used by the request form and by the
 * review page's Newsletter panel.
 */
export const NewsletterItemFields: React.FC<NewsletterItemFieldsProps> = ({
  value,
  onChange,
  helpWithBlurb,
  onHelpWithBlurbChange,
  hasDocument,
  singularSelected,
  userId,
  uploader,
  disabled,
  editorKey,
}) => {
  const set = (patch: Partial<NewsletterRequest>) => onChange({ ...value, ...patch });
  const setReadMore = (kind: ReadMoreKind) => set({ readMore: { ...value.readMore, kind } });

  return (
    <div className="nl-item-fields">
      <div className="form-field">
        <label htmlFor="nl-headline">Newsletter headline</label>
        <input
          id="nl-headline"
          type="text"
          className="form-control"
          value={value.headline || ''}
          disabled={disabled}
          placeholder="Defaults to your subject line"
          onChange={(e) => set({ headline: e.target.value })}
        />
      </div>

      <div className="form-field">
        <label>Blurb</label>
        <div className="field-hint nl-hint-top">
          A few lines for the newsletter. Readers who want more can follow "Read more".
        </div>
        {!helpWithBlurb && (
          <div className="nl-blurb-editor">
            <RichTextField
              key={editorKey}
              value={value.blurb || ''}
              onChange={(json) => set({ blurb: isBlankRichText(json) ? '' : json })}
              placeholder="e.g. Everyone camping with Rangers needs to register by July 12th, including folks staying at Tokyo pre or post event."
              readOnly={disabled}
              userId={userId}
            />
          </div>
        )}
        <label className={`urgent-checkbox-label nl-help-check ${helpWithBlurb ? 'checked' : ''}`}>
          <input
            type="checkbox"
            checked={helpWithBlurb}
            disabled={disabled}
            onChange={(e) => onHelpWithBlurbChange(e.target.checked)}
          />
          <span>Please write the blurb for me</span>
        </label>
        {helpWithBlurb && (
          <div className="field-hint">Comms will write it from your request. Add anything they should know in Notes.</div>
        )}
      </div>

      <div className="form-field">
        <label>Photos</label>
        <div className="field-hint nl-hint-top">Up to {MAX_REQUEST_PHOTOS}. Please credit the photographer.</div>
        <PhotoListEditor
          value={value.photos}
          onChange={(photos) => set({ photos })}
          max={MAX_REQUEST_PHOTOS}
          disabled={disabled}
          uploader={uploader}
        />
      </div>

      <div className="form-field">
        <label>Links</label>
        <LinksEditor value={value.links} onChange={(links) => set({ links })} disabled={disabled} />
      </div>

      <fieldset className="form-field nl-read-more" disabled={disabled}>
        <legend>"Read more" goes to</legend>
        <label className="nl-radio">
          <input type="radio" name="nl-read-more" checked={value.readMore.kind === 'none'} onChange={() => setReadMore('none')} />
          <span>Nothing: the blurb says it all</span>
        </label>
        <label className={`nl-radio ${hasDocument ? '' : 'nl-disabled'}`}>
          <input
            type="radio"
            name="nl-read-more"
            checked={value.readMore.kind === 'document'}
            disabled={!hasDocument}
            onChange={() => setReadMore('document')}
          />
          <span>
            My full announcement
            <span className="nl-radio-hint">
              {hasDocument
                ? ' A web page with your full text, linked from the newsletter.'
                : ' Write the full text in step 1 (or ask us to) to link to it.'}
            </span>
          </span>
        </label>
        <label className="nl-radio">
          <input type="radio" name="nl-read-more" checked={value.readMore.kind === 'url'} onChange={() => setReadMore('url')} />
          <span>A link</span>
        </label>
        {value.readMore.kind === 'url' && (
          <input
            type="url"
            className="form-control nl-read-more-url"
            value={value.readMore.url || ''}
            placeholder="https://"
            aria-label="Read more link"
            onChange={(e) => set({ readMore: { ...value.readMore, url: e.target.value } })}
          />
        )}
        {value.readMore.kind === 'document' && singularSelected === false && (
          <div className="field-hint">
            Want the full announcement sent on its own as well? Also choose <strong>Singular Announcement</strong> above.
          </div>
        )}
      </fieldset>
    </div>
  );
};

/** The item as it should be saved: trimmed, blank rows dropped. */
export function cleanNewsletterItem(value: NewsletterRequest): NewsletterRequest {
  const headline = (value.headline || '').trim();
  const readMore = value.readMore.kind === 'url'
    ? { kind: 'url' as const, url: (value.readMore.url || '').trim(), ...(value.readMore.label ? { label: value.readMore.label } : {}) }
    : { kind: value.readMore.kind };
  return {
    ...(headline ? { headline } : {}),
    ...(value.blurb && !isBlankRichText(value.blurb) ? { blurb: value.blurb } : {}),
    photos: value.photos.map((p) => ({
      ...p,
      alt: p.alt.trim(),
      ...(p.credit?.trim() ? { credit: p.credit.trim() } : { credit: undefined }),
      ...(p.caption?.trim() ? { caption: p.caption.trim() } : { caption: undefined }),
    })),
    links: filledLinks(value.links),
    readMore,
  };
}

/** The first problem with the item, or null. */
export function newsletterItemError(
  value: NewsletterRequest,
  options: { helpWithBlurb: boolean; hasDocument: boolean },
): string | null {
  if (!options.helpWithBlurb && isBlankRichText(value.blurb)) {
    return 'Newsletter: write a short blurb, or tick "Please write the blurb for me"';
  }
  const links = linksError(value.links);
  if (links) return `Newsletter: ${links}`;
  if (value.readMore.kind === 'url' && !isWebUrl(value.readMore.url || '')) {
    return 'Newsletter: the "Read more" link must start with https://';
  }
  if (value.readMore.kind === 'document' && !options.hasDocument) {
    return 'Newsletter: "Read more" points at your full announcement, but there is no text yet';
  }
  return null;
}

export default NewsletterItemFields;
