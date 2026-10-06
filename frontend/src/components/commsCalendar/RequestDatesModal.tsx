import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { annualDatesService } from '../../services/annualDatesService';
import { ContentSubmission } from '../../types/content';
import { DateLink } from '../../types/annualDates';
import DatesPanel, { DateSource } from '../dates/DatesPanel';
import { useAnnualDates } from '../dates/useAnnualDates';
import { buildDateGroups } from '../dates/dateGroups';
import { blockTextFromLexical, isLexicalJson } from '../../utils/lexicalUtils';

interface RequestDatesModalProps {
  submissionId: string;
  subject: string;
  /** The next occurrence on or after this is what the text should show (Coming up: the date it's due again). */
  referenceYmd: string;
  canEdit: boolean;
  onClose: () => void;
}

/**
 * "Dates in this request" for a calendar entry's Scribe request: track, link or import its dates
 * from the Comms Calendar. Rewriting the text happens on the request's review page (a tracked change).
 */
export const RequestDatesModal: React.FC<RequestDatesModalProps> = ({ submissionId, subject, referenceYmd, canEdit, onClose }) => {
  const [submission, setSubmission] = useState<ContentSubmission | null>(null);
  const [links, setLinks] = useState<DateLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const annualDates = useAnnualDates();

  useEffect(() => {
    let cancelled = false;
    annualDatesService.getSubmission(submissionId)
      .then((loaded) => {
        if (cancelled) return;
        setSubmission(loaded);
        setLinks(loaded.dateLinks || []);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [submissionId]);

  const sources: DateSource[] = useMemo(() => {
    if (!submission) return [];
    const body = submission.proposedVersions?.richTextContent || submission.richTextContent || submission.content || '';
    const blurb = submission.newsletter?.blurb || '';
    return [
      { field: 'body', label: 'the text', text: isLexicalJson(body) ? blockTextFromLexical(body) : body },
      ...(blurb ? [{ field: 'blurb' as const, label: 'the blurb', text: blockTextFromLexical(blurb) }] : []),
    ];
  }, [submission]);

  const hasDates = useMemo(
    () => links.length > 0 || buildDateGroups(sources, [], referenceYmd, []).groups.length > 0,
    [sources, links, referenceYmd],
  );

  const saveLinks = async (next: DateLink[]) => {
    const previous = links;
    setLinks(next);
    setError(null);
    try {
      await annualDatesService.saveDateLinks(submissionId, next);
    } catch (err) {
      setLinks(previous);
      setError(err instanceof Error ? err.message : 'Could not save the linked dates');
    }
  };

  return (
    <Modal
      title={`Dates in “${subject}”`}
      onClose={onClose}
      wide
      footer={(
        <>
          <a className="cc-btn cc-btn--ghost" href={`/tracked-changes/${encodeURIComponent(submissionId)}`}>Open the request</a>
          <button type="button" className="cc-btn cc-btn--primary" onClick={onClose}>Done</button>
        </>
      )}
    >
      {error && <div className="cc-error" role="alert">{error}</div>}
      {!submission && !error && <div className="cc-empty">Loading…</div>}
      {submission && (
        <DatesPanel
          sources={sources}
          links={links}
          onLinksChange={saveLinks}
          referenceYmd={referenceYmd}
          annualDates={annualDates.entries}
          onAnnualDateAdded={annualDates.added}
          updateHref={`/tracked-changes/${encodeURIComponent(submissionId)}`}
          submissionId={submissionId}
          disabled={!canEdit}
        />
      )}
      {submission && !hasDates && <div className="cc-empty">No dates found in this request's text.</div>}
    </Modal>
  );
};

export default RequestDatesModal;
