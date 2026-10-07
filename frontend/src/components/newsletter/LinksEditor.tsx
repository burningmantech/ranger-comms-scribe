import React from 'react';
import { NewsletterLink } from '../../types/newsletter';
import { isWebUrl } from './urls';

interface LinksEditorProps {
  value: NewsletterLink[];
  onChange: (next: NewsletterLink[]) => void;
  disabled?: boolean;
  max?: number;
}

/** Link rows: the text people click, and where it goes. */
export const LinksEditor: React.FC<LinksEditorProps> = ({ value, onChange, disabled, max = 8 }) => {
  const update = (index: number, patch: Partial<NewsletterLink>) => {
    onChange(value.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };
  return (
    <div className="nl-links">
      {value.map((link, i) => (
        <div key={i} className="nl-link-row" data-testid="link-row">
          <label className="nl-mini-label nl-grow">
            Link text
            <input
              type="text"
              className="form-control"
              value={link.label}
              disabled={disabled}
              placeholder="e.g. Ranger Camping Registration"
              onChange={(e) => update(i, { label: e.target.value })}
              aria-label={`Link ${i + 1} text`}
            />
          </label>
          <label className="nl-mini-label nl-grow">
            Address
            <input
              type="url"
              className="form-control"
              value={link.url}
              disabled={disabled}
              placeholder="https://"
              onChange={(e) => update(i, { url: e.target.value })}
              aria-label={`Link ${i + 1} address`}
            />
          </label>
          {!disabled && (
            <button type="button" className="nl-remove" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove link ${i + 1}`} title="Remove">
              &times;
            </button>
          )}
        </div>
      ))}
      {!disabled && value.length < max && (
        <button type="button" className="add-approver-btn" onClick={() => onChange([...value, { label: '', url: '' }])}>
          + Add a link
        </button>
      )}
    </div>
  );
};

/** Link rows with an address (blank rows are dropped). */
export function filledLinks(links: NewsletterLink[]): NewsletterLink[] {
  return links
    .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
    .filter((l) => l.url || l.label);
}

export function linksError(links: NewsletterLink[]): string | null {
  for (const [i, l] of filledLinks(links).entries()) {
    if (!l.url) return `Link ${i + 1}: add the address`;
    if (!isWebUrl(l.url)) return `Link ${i + 1}: the address must start with https://`;
  }
  return null;
}

export default LinksEditor;
