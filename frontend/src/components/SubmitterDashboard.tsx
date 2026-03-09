import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useContent } from '../contexts/ContentContext';
import StatusPipeline from './StatusPipeline';
import './SubmitterDashboard.css';

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

const SubmitterDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { submissions, currentUser } = useContent();

  const mySubmissions = React.useMemo(() => {
    if (!currentUser) return [];
    return submissions
      .filter((s) => s.submittedBy === currentUser.email)
      .sort(
        (a, b) =>
          new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
      );
  }, [submissions, currentUser]);

  if (!currentUser) return null;

  return (
    <div className="submitter-dashboard">
      {mySubmissions.length === 0 ? (
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
      ) : (
        <div className="submitter-dashboard__list">
          {mySubmissions.map((submission) => {
            const latestComment = (submission.comments || [])
              .sort(
                (a, b) =>
                  new Date(b.createdAt).getTime() -
                  new Date(a.createdAt).getTime()
              )[0];

            return (
              <div
                key={submission.id}
                className="submitter-dashboard__card"
                onClick={() => navigate(`/tracked-changes/${submission.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(`/tracked-changes/${submission.id}`);
                  }
                }}
              >
                <div className="submitter-dashboard__card-header">
                  <h4>{submission.title}</h4>
                  <span className="submitter-dashboard__card-time">
                    {formatRelativeTime(new Date(submission.submittedAt))}
                  </span>
                </div>

                <StatusPipeline
                  status={submission.status}
                  approvalGates={(submission as any).approvalGates}
                />

                {latestComment && (
                  <div className="submitter-dashboard__card-activity">
                    <i className="fas fa-comment" />
                    <span>
                      {latestComment.authorId}: {latestComment.content?.substring(0, 80)}
                      {(latestComment.content?.length || 0) > 80 ? '...' : ''}
                    </span>
                  </div>
                )}

                <div className="submitter-dashboard__card-action">
                  View Details <i className="fas fa-chevron-right" />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default SubmitterDashboard;
