import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { annualDatesService } from '../../services/annualDatesService';
import { commsCalendarService } from '../../services/commsCalendarService';
import { CommsCalendarEntry } from '../../types/commsCalendar';
import { DateLink } from '../../types/annualDates';
import DatesPanel, { DateSource } from '../dates/DatesPanel';
import { useAnnualDates } from '../dates/useAnnualDates';
import { buildDateGroups } from '../dates/dateGroups';
import { blockTextFromLexical, isLexicalJson } from '../../utils/lexicalUtils';

interface RequestDatesModalProps {
  entry: CommsCalendarEntry;
  /** The next occurrence on or after this is what the text should show (Coming up: the date it's due again). */
  referenceYmd: string;
  canEdit: boolean;
  onClose: () => void;
  /** The entry with its new links (document entries keep their links on the entry). */
  onEntryChange?: (entry: CommsCalendarEntry) => void;
}

/**
 * "Dates in this request" for a calendar entry: its own document text (pasted or imported) when it
 * has one, else its Scribe request's text and blurb. Track, link or track all from the Comms
 * Calendar. Rewriting a request's text happens on its review page (a tracked change); a document is
 * last year's message, so its dates are only compared, never rewritten.
 */
export const RequestDatesModal: React.FC<RequestDatesModalProps> = ({ entry, referenceYmd, canEdit, onClose, onEntryChange }) => {
  const fromDocument = !!entry.documentText;
  const submissionId = fromDocument ? undefined : entry.submissionId;
  const [sources, setSources] = useState<DateSource[] | null>(
    fromDocument ? [{ field: 'body', label: 'the message', text: entry.documentText! }] : null,
  );
  const [links, setLinks] = useState<DateLink[]>(fromDocument ? entry.dateLinks || [] : []);
  const [error, setError] = useState<string | null>(null);
  const annualDates = useAnnualDates();

  useEffect(() => {
    if (!submissionId) return undefined;
    let cancelled = false;
    annualDatesService.getSubmission(submissionId)
      .then((loaded) => {
        if (cancelled) return;
        const body = loaded.proposedVersions?.richTextContent || loaded.richTextContent || loaded.content || '';
        const blurb = loaded.newsletter?.blurb || '';
        setSources([
          { field: 'body', label: 'the text', text: isLexicalJson(body) ? blockTextFromLexical(body) : body },
          ...(blurb ? [{ field: 'blurb' as const, label: 'the blurb', text: blockTextFromLexical(blurb) }] : []),
        ]);
        setLinks(loaded.dateLinks || []);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [submissionId]);

  const hasDates = useMemo(
    () => links.length > 0 || (!!sources && buildDateGroups(sources, [], referenceYmd, []).groups.length > 0),
    [sources, links, referenceYmd],
  );

  const saveLinks = async (next: DateLink[]) => {
    const previous = links;
    setLinks(next);
    setError(null);
    try {
      if (submissionId) {
        await annualDatesService.saveDateLinks(submissionId, next);
      } else {
        onEntryChange?.(await commsCalendarService.update(entry.id, { dateLinks: next }));
      }
    } catch (err) {
      setLinks(previous);
      setError(err instanceof Error ? err.message : 'Could not save the linked dates');
    }
  };

  return (
    <Modal
      title={`Dates in “${entry.subject}”`}
      onClose={onClose}
      wide
      footer={(
        <>
          {submissionId && (
            <a className="cc-btn cc-btn--ghost" href={`/tracked-changes/${encodeURIComponent(submissionId)}`}>Open the request</a>
          )}
          {!submissionId && entry.link && (
            <a className="cc-btn cc-btn--ghost" href={entry.link} target="_blank" rel="noopener noreferrer">Open the message</a>
          )}
          <button type="button" className="cc-btn cc-btn--primary" onClick={onClose}>Done</button>
        </>
      )}
    >
      {error && <div className="cc-error" role="alert">{error}</div>}
      {!sources && !error && <div className="cc-empty">Loading…</div>}
      {sources && (
        <DatesPanel
          sources={sources}
          links={links}
          onLinksChange={saveLinks}
          referenceYmd={referenceYmd}
          annualDates={annualDates.entries}
          onAnnualDateAdded={annualDates.added}
          updateHref={submissionId ? `/tracked-changes/${encodeURIComponent(submissionId)}` : undefined}
          submissionId={submissionId}
          disabled={!canEdit}
          title={submissionId ? 'Dates in this request' : 'Dates in this message'}
        />
      )}
      {sources && !hasDates && <div className="cc-empty">No dates found in this message.</div>}
    </Modal>
  );
};

export default RequestDatesModal;
