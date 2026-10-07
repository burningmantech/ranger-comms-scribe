import React, { useEffect, useMemo, useState } from 'react';
import { AnnualDate, DateLink } from '../../types/annualDates';
import { dateSnippet, rewriteDate, suggestDateName } from '../../utils/dateDetection';
import { describeRule, formatOccurrence, formatTimes, occurrenceOn, nextOccurrence } from '../../utils/annualDates';
import TrackDateModal from './TrackDateModal';
import TrackAllModal from './TrackAllModal';
import { bestMention, buildDateGroups, DateGroup, DateSource, Mention } from './dateGroups';
import './Dates.css';

export type { DateSource } from './dateGroups';

interface DatesPanelProps {
  sources: DateSource[];
  links: DateLink[];
  onLinksChange: (next: DateLink[]) => void;
  /** Publish By, else today: the next occurrence on or after this is the one the text should show. */
  referenceYmd: string;
  annualDates: AnnualDate[];
  onAnnualDateAdded: (entry: AnnualDate) => void;
  /**
   * Replace the `occurrence`th (from 0) `search` in a field with `replacement`; false when it isn't
   * there any more. Without it (outside the request's own pages) out-of-date text links to `updateHref`.
   */
  onReplaceText?: (field: DateLink['field'], search: string, replacement: string, occurrence: number) => Promise<boolean>;
  /** Where to update the text when it can't be changed here (the review page). */
  updateHref?: string;
  /** Scroll the text to a mention (the review editor); without it, mentions aren't clickable. */
  onShowMention?: (mention: Mention) => void;
  /** A group to bring into view and highlight (a bubble in the text was clicked). */
  focusKey?: string | null;
  submissionId?: string;
  disabled?: boolean;
  /** "Dates in this request" unless it's something else (a calendar entry's message). */
  title?: string;
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

const SNIPPETS_SHOWN = 2;

/** The distinct texts (per field) of a group's mentions. */
function distinctTexts(group: DateGroup): Mention[] {
  const seen = new Set<string>();
  return group.mentions.filter((m) => {
    const key = `${m.source.field}|${m.found.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const groupElementId = (key: string) => `date-group-${key.replace(/[^\w-]/g, '_')}`;

/**
 * "Dates in this request": the dates found in the text and blurb, one row per date with every place
 * it is mentioned. A date can be tracked as an annual date (same date every year, or from Labor Day),
 * linked to one already in the table, and updated everywhere it is mentioned when the table or the
 * year says it should now be a different date. Nothing changes without a click.
 */
export const DatesPanel: React.FC<DatesPanelProps> = ({
  sources, links, onLinksChange, referenceYmd, annualDates, onAnnualDateAdded, onReplaceText, updateHref, onShowMention,
  focusKey, submissionId, disabled, title = 'Dates in this request',
}) => {
  const [tracking, setTracking] = useState<DateGroup | null>(null);
  const [trackingAll, setTrackingAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { groups, orphanLinks } = useMemo(
    () => buildDateGroups(sources, links, referenceYmd, annualDates),
    [sources, links, referenceYmd, annualDates],
  );

  useEffect(() => {
    if (!focusKey) return;
    document.getElementById(groupElementId(focusKey))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusKey]);

  if (!groups.length && !orphanLinks.length) return null;

  /** Link every mention of each group to its annual date (one link per distinct text), in one save. */
  const linkGroups = (pairs: Array<{ group: DateGroup; entry: AnnualDate }>) => {
    const texts = pairs.flatMap(({ group, entry }) => {
      const occurrence = occurrenceOn(entry, group.date) || nextOccurrence(entry, group.date);
      return distinctTexts(group).map((m) => ({ m, entry, year: occurrence.year }));
    });
    const keep = links.filter((l) => !texts.some(({ m }) => m.source.field === l.field && m.found.text === l.text));
    onLinksChange([
      ...keep,
      ...texts.map(({ m, entry, year }) => ({ id: newId(), annualDateId: entry.id, field: m.source.field, text: m.found.text, year })),
    ]);
  };
  const linkGroup = (group: DateGroup, entry: AnnualDate) => linkGroups([{ group, entry }]);
  const unlinked = groups.filter((g) => g.status === 'untracked' || g.status === 'match');

  const unlinkGroup = (group: DateGroup) => {
    const ids = new Set(group.mentions.map((m) => m.link?.id).filter(Boolean));
    onLinksChange(links.filter((l) => !ids.has(l.id)));
  };

  /** Rewrite every mention to the group's target date, last first so earlier ones keep their place. */
  const update = async (group: DateGroup) => {
    if (!onReplaceText) return;
    const target = group.target!;
    setBusy(group.key);
    setMessage(null);
    const rewritten = new Map<string, string>();
    const missed: string[] = [];
    let timesDiffer = false;
    try {
      const order = [...group.mentions].sort((a, b) => (a.source.field === b.source.field
        ? b.found.index - a.found.index
        : a.source.field.localeCompare(b.source.field)));
      for (const mention of order) {
        const rewrite = rewriteDate(mention.found, target);
        if (!rewrite) {
          missed.push(mention.found.text);
          continue;
        }
        timesDiffer = timesDiffer || rewrite.timesDiffer;
        if (await onReplaceText(mention.source.field, mention.found.text, rewrite.text, mention.occurrence)) {
          rewritten.set(`${mention.source.field}|${mention.found.text}`, rewrite.text);
        } else {
          missed.push(mention.found.text);
        }
      }
      if (rewritten.size) {
        const keep = links.filter((l) => !group.mentions.some((m) => m.link?.id === l.id));
        const entryId = group.entry!.id;
        onLinksChange([
          ...keep,
          ...Array.from(rewritten.entries()).map(([key, text]) => ({
            id: newId(), annualDateId: entryId, field: key.split('|')[0] as DateLink['field'], text, year: target.year,
          })),
        ]);
      }
      const notes: string[] = [];
      if (missed.length) notes.push(`Couldn't change “${missed.join('”, “')}”: edit by hand.`);
      if (timesDiffer) notes.push(`The times are now ${formatTimes(target.startTime, target.endTime)}: change them by hand.`);
      if (notes.length) setMessage(notes.join(' '));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  };

  const renderMention = (mention: Mention) => {
    const snippet = dateSnippet(mention.source.text, mention.found);
    const content = (
      <>
        {snippet.before}<mark className="dt-mark">{snippet.match}</mark>{snippet.after}
        {sources.length > 1 && <span className="cc-muted cc-small"> ({mention.source.label})</span>}
      </>
    );
    return (
      <li key={mention.key} className="dt-mention">
        {onShowMention && mention.source.field === 'body' ? (
          <button type="button" className="dt-mention-link" onClick={() => onShowMention(mention)} title="Show in the text">
            {content}
          </button>
        ) : content}
      </li>
    );
  };

  const renderActions = (group: DateGroup) => {
    switch (group.status) {
      case 'ok':
      case 'stale':
        return (
          <>
            <span className="dt-entry">
              <i className="fas fa-link" aria-hidden="true" /> <strong>{group.entry!.name}</strong>
              <span className="cc-muted"> · {describeRule(group.entry!.rule)}{group.target!.overridden ? ' (moved this year)' : ''}</span>
            </span>
            {group.status === 'stale' ? (
              <span className="dt-status dt-status--stale">
                {group.target!.year}: {formatOccurrence(group.target!)}
                {onReplaceText ? (
                  <button
                    type="button"
                    className="cc-btn cc-btn--small cc-btn--primary"
                    onClick={() => update(group)}
                    disabled={disabled || busy === group.key}
                  >
                    {busy === group.key ? 'Updating…' : group.mentions.length > 1 ? `Update all ${group.mentions.length}` : 'Update text'}
                  </button>
                ) : updateHref && (
                  <a className="cc-btn cc-btn--small" href={updateHref}>Update in the request</a>
                )}
              </span>
            ) : (
              <span className="dt-status dt-status--ok"><i className="fas fa-check" aria-hidden="true" /> Right for {group.target!.year}</span>
            )}
            <button type="button" className="cc-btn cc-btn--small cc-btn--ghost" onClick={() => unlinkGroup(group)} disabled={disabled}>Unlink</button>
          </>
        );
      case 'gone':
        return (
          <>
            <span className="dt-status dt-status--gone">The annual date it was linked to was deleted.</span>
            <button type="button" className="cc-btn cc-btn--small cc-btn--ghost" onClick={() => unlinkGroup(group)} disabled={disabled}>Unlink</button>
          </>
        );
      default:
        return (
          <>
            {group.matches.slice(0, 2).map((entry) => (
              <span key={entry.id} className="dt-match">
                Looks like <strong>{entry.name}</strong>
                <button type="button" className="cc-btn cc-btn--small" onClick={() => linkGroup(group, entry)} disabled={disabled}>Link</button>
              </span>
            ))}
            <button type="button" className="cc-btn cc-btn--small" onClick={() => setTracking(group)} disabled={disabled}>
              Track every year…
            </button>
          </>
        );
    }
  };

  return (
    <section className="dt-panel" aria-label={title}>
      <h4 className="dt-title"><i className="far fa-calendar-alt" aria-hidden="true" /> {title}</h4>
      <p className="dt-intro cc-muted">
        Track a date to keep it in the annual dates table. Next year (or when the table changes) you can update every
        mention of it here in one click.
      </p>
      {message && <div className="dt-message" role="status">{message}</div>}
      {unlinked.length > 1 && !disabled && (
        <div className="dt-all-bar">
          <button type="button" className="cc-btn cc-btn--small cc-btn--primary" onClick={() => setTrackingAll(true)}>
            Track all {unlinked.length} dates…
          </button>
        </div>
      )}
      <ul className="dt-list">
        {groups.map((group) => {
          const best = bestMention(group).found;
          const shown = expanded.has(group.key) ? group.mentions : group.mentions.slice(0, SNIPPETS_SHOWN);
          return (
            <li
              key={group.key}
              id={groupElementId(group.key)}
              className={`dt-row dt-row--${group.status}${focusKey === group.key ? ' dt-row--focus' : ''}`}
              data-testid="date-row"
            >
              <div className="dt-head">
                <span className={`dt-dot dt-dot--${group.status}`} aria-hidden="true" />
                <strong>{formatOccurrence({ date: group.date, endDate: group.endDate, startTime: best.startTime, endTime: best.endTime })}</strong>
                {group.mentions.length > 1 && <span className="cc-muted cc-small">{group.mentions.length} mentions</span>}
              </div>
              <ul className="dt-mentions">
                {shown.map(renderMention)}
              </ul>
              {group.mentions.length > SNIPPETS_SHOWN && (
                <button type="button" className="dt-more" onClick={() => toggle(group.key)}>
                  {expanded.has(group.key) ? 'Show fewer' : `Show all ${group.mentions.length}`}
                </button>
              )}
              <div className="dt-actions">{renderActions(group)}</div>
            </li>
          );
        })}
        {orphanLinks.map((link) => (
          <li key={link.id} className="dt-row" data-testid="date-row">
            <span className="dt-found">
              <q>{link.text}</q>
              <span className="cc-muted cc-small"> is no longer in {sources.find((s) => s.field === link.field)?.label || 'the request'}</span>
            </span>
            <span className="dt-actions">
              <button
                type="button"
                className="cc-btn cc-btn--small cc-btn--ghost"
                onClick={() => onLinksChange(links.filter((l) => l.id !== link.id))}
                disabled={disabled}
              >
                Unlink
              </button>
            </span>
          </li>
        ))}
      </ul>
      {trackingAll && (
        <TrackAllModal
          groups={unlinked}
          submissionId={submissionId}
          onClose={() => setTrackingAll(false)}
          onDone={(pairs, created, error) => {
            created.forEach(onAnnualDateAdded);
            linkGroups(pairs);
            setTrackingAll(false);
            if (error) setMessage(`Tracked ${pairs.length} dates, then stopped: ${error}`);
          }}
        />
      )}
      {tracking && (
        <TrackDateModal
          found={bestMention(tracking).found}
          defaultName={suggestDateName(bestMention(tracking).source.text, bestMention(tracking).found)}
          submissionId={submissionId}
          onClose={() => setTracking(null)}
          onSaved={(entry) => {
            onAnnualDateAdded(entry);
            linkGroup(tracking, entry);
            setTracking(null);
          }}
        />
      )}
    </section>
  );
};

export default DatesPanel;
