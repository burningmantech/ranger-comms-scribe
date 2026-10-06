import React, { useState } from 'react';
import { KeyDate } from '../../types/newsletter';
import { AnnualDate } from '../../types/annualDates';
import { formatOccurrence, nextOccurrence, occurrenceOn } from '../../utils/annualDates';
import TrackDateModal from '../dates/TrackDateModal';
import { todayIso } from './dates';
import '../dates/Dates.css';

interface KeyDatesEditorProps {
  value: KeyDate[];
  onChange: (next: KeyDate[]) => void;
  disabled?: boolean;
  /** Shown above the rows. */
  hint?: React.ReactNode;
  max?: number;
  /** The annual dates table: when given, each row can follow an annual date and be updated from it. */
  annualDates?: AnnualDate[];
  onAnnualDateAdded?: (entry: AnnualDate) => void;
  /** The next occurrence on or after this is the one a linked row should show (default today). */
  referenceYmd?: string;
}

/** A row's link to an annual date: Link / Track, or the entry it follows and an Update when it disagrees. */
const KeyDateAnnual: React.FC<{
  row: KeyDate;
  index: number;
  annualDates: AnnualDate[];
  referenceYmd: string;
  disabled?: boolean;
  onChange: (patch: Partial<KeyDate>) => void;
  onTrack: () => void;
}> = ({ row, index, annualDates, referenceYmd, disabled, onChange, onTrack }) => {
  if (!row.date) return null;
  const entry = row.annualDateId ? annualDates.find((e) => e.id === row.annualDateId) : undefined;
  if (row.annualDateId && entry) {
    const target = nextOccurrence(entry, referenceYmd);
    const stale = target.date !== row.date || (target.endDate || undefined) !== (row.endDate || undefined);
    return (
      <div className="dt-keydate" data-testid={`key-date-annual-${index}`}>
        <span className="dt-entry"><i className="fas fa-link" aria-hidden="true" /> Every year: <strong>{entry.name}</strong></span>
        {stale ? (
          <span className="dt-status dt-status--stale">
            {target.year}: {formatOccurrence({ date: target.date, endDate: target.endDate })}
            {!disabled && (
              <button type="button" className="cc-btn cc-btn--small cc-btn--primary" onClick={() => onChange({ date: target.date, endDate: target.endDate })}>
                Update
              </button>
            )}
          </span>
        ) : (
          <span className="dt-status dt-status--ok"><i className="fas fa-check" aria-hidden="true" /> Right for {target.year}</span>
        )}
        {!disabled && (
          <button type="button" className="cc-btn cc-btn--small cc-btn--ghost" onClick={() => onChange({ annualDateId: undefined })}>Unlink</button>
        )}
      </div>
    );
  }
  if (disabled) return null;
  const match = annualDates.find((e) => occurrenceOn(e, row.date));
  return (
    <div className="dt-keydate" data-testid={`key-date-annual-${index}`}>
      {row.annualDateId && <span className="dt-status dt-status--gone">Its annual date was deleted.</span>}
      {match && (
        <span className="dt-match">
          Looks like <strong>{match.name}</strong>
          <button type="button" className="cc-btn cc-btn--small" onClick={() => onChange({ annualDateId: match.id })}>Link</button>
        </span>
      )}
      <button type="button" className="cc-btn cc-btn--small" onClick={onTrack}>Track every year…</button>
    </div>
  );
};

const EMPTY: KeyDate = { date: '', label: '' };

/** Rows of date (and optional end date), what happens, and an optional link. */
export const KeyDatesEditor: React.FC<KeyDatesEditorProps> = ({
  value, onChange, disabled, hint, max = 20, annualDates, onAnnualDateAdded, referenceYmd,
}) => {
  const [tracking, setTracking] = useState<number | null>(null);
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
          {annualDates && (
            <KeyDateAnnual
              row={d}
              index={i}
              annualDates={annualDates}
              referenceYmd={referenceYmd || todayIso()}
              disabled={disabled}
              onChange={(patch) => update(i, patch)}
              onTrack={() => setTracking(i)}
            />
          )}
        </div>
      ))}
      {tracking !== null && value[tracking] && (
        <TrackDateModal
          found={{ text: value[tracking].label || value[tracking].date, index: 0, date: value[tracking].date, endDate: value[tracking].endDate, yearCertain: true }}
          defaultName={value[tracking].label}
          onClose={() => setTracking(null)}
          onSaved={(entry) => {
            onAnnualDateAdded?.(entry);
            update(tracking, { annualDateId: entry.id });
            setTracking(null);
          }}
        />
      )}
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
