import React, { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { annualDatesService } from '../../services/annualDatesService';
import { AnnualDate, AnnualDateInput, AnnualDateOverride, AnnualDateRule } from '../../types/annualDates';
import { describeRule, formatOccurrence, resolveAnnualDate } from '../../utils/annualDates';

interface AnnualDateFormModalProps {
  /** The entry being edited; absent when adding one. */
  entry?: AnnualDate;
  /** The year the table is showing (first year of the preview). */
  year: number;
  onClose: () => void;
  onSaved: (entry: AnnualDate) => void;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];

interface OverrideRow extends AnnualDateOverride {
  year: string;
}

/** Add or change an annual date: its rule, times, length, and any year it moved. */
export const AnnualDateFormModal: React.FC<AnnualDateFormModalProps> = ({ entry, year, onClose, onSaved }) => {
  const rule = entry?.rule;
  const [name, setName] = useState(entry?.name || '');
  const [kind, setKind] = useState<AnnualDateRule['kind']>(rule?.kind || 'laborDay');
  const [month, setMonth] = useState(rule?.kind === 'fixed' ? rule.month : 9);
  const [day, setDay] = useState(rule?.kind === 'fixed' ? rule.day : 1);
  const [offsetDays, setOffsetDays] = useState(String(rule?.kind === 'laborDay' ? rule.offsetDays : 0));
  const [startTime, setStartTime] = useState(entry?.startTime || '');
  const [endTime, setEndTime] = useState(entry?.endTime || '');
  const [durationDays, setDurationDays] = useState(String(entry?.durationDays || 0));
  const [notes, setNotes] = useState(entry?.notes || '');
  const [link, setLink] = useState(entry?.link || '');
  const [overrides, setOverrides] = useState<OverrideRow[]>(
    Object.entries(entry?.overrides || {}).map(([y, o]) => ({ year: y, ...o })).sort((a, b) => a.year.localeCompare(b.year)),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draftRule: AnnualDateRule | null = useMemo(() => {
    if (kind === 'fixed') return { kind: 'fixed', month, day };
    const n = Number(offsetDays);
    return Number.isInteger(n) ? { kind: 'laborDay', offsetDays: n } : null;
  }, [kind, month, day, offsetDays]);

  const overridesObject = () => Object.fromEntries(overrides
    .filter((o) => o.year && o.date)
    .map(({ year: y, ...o }) => [y, Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as unknown as AnnualDateOverride]));

  const preview = draftRule
    ? [year, year + 1, year + 2].map((y) => ({
      y,
      occurrence: resolveAnnualDate({
        rule: draftRule,
        durationDays: Number(durationDays) || undefined,
        startTime: startTime || undefined,
        endTime: endTime || undefined,
        overrides: overridesObject(),
      }, y),
    }))
    : [];

  const setOverride = (index: number, patch: Partial<OverrideRow>) => {
    setOverrides(overrides.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation(); // React bubbles through the portal to a form this dialog was opened from
    if (!draftRule) {
      setError('Days from Labor Day must be a whole number (negative for before)');
      return;
    }
    const input: AnnualDateInput = {
      name: name.trim(),
      rule: draftRule,
      durationDays: Number(durationDays) || null,
      startTime: startTime || null,
      endTime: endTime || null,
      notes: notes.trim() || null,
      link: link.trim() || null,
      overrides: Object.keys(overridesObject()).length ? overridesObject() : null,
    };
    setSaving(true);
    setError(null);
    try {
      onSaved(entry ? await annualDatesService.update(entry.id, input) : await annualDatesService.create(input));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const daysInMonth = new Date(Date.UTC(2024, month, 0)).getUTCDate();

  return (
    <Modal
      title={entry ? 'Edit annual date' : 'Add annual date'}
      onClose={onClose}
      wide
      footer={(
        <>
          <button type="button" className="cc-btn cc-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" form="annual-date-form" className="cc-btn cc-btn--primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      )}
    >
      <form id="annual-date-form" className="cc-form" onSubmit={save}>
        {error && <div className="cc-error" role="alert">{error}</div>}
        <label className="cc-field cc-field--full">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="e.g. Ranger Social" />
        </label>
        <label className="cc-field">
          <span>Each year it falls</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as AnnualDateRule['kind'])}>
            <option value="laborDay">Relative to Labor Day</option>
            <option value="fixed">On the same date</option>
          </select>
        </label>
        {kind === 'fixed' ? (
          <div className="cc-field">
            <span>Date</span>
            <div className="dt-offset" style={{ marginLeft: 0 }}>
              <select value={month} onChange={(e) => setMonth(Number(e.target.value))} aria-label="Month">
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <select value={Math.min(day, daysInMonth)} onChange={(e) => setDay(Number(e.target.value))} aria-label="Day">
                {Array.from({ length: daysInMonth }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
              </select>
            </div>
          </div>
        ) : (
          <label className="cc-field">
            <span>Days from Labor Day</span>
            <input type="number" value={offsetDays} onChange={(e) => setOffsetDays(e.target.value)} step={1} />
            <small>Negative is before: -2 is the Burn, -8 the Sunday before</small>
          </label>
        )}
        {draftRule && <small className="cc-field--full cc-muted">{describeRule(draftRule)}</small>}
        <label className="cc-field">
          <span>Starts at (optional)</span>
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </label>
        <label className="cc-field">
          <span>Ends at (optional)</span>
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </label>
        <label className="cc-field">
          <span>Lasts (extra days)</span>
          <input type="number" min={0} max={60} value={durationDays} onChange={(e) => setDurationDays(e.target.value)} />
        </label>
        <label className="cc-field">
          <span>Link (optional)</span>
          <input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" />
        </label>
        <label className="cc-field cc-field--full">
          <span>Notes</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div className="cc-field cc-field--full">
          <span>Years it moved</span>
          <small>When one year's date is different from the rule (the event moved), set it here. Linked requests pick it up.</small>
          {overrides.map((o, i) => (
            <div key={i} className="dt-offset" style={{ marginLeft: 0 }}>
              <input aria-label="Year" value={o.year} onChange={(e) => setOverride(i, { year: e.target.value })} placeholder="Year" style={{ maxWidth: 80 }} />
              <input aria-label="Date" type="date" value={o.date} onChange={(e) => setOverride(i, { date: e.target.value })} />
              <input aria-label="End date" type="date" value={o.endDate || ''} onChange={(e) => setOverride(i, { endDate: e.target.value })} />
              <input aria-label="Starts at" type="time" value={o.startTime || ''} onChange={(e) => setOverride(i, { startTime: e.target.value })} />
              <input aria-label="Ends at" type="time" value={o.endTime || ''} onChange={(e) => setOverride(i, { endTime: e.target.value })} />
              <input aria-label="Note" value={o.note || ''} onChange={(e) => setOverride(i, { note: e.target.value })} placeholder="Why" />
              <button type="button" className="cc-btn cc-btn--ghost cc-btn--small" onClick={() => setOverrides(overrides.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="cc-btn cc-btn--small"
              onClick={() => setOverrides([...overrides, { year: String(year), date: preview[0]?.occurrence.date || '' }])}
            >
              + A year it moved
            </button>
          </div>
        </div>
        <div className="cc-field cc-field--full">
          <span>Coming years</span>
          <ul className="dt-preview">
            {preview.map(({ y, occurrence }) => (
              <li key={y}><strong>{y}</strong> {formatOccurrence(occurrence)}{occurrence.overridden ? ' (moved)' : ''}</li>
            ))}
          </ul>
        </div>
      </form>
    </Modal>
  );
};

export default AnnualDateFormModal;
