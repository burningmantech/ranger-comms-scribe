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
          </div>
        )}
        <QueueNavigator
          currentSubmissionId={submissionId}
          onNavigate={onNavigate}
        />
      </div>
    </div>
  );
};

export default ReviewTopBar;
