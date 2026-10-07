import React, { useMemo, useState } from 'react';
import { Modal } from '../commsCalendar/Modal';
import { annualDatesService } from '../../services/annualDatesService';
import { AnnualDate, AnnualDateRule } from '../../types/annualDates';
import { DetectedDate } from '../../utils/dateDetection';
import {
  daysBetween, describeRule, formatOccurrence, resolveAnnualDate, ruleFromDate,
} from '../../utils/annualDates';
import '../../pages/CommsCalendar.css';
import './Dates.css';

interface TrackDateModalProps {
  found: DetectedDate;
  defaultName: string;
  submissionId?: string;
  onClose: () => void;
  onSaved: (entry: AnnualDate) => void;
}

type Unit = 'days' | 'weeks';

/** Add a date found in a request to the annual dates table: same date every year, or from Labor Day. */
export const TrackDateModal: React.FC<TrackDateModalProps> = ({ found, defaultName, submissionId, onClose, onSaved }) => {
  const fromLaborDay = ruleFromDate(found.date, 'laborDay') as Extract<AnnualDateRule, { kind: 'laborDay' }>;
  const initialOffset = fromLaborDay.offsetDays;
  const initialUnit: Unit = initialOffset !== 0 && initialOffset % 7 === 0 ? 'weeks' : 'days';

  const [name, setName] = useState(defaultName);
  const [kind, setKind] = useState<AnnualDateRule['kind']>('laborDay');
  const [amount, setAmount] = useState(String(Math.abs(initialUnit === 'weeks' ? initialOffset / 7 : initialOffset)));
  const [unit, setUnit] = useState<Unit>(initialUnit);
  const [direction, setDirection] = useState<'before' | 'after'>(initialOffset < 0 ? 'before' : 'after');
  const [startTime, setStartTime] = useState(found.startTime || '');
  const [endTime, setEndTime] = useState(found.endTime || '');
  const [durationDays, setDurationDays] = useState(found.endDate ? String(daysBetween(found.date, found.endDate)) : '0');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rule: AnnualDateRule | null = useMemo(() => {
    if (kind === 'fixed') return ruleFromDate(found.date, 'fixed');
    const n = Number(amount);
    if (!Number.isInteger(n) || n < 0) return null;
    const days = (unit === 'weeks' ? n * 7 : n) * (direction === 'before' ? -1 : 1);
    return { kind: 'laborDay', offsetDays: days };
  }, [kind, amount, unit, direction, found.date]);

  const draft = rule && {
    rule,
    durationDays: Number(durationDays) || undefined,
    startTime: startTime || undefined,
    endTime: endTime || undefined,
  };
  const year = Number(found.date.slice(0, 4));
  const preview = draft ? [year, year + 1, year + 2].map((y) => ({ y, occurrence: resolveAnnualDate(draft, y) })) : [];
  const matchesWritten = !!draft && preview[0].occurrence.date === found.date;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation(); // React bubbles through the portal to a form this dialog was opened from
    if (!rule) {
      setError('Enter a whole number of days or weeks');
      return;
    }
    if (!name.trim()) {
      setError('Give it a name');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const entry = await annualDatesService.create({
        name: name.trim(),
        rule,
        ...(Number(durationDays) ? { durationDays: Number(durationDays) } : {}),
        ...(startTime ? { startTime } : {}),
        ...(endTime ? { endTime } : {}),
        createdFrom: { submissionId: submissionId || '', text: found.text },
      });
      onSaved(entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Track this date every year"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="cc-btn cc-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" form="track-date-form" className="cc-btn cc-btn--primary" disabled={saving}>
            {saving ? 'Saving…' : 'Track it'}
          </button>
        </>
      )}
    >
      <form id="track-date-form" className="cc-form" onSubmit={save}>
        {error && <div className="cc-error" role="alert">{error}</div>}
        <p className="cc-field--full dt-found">
          Found <q>{found.text}</q>: {formatOccurrence(found)}
        </p>
        <label className="cc-field cc-field--full">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ranger Social" maxLength={200} autoFocus />
        </label>
        <fieldset className="cc-field cc-field--full dt-rule">
          <span>Each year it falls</span>
          <label className="dt-choice">
            <input type="radio" name="dt-kind" checked={kind === 'fixed'} onChange={() => setKind('fixed')} />
            On the same date ({describeRule(ruleFromDate(found.date, 'fixed'))})
          </label>
          <label className="dt-choice">
            <input type="radio" name="dt-kind" checked={kind === 'laborDay'} onChange={() => setKind('laborDay')} />
            Relative to Labor Day (the Man burns the Saturday before)
          </label>
          {kind === 'laborDay' && (
            <div className="dt-offset">
              <input
                type="number"
                min={0}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-label="How many"
              />
              <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)} aria-label="Days or weeks">
                <option value="days">days</option>
                <option value="weeks">weeks</option>
              </select>
              <select value={direction} onChange={(e) => setDirection(e.target.value as 'before' | 'after')} aria-label="Before or after">
                <option value="before">before</option>
                <option value="after">after</option>
              </select>
              <span>Labor Day</span>
            </div>
          )}
          {rule && <small>{describeRule(rule)}</small>}
        </fieldset>
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
          <small>0 for a single day</small>
        </label>
        <div className="cc-field cc-field--full">
          <span>Coming years</span>
          <ul className="dt-preview">
            {preview.map(({ y, occurrence }) => <li key={y}><strong>{y}</strong> {formatOccurrence(occurrence)}</li>)}
          </ul>
          {draft && !matchesWritten && (
            <small className="dt-warn">This rule doesn't land on the date as written ({found.date}).</small>
          )}
        </div>
      </form>
    </Modal>
  );
};

export default TrackDateModal;
