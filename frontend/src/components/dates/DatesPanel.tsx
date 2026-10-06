import React, { useMemo, useState } from 'react';
import { AnnualDate, DateLink } from '../../types/annualDates';
import { DetectedDate, detectDates, rewriteDate, suggestDateName } from '../../utils/dateDetection';
import {
  describeRule, formatOccurrence, formatTimes, nextOccurrence, occurrenceOn,
} from '../../utils/annualDates';
import TrackDateModal from './TrackDateModal';
import './Dates.css';

export interface DateSource {
  field: DateLink['field'];
  /** "the text", "the blurb" */
  label: string;
  /** Plain text */
  text: string;
}

interface DatesPanelProps {
  sources: DateSource[];
  links: DateLink[];
  onLinksChange: (next: DateLink[]) => void;
  /** Publish By, else today: the next occurrence on or after this is the one the text should show. */
  referenceYmd: string;
  annualDates: AnnualDate[];
  onAnnualDateAdded: (entry: AnnualDate) => void;
  /** Replace `search` in a field with `replacement`; false when it isn't there any more. */
  onReplaceText: (field: DateLink['field'], search: string, replacement: string) => Promise<boolean>;
  submissionId?: string;
  disabled?: boolean;
}

interface Row {
  key: string;
  source: DateSource;
  found: DetectedDate;
  link?: DateLink;
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/** The link for a date found in the text: same field, and the text as written (or one inside the other). */
function linkFor(links: DateLink[], field: DateLink['field'], found: DetectedDate): DateLink | undefined {
  return links.find((l) => l.field === field && l.text === found.text)
    || links.find((l) => l.field === field && (found.text.includes(l.text) || l.text.includes(found.text)));
}

/**
 * "Dates in this request": the dates found in the text and blurb. Each can be tracked as an annual
 * date (same date every year, or from Labor Day), linked to one already in the table, and updated
 * in place when the table or the year says it should now be a different date. Nothing changes
 * without a click.
 */
export const DatesPanel: React.FC<DatesPanelProps> = ({
  sources, links, onLinksChange, referenceYmd, annualDates, onAnnualDateAdded, onReplaceText, submissionId, disabled,
}) => {
  const [tracking, setTracking] = useState<Row | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const rows: Row[] = useMemo(() => sources.flatMap((source) =>
    detectDates(source.text, referenceYmd).map((found, i) => ({
      key: `${source.field}:${i}:${found.text}`,
      source,
      found,
      link: linkFor(links, source.field, found),
    }))), [sources, links, referenceYmd]);

  const usedLinks = new Set(rows.map((r) => r.link?.id).filter(Boolean));
  const orphanLinks = links.filter((l) => !usedLinks.has(l.id));
  const byId = useMemo(() => new Map(annualDates.map((e) => [e.id, e])), [annualDates]);

  if (!rows.length && !orphanLinks.length) return null;

  const addLink = (row: Row, entry: AnnualDate) => {
    const occurrence = occurrenceOn(entry, row.found.date) || nextOccurrence(entry, row.found.date);
    onLinksChange([
      ...links.filter((l) => l.id !== row.link?.id),
      { id: newId(), annualDateId: entry.id, field: row.source.field, text: row.found.text, year: occurrence.year },
    ]);
  };

  const unlink = (id: string) => onLinksChange(links.filter((l) => l.id !== id));

  const update = async (row: Row, entry: AnnualDate) => {
    const target = nextOccurrence(entry, referenceYmd);
    const rewrite = rewriteDate(row.found, target);
    if (!rewrite || !row.link) return;
    setBusy(row.key);
    setMessage(null);
    try {
      const done = await onReplaceText(row.source.field, row.found.text, rewrite.text);
      if (!done) {
        setMessage(`Couldn't find “${row.found.text}” in ${row.source.label} to change it. Edit it by hand.`);
        return;
      }
      onLinksChange(links.map((l) => (l.id === row.link!.id ? { ...l, text: rewrite.text, year: target.year } : l)));
      if (rewrite.timesDiffer) {
        setMessage(`Updated the date. The times are now ${formatTimes(target.startTime, target.endTime)}: change them in ${row.source.label} by hand.`);
      }
    } finally {
      setBusy(null);
    }
  };

  const renderLinked = (row: Row, link: DateLink) => {
    const entry = byId.get(link.annualDateId);
    if (!entry) {
      return (
        <>
          <span className="dt-status dt-status--gone">The annual date it was linked to was deleted.</span>
          <button type="button" className="cc-btn cc-btn--small cc-btn--ghost" onClick={() => unlink(link.id)} disabled={disabled}>Unlink</button>
        </>
      );
    }
    const target = nextOccurrence(entry, referenceYmd);
    const stale = target.date !== row.found.date || (!!target.endDate && target.endDate !== row.found.endDate);
    return (
      <>
        <span className="dt-entry">
          <i className="fas fa-link" aria-hidden="true" /> <strong>{entry.name}</strong>
          <span className="cc-muted"> · {describeRule(entry.rule)}{target.overridden ? ' (moved this year)' : ''}</span>
        </span>
        {stale ? (
          <span className="dt-status dt-status--stale">
            {target.year}: {formatOccurrence(target)}
            <button
              type="button"
              className="cc-btn cc-btn--small cc-btn--primary"
              onClick={() => update(row, entry)}
              disabled={disabled || busy === row.key}
            >
              {busy === row.key ? 'Updating…' : 'Update text'}
            </button>
          </span>
        ) : (
          <span className="dt-status dt-status--ok"><i className="fas fa-check" aria-hidden="true" /> Right for {target.year}</span>
        )}
        <button type="button" className="cc-btn cc-btn--small cc-btn--ghost" onClick={() => unlink(link.id)} disabled={disabled}>Unlink</button>
      </>
    );
  };

  const renderUntracked = (row: Row) => {
    const matches = annualDates.filter((entry) => {
      const occurrence = occurrenceOn(entry, row.found.date);
      if (!occurrence) return false;
      return !row.found.startTime || !occurrence.startTime || occurrence.startTime === row.found.startTime;
    });
    return (
      <>
        {matches.slice(0, 2).map((entry) => (
          <span key={entry.id} className="dt-match">
            Looks like <strong>{entry.name}</strong>
            <button type="button" className="cc-btn cc-btn--small" onClick={() => addLink(row, entry)} disabled={disabled}>Link</button>
          </span>
        ))}
        <button type="button" className="cc-btn cc-btn--small" onClick={() => setTracking(row)} disabled={disabled}>
          Track every year…
        </button>
      </>
    );
  };

  return (
    <section className="dt-panel" aria-label="Dates in this request">
      <h4 className="dt-title"><i className="far fa-calendar-alt" aria-hidden="true" /> Dates in this request</h4>
      <p className="dt-intro cc-muted">
        Track a date to keep it in the annual dates table. Next year (or when the table changes) you can update it here in one click.
      </p>
      {message && <div className="dt-message" role="status">{message}</div>}
      <ul className="dt-list">
        {rows.map((row) => (
          <li key={row.key} className="dt-row" data-testid="date-row">
            <span className="dt-found">
              <q>{row.found.text}</q>
              <span className="cc-muted cc-small"> in {row.source.label}</span>
            </span>
            <span className="dt-actions">{row.link ? renderLinked(row, row.link) : renderUntracked(row)}</span>
          </li>
        ))}
        {orphanLinks.map((link) => (
          <li key={link.id} className="dt-row" data-testid="date-row">
            <span className="dt-found">
              <q>{link.text}</q>
              <span className="cc-muted cc-small"> is no longer in {sources.find((s) => s.field === link.field)?.label || 'the request'}</span>
            </span>
            <span className="dt-actions">
              <button type="button" className="cc-btn cc-btn--small cc-btn--ghost" onClick={() => unlink(link.id)} disabled={disabled}>Unlink</button>
            </span>
          </li>
        ))}
      </ul>
      {tracking && (
        <TrackDateModal
          found={tracking.found}
          defaultName={suggestDateName(tracking.source.text, tracking.found)}
          submissionId={submissionId}
          onClose={() => setTracking(null)}
          onSaved={(entry) => {
            onAnnualDateAdded(entry);
            addLink(tracking, entry);
            setTracking(null);
          }}
        />
      )}
    </section>
  );
};

export default DatesPanel;
