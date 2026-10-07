import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { annualDatesService } from '../../services/annualDatesService';
import { AnnualDate } from '../../types/annualDates';
import { describeRule, formatOccurrence, formatTimes, resolveAnnualDate } from '../../utils/annualDates';
import { useAnnualDates } from '../dates/useAnnualDates';
import { AnnualDateFormModal } from './AnnualDateFormModal';
import '../dates/Dates.css';

/**
 * The annual dates table: things that happen every year, on a fixed date or a number of days from
 * Labor Day. Requests link the dates they mention to these; change one here when something moves.
 */
export const AnnualDatesTab: React.FC = () => {
  const { entries, canEditAll, error: loadError, reload } = useAnnualDates();
  const [year, setYear] = useState(new Date().getFullYear());
  const [editing, setEditing] = useState<{ entry?: AnnualDate } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (entry: AnnualDate) => {
    setError(null);
    try {
      await annualDatesService.remove(entry.id);
      setConfirmDeleteId(null);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const rows = entries
    .map((entry) => ({ entry, now: resolveAnnualDate(entry, year), next: resolveAnnualDate(entry, year + 1) }))
    .sort((a, b) => a.now.date.localeCompare(b.now.date) || a.entry.name.localeCompare(b.entry.name));

  return (
    <section aria-label="Annual dates">
      <div className="cc-filters">
        <label className="cc-inline">
          <span>Year</span>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {Array.from({ length: 7 }, (_, i) => new Date().getFullYear() - 2 + i).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <span className="cc-muted cc-small">
          Things that happen every year. Track a date from a request (“Dates in this request”) or add one here; requests
          that link to it show when their text needs updating.
        </span>
        {canEditAll && (
          <button type="button" className="cc-btn cc-btn--primary" onClick={() => setEditing({})}>Add annual date</button>
        )}
      </div>
      {(error || loadError) && <div className="cc-error" role="alert">{error || loadError}</div>}
      {rows.length === 0 ? (
        <div className="cc-empty">No annual dates yet.</div>
      ) : (
        <div className="cc-table-wrap">
          <table className="cc-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Rule</th>
                <th>Time</th>
                <th>{year}</th>
                <th>{year + 1}</th>
                {canEditAll && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entry, now, next }) => (
                <tr key={entry.id}>
                  <td>
                    {entry.link ? <a href={entry.link} target="_blank" rel="noopener noreferrer">{entry.name}</a> : entry.name}
                    {entry.createdFrom?.submissionId && (
                      <Link to={`/tracked-changes/${entry.createdFrom.submissionId}`} className="cc-tag" title="The request it was tracked from">Scribe</Link>
                    )}
                    {entry.notes && <div className="cc-small cc-muted">{entry.notes}</div>}
                  </td>
                  <td className="cc-small">{describeRule(entry.rule)}</td>
                  <td className="cc-nowrap">{formatTimes(entry.startTime, entry.endTime)}</td>
                  <td className="cc-nowrap">
                    {formatOccurrence({ date: now.date, endDate: now.endDate })}
                    {now.overridden && <span className="cc-tag" title={entry.overrides?.[String(year)]?.note || ''}>Moved</span>}
                  </td>
                  <td className="cc-nowrap">
                    {formatOccurrence({ date: next.date, endDate: next.endDate })}
                    {next.overridden && <span className="cc-tag" title={entry.overrides?.[String(year + 1)]?.note || ''}>Moved</span>}
                  </td>
                  {canEditAll && (
                    <td>
                      <div className="cc-row-actions">
                        {confirmDeleteId === entry.id ? (
                          <>
                            <button type="button" className="cc-btn cc-btn--danger cc-btn--small" onClick={() => remove(entry)}>Delete</button>
                            <button type="button" className="cc-btn cc-btn--ghost cc-btn--small" onClick={() => setConfirmDeleteId(null)}>Keep</button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="cc-btn cc-btn--small" onClick={() => setEditing({ entry })}>Edit</button>
                            <button type="button" className="cc-btn cc-btn--ghost cc-btn--small" onClick={() => setConfirmDeleteId(entry.id)} aria-label={`Delete ${entry.name}`}>Delete</button>
                          </>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <AnnualDateFormModal
          entry={editing.entry}
          year={year}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </section>
  );
};

export default AnnualDatesTab;
