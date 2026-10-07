import React, { useState } from 'react';
import { Modal } from '../commsCalendar/Modal';
import { annualDatesService } from '../../services/annualDatesService';
import { AnnualDate, AnnualDateRule } from '../../types/annualDates';
import { suggestDateName } from '../../utils/dateDetection';
import { daysBetween, describeRule, formatOccurrence, resolveAnnualDate, ruleFromDate } from '../../utils/annualDates';
import { bestMention, DateGroup } from './dateGroups';
import '../../pages/CommsCalendar.css';
import './Dates.css';

interface TrackAllModalProps {
  /** The groups not yet linked (untracked, or looking like an annual date). */
  groups: DateGroup[];
  submissionId?: string;
  onClose: () => void;
  /**
   * Each included group with the annual date it now follows (new or existing). `error` when adding
   * stopped part way: the pairs are the ones made before it.
   */
  onDone: (pairs: Array<{ group: DateGroup; entry: AnnualDate }>, created: AnnualDate[], error?: string) => void;
}

interface RowState {
  include: boolean;
  /** Link to the annual date it looks like, or add a new one. */
  linkTo: string | null;
  name: string;
  kind: AnnualDateRule['kind'];
}

/** Track every date in a request at once: a name and rule for each (Labor Day by default), or a link. */
export const TrackAllModal: React.FC<TrackAllModalProps> = ({ groups, submissionId, onClose, onDone }) => {
  const [rows, setRows] = useState<Record<string, RowState>>(() => Object.fromEntries(groups.map((group) => {
    const best = bestMention(group);
    return [group.key, {
      include: true,
      linkTo: group.matches[0]?.id ?? null,
      name: suggestDateName(best.source.text, best.found),
      kind: 'laborDay' as const,
    }];
  })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: string, patch: Partial<RowState>) => setRows({ ...rows, [key]: { ...rows[key], ...patch } });
  const included = groups.filter((g) => rows[g.key].include);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation(); // React bubbles through the portal to a form this dialog was opened from
    const unnamed = included.find((g) => !rows[g.key].linkTo && !rows[g.key].name.trim());
    if (unnamed) {
      setError(`Give ${formatOccurrence({ date: unnamed.date, endDate: unnamed.endDate })} a name`);
      return;
    }
    setSaving(true);
    setError(null);
    const pairs: Array<{ group: DateGroup; entry: AnnualDate }> = [];
    const created: AnnualDate[] = [];
    try {
      for (const group of included) {
        const row = rows[group.key];
        const existing = row.linkTo ? group.matches.find((e) => e.id === row.linkTo) : undefined;
        if (existing) {
          pairs.push({ group, entry: existing });
          continue;
        }
        const best = bestMention(group);
        const entry = await annualDatesService.create({
          name: row.name.trim(),
          rule: ruleFromDate(group.date, row.kind),
          ...(group.endDate ? { durationDays: daysBetween(group.date, group.endDate) } : {}),
          ...(best.found.startTime ? { startTime: best.found.startTime } : {}),
          ...(best.found.endTime ? { endTime: best.found.endTime } : {}),
          createdFrom: { submissionId: submissionId || '', text: best.found.text },
        });
        created.push(entry);
        pairs.push({ group, entry });
      }
      onDone(pairs, created);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (pairs.length) {
        // Link what was made before the failure, so nothing is left unlinked
        onDone(pairs, created, message);
        return;
      }
      setError(message);
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Track all the dates in this request"
      onClose={onClose}
      wide
      footer={(
        <>
          <button type="button" className="cc-btn cc-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" form="track-all-form" className="cc-btn cc-btn--primary" disabled={saving || !included.length}>
            {saving ? 'Saving…' : `Track ${included.length} date${included.length === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    >
      <form id="track-all-form" onSubmit={save}>
        {error && <div className="cc-error" role="alert">{error}</div>}
        <p className="cc-muted cc-small dt-all-intro">
          Each date is added to the annual dates table and every mention of it in this request is linked. Dates
          are counted from Labor Day unless you pick “Same date”.
        </p>
        <ul className="dt-all-list">
          {groups.map((group) => {
            const row = rows[group.key];
            const best = bestMention(group);
            const rule = ruleFromDate(group.date, row.kind);
            const next = resolveAnnualDate({ rule, startTime: best.found.startTime, endTime: best.found.endTime }, Number(group.date.slice(0, 4)) + 1);
            const match = group.matches.find((e) => e.id === row.linkTo);
            return (
              <li key={group.key} className={`dt-all-row${row.include ? '' : ' dt-all-row--off'}`} data-testid="track-all-row">
                <label className="dt-all-include">
                  <input type="checkbox" checked={row.include} onChange={(e) => set(group.key, { include: e.target.checked })} />
                  <strong>{formatOccurrence({ date: group.date, endDate: group.endDate, startTime: best.found.startTime, endTime: best.found.endTime })}</strong>
                  {group.mentions.length > 1 && <span className="cc-muted cc-small"> · {group.mentions.length} mentions</span>}
                </label>
                {row.include && (
                  <div className="dt-all-fields">
                    {group.matches.length > 0 && (
                      <select
                        value={row.linkTo ?? ''}
                        onChange={(e) => set(group.key, { linkTo: e.target.value || null })}
                        aria-label="Link or add"
                      >
                        {group.matches.map((e) => <option key={e.id} value={e.id}>Link to {e.name}</option>)}
                        <option value="">Add a new annual date</option>
                      </select>
                    )}
                    {match ? (
                      <span className="cc-muted cc-small">{describeRule(match.rule)}</span>
                    ) : (
                      <>
                        <input
                          value={row.name}
                          onChange={(e) => set(group.key, { name: e.target.value })}
                          placeholder="Name"
                          aria-label="Name"
                          maxLength={200}
                        />
                        <select
                          value={row.kind}
                          onChange={(e) => set(group.key, { kind: e.target.value as AnnualDateRule['kind'] })}
                          aria-label="Each year it falls"
                        >
                          <option value="laborDay">{describeRule(ruleFromDate(group.date, 'laborDay'))}</option>
                          <option value="fixed">{describeRule(ruleFromDate(group.date, 'fixed'))}</option>
                        </select>
                        <span className="cc-muted cc-small">Next year: {formatOccurrence(next)}</span>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </form>
    </Modal>
  );
};

export default TrackAllModal;
