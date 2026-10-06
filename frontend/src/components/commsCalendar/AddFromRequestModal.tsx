import React, { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { commsCalendarService } from '../../services/commsCalendarService';
import { CommsCalendarEntry } from '../../types/commsCalendar';
import { ContentSubmission } from '../../types/content';

interface AddFromRequestModalProps {
  entries: CommsCalendarEntry[];
  submissions: ContentSubmission[];
  onClose: () => void;
  onAdded: (entry: CommsCalendarEntry) => void;
}

/**
 * Add a Scribe request to the calendar. Sent announcements are added on their own; this is
 * for the rest (Newsletter items, things sent another way).
 */
export const AddFromRequestModal: React.FC<AddFromRequestModalProps> = ({ entries, submissions, onClose, onAdded }) => {
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const linked = new Set(entries.map((e) => e.submissionId).filter(Boolean));
    const term = search.trim().toLowerCase();
    return submissions
      .filter((s) => (s.status === 'approved' || s.status === 'sent') && !linked.has(s.id))
      .filter((s) => !term || (s.title || '').toLowerCase().includes(term))
      .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
  }, [entries, submissions, search]);

  const add = async (submission: ContentSubmission) => {
    setBusyId(submission.id);
    setError(null);
    try {
      onAdded(await commsCalendarService.fromSubmission(submission.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add it');
      setBusyId(null);
    }
  };

  return (
    <Modal title="Add from a request" onClose={onClose}>
      {error && <div className="cc-error" role="alert">{error}</div>}
      <input
        className="cc-search"
        placeholder="Search approved and sent requests"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search requests"
        autoFocus
      />
      {candidates.length === 0 ? (
        <p className="cc-muted">No approved or sent requests left to add.</p>
      ) : (
        <ul className="cc-picklist">
          {candidates.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => add(s)} disabled={busyId !== null}>
                <span className="cc-picklist__title">{s.title || 'Untitled'}</span>
                <span className="cc-muted">
                  {s.status === 'sent' ? 'Sent' : 'Approved'}
                  {busyId === s.id ? ' · Adding…' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
};

export default AddFromRequestModal;
