import React, { useState } from 'react';
import ApprovalTracker from './ApprovalTracker';
import QueueNavigator from './QueueNavigator';
import { ApprovalGates } from '../types/content';
import './ReviewTopBar.css';

interface ReviewTopBarProps {
  submissionId: string;
  title: string;
  submitterName: string;
  submittedAt: Date;
  isUrgent: boolean;
  approvalGates?: ApprovalGates;
  canApprove: boolean;
  onBack: () => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onReject: () => void;
  onReset?: () => void;
  onNavigate: (submissionId: string) => void;
}

const ReviewTopBar: React.FC<ReviewTopBarProps> = ({
  submissionId,
  title,
  submitterName,
  submittedAt,
  isUrgent,
  approvalGates,
  canApprove,
  onBack,
  onApprove,
  onRequestChanges,
  onReject,
  onReset,
  onNavigate,
}) => {
  const [showResetConfirm, setShowResetConfirm] = useState(false);

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
        <button className="review-top-bar__back" onClick={onBack} title="Back to queue">
          <i className="fas fa-arrow-left" />
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
        {approvalGates && (
          <ApprovalTracker
            variant="compact"
            gates={approvalGates}
          />
        )}
      </div>

      <div className="review-top-bar__right">
        {canApprove && (
          <div className="review-top-bar__actions">
            <button
              className="review-top-bar__action-btn review-top-bar__action-btn--approve"
              onClick={onApprove}
            >
              <i className="fas fa-check" />
              <span>Approve</span>
            </button>
            <button
              className="review-top-bar__action-btn review-top-bar__action-btn--request-changes"
              onClick={onRequestChanges}
            >
              <i className="fas fa-comment-dots" />
              <span>Request Changes</span>
            </button>
            <button
              className="review-top-bar__action-btn review-top-bar__action-btn--reject"
              onClick={onReject}
            >
              <i className="fas fa-times" />
              <span>Reject</span>
            </button>
            {onReset && (
              <button
                className="review-top-bar__action-btn review-top-bar__action-btn--reset"
                onClick={() => setShowResetConfirm(true)}
                style={{ backgroundColor: '#fee2e2', color: '#b91c1c', border: '1px solid #fca5a5' }}
              >
                <i className="fas fa-undo" />
                <span>Reset</span>
              </button>
            )}
          </div>
        )}
        <QueueNavigator
          currentSubmissionId={submissionId}
          onNavigate={onNavigate}
        />
      </div>
      {showResetConfirm && (
        <div className="request-changes-overlay" onClick={() => setShowResetConfirm(false)}>
          <div className="request-changes-dialog" onClick={e => e.stopPropagation()}>
            <h3>Reset Document</h3>
            <p style={{ margin: '12px 0', color: '#666' }}>
              Are you sure you want to reset this document to its original state and delete all tracked changes? This cannot be undone.
            </p>
            <div className="request-changes-actions">
              <button className="btn btn-neutral" onClick={() => setShowResetConfirm(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => { setShowResetConfirm(false); onReset?.(); }}>Reset</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReviewTopBar;
