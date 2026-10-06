import React from 'react';
import ConditionsPopover from './ConditionsPopover';
import FinishReviewMenu from './FinishReviewMenu';
import QueueNavigator from './QueueNavigator';
import { ApprovalGates, SubmissionReminder } from '../types/content';
import './ReviewTopBar.css';

interface ReviewTopBarProps {
  submissionId: string;
  title: string;
  submitterName: string;
  submittedAt: Date;
  isUrgent: boolean;
  approvalGates?: ApprovalGates;
  /** Edits still to accept or reject, one per review card (the conditions popover's count). */
  pendingEdits?: number;
  /** Approval reminders sent, and how to send one (omit to hide Remind). */
  reminders?: SubmissionReminder[];
  onRemind?: (target: string) => Promise<SubmissionReminder[]>;
  /** Shows "Finish review" (Approve / Request changes / Decline). */
  canApprove: boolean;
  /** Shows the queue pager (see QueueNavigator). */
  isReviewer: boolean;
  /** The reviewer's current vote on the request, shown on the Finish review button. */
  myDecision?: 'approved' | 'rejected' | null;
  onBack: () => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  /** Declines the whole request. */
  onReject: () => void;
  onNavigate: (submissionId: string) => void;
}

const ReviewTopBar: React.FC<ReviewTopBarProps> = ({
  submissionId,
  title,
  submitterName,
  submittedAt,
  isUrgent,
  approvalGates,
  pendingEdits,
  reminders,
  onRemind,
  canApprove,
  isReviewer,
  myDecision = null,
  onBack,
  onApprove,
  onRequestChanges,
  onReject,
  onNavigate,
}) => {
  const formatDate = (date: Date) => {
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <div className="review-top-bar">
      <div className="review-top-bar__left">
        <button type="button" className="review-top-bar__back" onClick={onBack} title="Back to requests" aria-label="Back to requests">
          <i className="fas fa-arrow-left" aria-hidden="true" />
        </button>
        <div className="review-top-bar__info">
          <div className="review-top-bar__title-row">
            <h1 className="review-top-bar__title">{title}</h1>
            {isUrgent && (
              <span className="review-top-bar__urgent-badge">Urgent</span>
            )}
          </div>
          <span className="review-top-bar__meta">
            {submitterName} &middot; {formatDate(submittedAt)}
          </span>
        </div>
      </div>

      <div className="review-top-bar__center">
        {approvalGates && <ConditionsPopover gates={approvalGates} pendingEdits={pendingEdits} reminders={reminders} onRemind={onRemind} />}
      </div>

      <div className="review-top-bar__right">
        <QueueNavigator
          currentSubmissionId={submissionId}
          onNavigate={onNavigate}
          isReviewer={isReviewer}
        />
        {canApprove && (
          <FinishReviewMenu
            decision={myDecision}
            onApprove={onApprove}
            onRequestChanges={onRequestChanges}
            onDecline={onReject}
          />
        )}
      </div>
    </div>
  );
};

export default ReviewTopBar;
