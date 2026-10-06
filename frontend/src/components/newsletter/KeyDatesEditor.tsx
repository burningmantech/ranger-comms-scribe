import React from 'react';
import { KeyDate } from '../../types/newsletter';

interface KeyDatesEditorProps {
  value: KeyDate[];
  onChange: (next: KeyDate[]) => void;
  disabled?: boolean;
  /** Shown above the rows. */
  hint?: React.ReactNode;
  max?: number;
}

const EMPTY: KeyDate = { date: '', label: '' };

/** Rows of date (and optional end date), what happens, and an optional link. */
export const KeyDatesEditor: React.FC<KeyDatesEditorProps> = ({ value, onChange, disabled, hint, max = 20 }) => {
  const update = (index: number, patch: Partial<KeyDate>) => {
    onChange(value.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };
  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));

  return (
    <div className="nl-key-dates">
      {hint && <div className="field-hint nl-hint-top">{hint}</div>}
      {value.map((d, i) => (
        <div key={i} className="nl-key-date-row" data-testid="key-date-row">
          <div className="nl-key-date-dates">
            <label className="nl-mini-label">
              Date
              <input
                type="date"
                className="form-control"
                value={d.date}
                disabled={disabled}
                onChange={(e) => update(i, { date: e.target.value })}
                aria-label={`Key date ${i + 1}`}
              />
            </label>
            <label className="nl-mini-label">
              Until (optional)
              <input
                type="date"
                className="form-control"
                value={d.endDate || ''}
                min={d.date || undefined}
                disabled={disabled}
                onChange={(e) => update(i, { endDate: e.target.value || undefined })}
                aria-label={`Key date ${i + 1} end`}
              />
            </label>
          </div>
          <label className="nl-mini-label nl-grow">
            What happens
            <input
              type="text"
              className="form-control"
              value={d.label}
              disabled={disabled}
              placeholder="e.g. Deadline to register to camp"
              onChange={(e) => update(i, { label: e.target.value })}
              aria-label={`Key date ${i + 1} description`}
            />
          </label>
          <label className="nl-mini-label nl-grow">
            Link (optional)
            <input
              type="url"
              className="form-control"
              value={d.link || ''}
              disabled={disabled}
              placeholder="https://"
              onChange={(e) => update(i, { link: e.target.value || undefined })}
              aria-label={`Key date ${i + 1} link`}
            />
          </label>
          {d.link && (
            <label className="nl-mini-label">
              Link text
              <input
                type="text"
                className="form-control"
                value={d.linkLabel || ''}
                disabled={disabled}
                placeholder="e.g. Clubhouse"
                onChange={(e) => update(i, { linkLabel: e.target.value || undefined })}
                aria-label={`Key date ${i + 1} link text`}
              />
            </label>
          )}
          {!disabled && (
            <button type="button" className="nl-remove" onClick={() => remove(i)} aria-label={`Remove key date ${i + 1}`} title="Remove">
              &times;
            </button>
          )}
        </div>
      ))}
      {!disabled && value.length < max && (
        <button type="button" className="add-approver-btn" onClick={() => onChange([...value, { ...EMPTY }])}>
          + Add a date
        </button>
      )}
    </div>
  );
};

/** Key date rows that are filled in enough to send (blank rows are dropped). */
export function filledKeyDates(dates: KeyDate[]): KeyDate[] {
  return dates
    .map((d) => ({ ...d, label: d.label.trim(), link: d.link?.trim() || undefined, linkLabel: d.linkLabel?.trim() || undefined }))
    .filter((d) => d.date || d.label);
}

/** The first problem with a set of key dates, or null. */
export function keyDatesError(dates: KeyDate[]): string | null {
  for (const [i, d] of filledKeyDates(dates).entries()) {
    if (!d.date) return `Key date ${i + 1}: pick a date`;
    if (!d.label) return `Key date ${i + 1}: say what happens`;
    if (d.endDate && d.endDate < d.date) return `Key date ${i + 1}: the end date is before the start`;
    if (d.link && !/^https?:\/\//i.test(d.link)) return `Key date ${i + 1}: the link must start with https://`;
  }
  return null;
}

export default KeyDatesEditor;
