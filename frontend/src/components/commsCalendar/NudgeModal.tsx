import React, { useState } from 'react';
import { Modal } from './Modal';
import { commsCalendarService } from '../../services/commsCalendarService';
import { CommsCalendarEntry } from '../../types/commsCalendar';
import { formatShortDate, isValidEmail, splitEmails } from '../../utils/commsCalendar';

interface NudgeModalProps {
  entry: CommsCalendarEntry;
  /** When it's due this year, going by last year's date. */
  anniversary?: string;
  onClose: () => void;
  onSent: (entry: CommsCalendarEntry) => void;
}

/** Ask the team whether they want to send last year's communication again. */
export const NudgeModal: React.FC<NudgeModalProps> = ({ entry, anniversary, onClose, onSent }) => {
  const [to, setTo] = useState(entry.contactEmails.join(', '));
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastNudge = entry.nudges[entry.nudges.length - 1];

  const send = async () => {
    const recipients = splitEmails(to);
    const bad = recipients.find((e) => !isValidEmail(e));
    if (recipients.length === 0) {
      setError('Add at least one email address');
      return;
    }
    if (bad) {
      setError(`Not an email address: ${bad}`);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const result = await commsCalendarService.nudge(entry.id, recipients, note.trim() || undefined);
      onSent(result.entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the nudge');
      setSending(false);
    }
  };

  return (
    <Modal
      title="Nudge the team"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="cc-btn cc-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="cc-btn cc-btn--primary" onClick={send} disabled={sending}>
            {sending ? 'Sending…' : 'Send nudge'}
          </button>
        </>
      )}
    >
      <div className="cc-form">
        {error && <div className="cc-error" role="alert">{error}</div>}
        {lastNudge && (
          <p className="cc-muted cc-field--full">
            Already nudged {formatShortDate(lastNudge.at.slice(0, 10), true)} by {lastNudge.byName}.
          </p>
        )}
        <label className="cc-field cc-field--full">
          <span>To</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} aria-label="Recipients" />
          <small>Replies come back to you.</small>
        </label>
        <label className="cc-field cc-field--full">
          <span>Note (optional)</span>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} aria-label="Note" />
        </label>
        <div className="cc-preview cc-field--full">
          <div className="cc-preview__subject">Planning ahead: "{entry.subject}" for this year?</div>
          <p>
            Reminds {entry.team || 'the team'} that they sent this
            {entry.dateSent || entry.targetDate ? ` around ${formatShortDate(entry.dateSent || entry.targetDate, true)}` : ' last year'}
            {anniversary ? `, suggests ${formatShortDate(anniversary, true)} this year,` : ''} and links to the Comms Request form.
          </p>
        </div>
      </div>
    </Modal>
  );
};

export default NudgeModal;
