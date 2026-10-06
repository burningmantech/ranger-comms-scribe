import React from 'react';
import SaveStatus from './SaveStatus';
import { TransactionManager } from '../services/transactionManager';
import './DocumentViewBar.css';

/**
 * The row above the document in the tracked-changes editor. It replaces the old
 * "Proposed Version / Content Comparison / Original Version / Send" tabs:
 * - the save status (review mode; the standalone editor shows it in its toolbar),
 * - a small, secondary view switch: Proposed (the default, editable view) | Compare |
 *   Original,
 * - a Send button, shown in the same states the Send tab was enabled in (approved,
 *   comms_approved, sent), for every role, as before. It opens the send preview, which
 *   has Copy to Clipboard for everyone and Send Email for Comms Cadre / Admins.
 */

export type DocumentView = 'proposed' | 'comparison' | 'original' | 'send';

const SEND_STATUSES = ['approved', 'comms_approved', 'sent'];

export function canOpenSend(status: string | undefined): boolean {
  return !!status && SEND_STATUSES.includes(status);
}

interface DocumentViewBarProps {
  view: DocumentView;
  onViewChange: (view: DocumentView) => void;
  submissionStatus?: string;
  transactionManager?: TransactionManager;
}

const VIEWS: Array<{ value: Exclude<DocumentView, 'send'>; label: string; title: string }> = [
  { value: 'proposed', label: 'Proposed', title: 'The proposed version (editable)' },
  { value: 'comparison', label: 'Compare', title: 'Compare the proposed version with the original' },
  { value: 'original', label: 'Original', title: 'The original submission' },
];

const DocumentViewBar: React.FC<DocumentViewBarProps> = ({ view, onViewChange, submissionStatus, transactionManager }) => {
  const sendAvailable = canOpenSend(submissionStatus);
  return (
    <div className="document-view-bar">
      <div className="document-view-bar__status">
        {transactionManager && <SaveStatus transactionManager={transactionManager} />}
      </div>
      <div className="document-view-bar__controls">
        <div className="document-view-bar__switch" role="group" aria-label="Document view">
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              className={`document-view-bar__option${view === v.value ? ' document-view-bar__option--active' : ''}`}
              aria-pressed={view === v.value}
              title={v.title}
              onClick={() => onViewChange(v.value)}
            >
              {v.label}
            </button>
          ))}
        </div>
        {sendAvailable && (
          <button
            type="button"
            className={`document-view-bar__send${view === 'send' ? ' document-view-bar__send--active' : ''}`}
            aria-pressed={view === 'send'}
            title={submissionStatus === 'sent' ? 'See what was sent' : 'Preview and send this request'}
            onClick={() => onViewChange('send')}
          >
            <i className="fas fa-paper-plane" aria-hidden="true" />
            Send
          </button>
        )}
      </div>
    </div>
  );
};

export default DocumentViewBar;
