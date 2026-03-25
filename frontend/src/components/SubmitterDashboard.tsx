import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useContent } from '../contexts/ContentContext';
import { ContentSubmission, ApprovalGates } from '../types/content';
import SubmissionCard from './SubmissionCard';
import './SubmitterDashboard.css';

type SubmissionWithGates = ContentSubmission & { approvalGates?: ApprovalGates };

const SubmitterDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { submissions, currentUser, deleteSubmission } = useContent();
  const [deleteTarget, setDeleteTarget] = useState<SubmissionWithGates | null>(null);

  const mySubmissions = React.useMemo(() => {
    if (!currentUser) return [];
    return (submissions as SubmissionWithGates[])
      .filter((s) => s.submittedBy === currentUser.email || s.submittedBy === currentUser.id)
      .sort(
        (a, b) =>
          new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
      );
  }, [submissions, currentUser]);

  // Column 1: Needs Attention — rejected or has unresponded comments/changes
  const needsAttention = React.useMemo(() => {
    return mySubmissions.filter((s) => {
      if (s.status === 'rejected') return true;
      // in_review with recent reviewer comments the submitter may need to address
      if (s.status === 'in_review') {
        const hasReviewerComments = (s.comments || []).some(
          (c) => c.authorId !== currentUser?.email && c.authorId !== currentUser?.id
        );
        return hasReviewerComments;
      }
      return false;
    });
  }, [mySubmissions, currentUser]);

  // Column 2: In Review — submitted/in_review/draft that don't need attention
  const inReview = React.useMemo(() => {
    const needsAttentionIds = new Set(needsAttention.map((s) => s.id));
    return mySubmissions.filter(
      (s) =>
        ['submitted', 'in_review', 'draft'].includes(s.status) &&
        !needsAttentionIds.has(s.id)
    );
  }, [mySubmissions, needsAttention]);

  // Column 3: Completed — approved/comms_approved/sent from last 30 days
  const completed = React.useMemo(() => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    return mySubmissions.filter(
      (s) =>
        ['approved', 'comms_approved', 'sent'].includes(s.status) &&
        new Date(s.submittedAt) > thirtyDaysAgo
    );
  }, [mySubmissions]);

  if (!currentUser) return null;

  if (mySubmissions.length === 0) {
    return (
      <div className="submitter-dashboard">
        <div className="submitter-dashboard__empty">
          <i className="far fa-paper-plane" />
          <h3>No requests yet</h3>
          <p>Create your first communications request to get started.</p>
          <button
            className="btn btn-primary"
            onClick={() => navigate('/comms-request')}
          >
            <i className="fas fa-plus" /> New Request
          </button>
        </div>
      </div>
    );
  }

  const handleCardClick = (submission: ContentSubmission) => {
    navigate(`/tracked-changes/${submission.id}`);
  };

  return (
    <div className="submitter-dashboard submitter-dashboard--columns">
      <div className="submitter-dashboard__column submitter-dashboard__column--attention">
        <div className="submitter-dashboard__column-header">
          <h3>Needs Attention</h3>
          <span className="submitter-dashboard__count">{needsAttention.length}</span>
        </div>
        <div className="submitter-dashboard__cards">
          {needsAttention.length === 0 ? (
            <div className="submitter-dashboard__empty-col">
              <i className="fas fa-check-circle" />
              <span>All caught up</span>
            </div>
          ) : (
            needsAttention.map((submission) => (
              <SubmissionCard
                key={submission.id}
                submission={submission}
                onClick={() => handleCardClick(submission)}
                onDelete={() => setDeleteTarget(submission)}
                showApprovalTracker
                showLatestActivity
              />
            ))
          )}
        </div>
      </div>

      <div className="submitter-dashboard__column submitter-dashboard__column--review">
        <div className="submitter-dashboard__column-header">
          <h3>In Review</h3>
          <span className="submitter-dashboard__count">{inReview.length}</span>
        </div>
        <div className="submitter-dashboard__cards">
          {inReview.length === 0 ? (
            <div className="submitter-dashboard__empty-col">
              <i className="far fa-folder-open" />
              <span>No submissions in review</span>
            </div>
          ) : (
            inReview.map((submission) => (
              <SubmissionCard
                key={submission.id}
                submission={submission}
                onClick={() => handleCardClick(submission)}
                onDelete={() => setDeleteTarget(submission)}
                showApprovalTracker
                showLatestActivity={false}
              />
            ))
          )}
        </div>
      </div>

      <div className="submitter-dashboard__column submitter-dashboard__column--completed">
        <div className="submitter-dashboard__column-header">
          <h3>Completed</h3>
          <span className="submitter-dashboard__count">{completed.length}</span>
        </div>
        <div className="submitter-dashboard__cards">
          {completed.length === 0 ? (
            <div className="submitter-dashboard__empty-col">
              <i className="far fa-clock" />
              <span>Nothing completed recently</span>
            </div>
          ) : (
            completed.map((submission) => (
              <SubmissionCard
                key={submission.id}
                submission={submission}
                onClick={() => handleCardClick(submission)}
                onDelete={() => setDeleteTarget(submission)}
                showApprovalTracker={false}
                showLatestActivity
              />
            ))
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Delete Submission</h3>
              <button className="modal-close" onClick={() => setDeleteTarget(null)}>&times;</button>
            </div>
            <div className="modal-body">
              <p>Are you sure you want to delete &ldquo;{deleteTarget.title}&rdquo;? This cannot be undone.</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-neutral" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={async () => {
                try {
                  await deleteSubmission(deleteTarget.id);
                } catch (err) {
                  console.error('Failed to delete:', err);
                }
                setDeleteTarget(null);
              }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SubmitterDashboard;
