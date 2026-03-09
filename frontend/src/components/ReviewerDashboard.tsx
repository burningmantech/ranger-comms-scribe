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
  const { submissions } = useContent();
  const [needsAction, setNeedsAction] = useState<SubmissionWithGates[]>([]);
  const [inProgress, setInProgress] = useState<SubmissionWithGates[]>([]);
  const [loading, setLoading] = useState(true);

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
        console.error('Failed to load my-actions:', err);
        // Fall back to using context submissions
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
                showApprovalTracker={false}
                showLatestActivity
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default ReviewerDashboard;
