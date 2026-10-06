import React from 'react';
import { CalendarRow, EditorCalendarEntry, NewsletterSection } from '../../types/newsletter';
import { formatCalendarDate, todayIso } from './dates';

interface CalendarEditorProps {
  /** Rows from the sections' key dates, as of the last save (with hidden / past flags). */
  derived: EditorCalendarEntry[];
  sections: NewsletterSection[];
  manual: CalendarRow[];
  hidden: string[];
  onManualChange: (rows: CalendarRow[]) => void;
  onHiddenChange: (keys: string[]) => void;
  disabled: boolean;
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `row-${Date.now()}-${Math.random().toString(16).slice(2)}`);

/**
 * "Mark your calendar!": the sections' key dates (hide the ones that don't belong) and rows
 * added here (kept for the next edition while they're ahead). Rows already past are not sent.
 */
export const CalendarEditor: React.FC<CalendarEditorProps> = ({ derived, sections, manual, hidden, onManualChange, onHiddenChange, disabled }) => {
  const today = todayIso();
  const sectionRows = derived.filter((e) => e.source === 'section');
  const headingOf = (id?: string) => sections.find((s) => s.id === id)?.heading || 'a section';
  const update = (id: string, patch: Partial<CalendarRow>) => onManualChange(manual.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const toggleHidden = (key: string) => onHiddenChange(hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]);

  return (
    <div className="nle-calendar">
      {sectionRows.length === 0 && manual.length === 0 && (
        <p className="nle-muted">No dates yet. Key dates in the sections appear here, or add one below.</p>
      )}
      {sectionRows.length > 0 && (
        <table className="nle-calendar-table">
          <caption>From the sections</caption>
          <thead>
            <tr><th scope="col">Date</th><th scope="col">Event</th><th scope="col">From</th><th scope="col"><span className="visually-hidden">Show</span></th></tr>
          </thead>
          <tbody>
            {sectionRows.map((e) => (
              <tr key={e.key} className={e.hidden || e.past ? 'nle-row-off' : ''}>
                <td>{formatCalendarDate(e.date, e.endDate, today)}</td>
                <td>
                  {e.label}
                  {e.link && <> · <a href={e.link} target="_blank" rel="noopener noreferrer">{e.linkLabel || 'link'}</a></>}
                  {e.past && <span className="nle-row-note"> (past, left out)</span>}
                </td>
                <td className="nle-muted">{headingOf(e.sectionId)}</td>
                <td>
                  {!disabled && !e.past && (
                    <button type="button" className="btn btn-sm btn-neutral" onClick={() => toggleHidden(e.key)}>
                      {e.hidden ? 'Show' : 'Hide'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {manual.length > 0 && <div className="nle-calendar-caption">Added here</div>}
      {manual.map((row, i) => {
        const past = !!row.date && (row.endDate || row.date) < today;
        return (
          <div key={row.id} className={`nl-key-date-row ${past ? 'nle-row-off' : ''}`}>
            <div className="nl-key-date-dates">
              <label className="nl-mini-label">
                Date
                <input type="date" className="form-control" value={row.date} disabled={disabled} onChange={(e) => update(row.id, { date: e.target.value })} aria-label={`Calendar date ${i + 1}`} />
              </label>
              <label className="nl-mini-label">
                Until (optional)
                <input type="date" className="form-control" value={row.endDate || ''} min={row.date || undefined} disabled={disabled} onChange={(e) => update(row.id, { endDate: e.target.value || undefined })} aria-label={`Calendar date ${i + 1} end`} />
              </label>
            </div>
            <label className="nl-mini-label nl-grow">
              Event
              <input type="text" className="form-control" value={row.label} disabled={disabled} placeholder="e.g. Burning Man!" onChange={(e) => update(row.id, { label: e.target.value })} aria-label={`Calendar event ${i + 1}`} />
            </label>
            <label className="nl-mini-label nl-grow">
              Link (optional)
              <input type="url" className="form-control" value={row.link || ''} disabled={disabled} placeholder="https://" onChange={(e) => update(row.id, { link: e.target.value || undefined })} aria-label={`Calendar link ${i + 1}`} />
            </label>
            {row.link && (
              <label className="nl-mini-label">
                Link text
                <input type="text" className="form-control" value={row.linkLabel || ''} disabled={disabled} placeholder="e.g. Countdown" onChange={(e) => update(row.id, { linkLabel: e.target.value || undefined })} />
              </label>
            )}
            {past && <span className="nle-row-note">Past: left out</span>}
            {!disabled && (
              <button type="button" className="nl-remove" onClick={() => onManualChange(manual.filter((r) => r.id !== row.id))} aria-label={`Remove calendar row ${i + 1}`} title="Remove">&times;</button>
            )}
          </div>
        );
      })}
      {!disabled && (
        <button type="button" className="add-approver-btn" onClick={() => onManualChange([...manual, { id: newId(), date: '', label: '' }])}>
          + Add a date
        </button>
      )}
    </div>
  );
};

export default CalendarEditor;
