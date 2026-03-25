import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ContentSubmission, ApprovalGates } from '../types/content';
import { API_URL } from '../config';
import SubmissionCard from './SubmissionCard';
import { useContent } from '../contexts/ContentContext';
import './ReviewerDashboard.css';

type SubmissionWithGates = ContentSubmission & { approvalGates?: ApprovalGates };

const ReviewerDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { submissions, deleteSubmission } = useContent();
  const [needsAction, setNeedsAction] = useState<SubmissionWithGates[]>([]);
  const [inProgress, setInProgress] = useState<SubmissionWithGates[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<SubmissionWithGates | null>(null);

  useEffect(() => {
    const fetchMyActions = async () => {
      try {
        const sessionId = localStorage.getItem('sessionId');
        const response = await fetch(`${API_URL}/content/submissions/my-actions`, {
          headers: { Authorization: `Bearer ${sessionId}` },
        });
        if (!response.ok) throw new Error('Failed to load');
        const data = await response.json();
        setNeedsAction(data.needsAction || []);
        setInProgress(data.inProgress || []);
      } catch (err) {
        console.error('Failed to load my-actions, falling back to context submissions:', err);
        // Fall back: show pending/in_review submissions from context
        const pending = submissions.filter(
          (s) => ['pending', 'in_review', 'pending_review'].includes(s.status)
        );
        setNeedsAction(pending);
        setInProgress([]);
      } finally {
        setLoading(false);
      }
    };
    fetchMyActions();
  }, [submissions]); // Refresh when submissions change

  // Recently completed: approved, sent, or rejected from last 7 days
  const recentlyCompleted = React.useMemo(() => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return submissions
      .filter(
        (s) =>
          ['approved', 'comms_approved', 'sent', 'rejected'].includes(s.status) &&
          new Date(s.submittedAt) > sevenDaysAgo
      )
      .sort(
        (a, b) =>
          new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
      );
  }, [submissions]);

  const handleCardClick = (submission: ContentSubmission) => {
    navigate(`/tracked-changes/${submission.id}`);
  };

  if (loading) {
    return (
      <div className="reviewer-dashboard reviewer-dashboard--loading">
        <div className="reviewer-dashboard__skeleton" />
        <div className="reviewer-dashboard__skeleton" />
        <div className="reviewer-dashboard__skeleton" />
      </div>
    );
  }

  return (
    <div className="reviewer-dashboard">
      <div className="reviewer-dashboard__column reviewer-dashboard__column--action">
        <div className="reviewer-dashboard__column-header">
          <h3>Needs My Action</h3>
          <span className="reviewer-dashboard__count">{needsAction.length}</span>
        </div>
        <div className="reviewer-dashboard__cards">
          {needsAction.length === 0 ? (
            <div className="reviewer-dashboard__empty">
              <i className="fas fa-check-circle" />
              <span>All caught up</span>
            </div>
          ) : (
            needsAction.map((submission) => (
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

      <div className="reviewer-dashboard__column reviewer-dashboard__column--progress">
        <div className="reviewer-dashboard__column-header">
          <h3>In Progress</h3>
          <span className="reviewer-dashboard__count">{inProgress.length}</span>
        </div>
        <div className="reviewer-dashboard__cards">
          {inProgress.length === 0 ? (
            <div className="reviewer-dashboard__empty">
              <i className="far fa-folder-open" />
              <span>No submissions in progress</span>
            </div>
          ) : (
            inProgress.map((submission) => (
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

      <div className="reviewer-dashboard__column reviewer-dashboard__column--completed">
        <div className="reviewer-dashboard__column-header">
          <h3>Recently Completed</h3>
          <span className="reviewer-dashboard__count">{recentlyCompleted.length}</span>
        </div>
        <div className="reviewer-dashboard__cards">
          {recentlyCompleted.length === 0 ? (
            <div className="reviewer-dashboard__empty">
              <i className="far fa-clock" />
              <span>Nothing completed recently</span>
            </div>
          ) : (
            recentlyCompleted.map((submission) => (
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

export default ReviewerDashboard;
