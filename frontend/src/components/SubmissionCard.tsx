import React from 'react';
import { ContentSubmission, ApprovalGates } from '../types/content';
import ApprovalTracker from './ApprovalTracker';
import './SubmissionCard.css';

interface SubmissionCardProps {
  submission: ContentSubmission & { approvalGates?: ApprovalGates };
  onClick: () => void;
  showApprovalTracker?: boolean;
  showLatestActivity?: boolean;
}

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

const SubmissionCard: React.FC<SubmissionCardProps> = ({
  submission,
  onClick,
  showApprovalTracker = true,
  showLatestActivity = true,
}) => {
  const isUrgent = submission.formFields?.some(
    (f) => f.label?.toLowerCase() === 'urgent' && f.value === 'true'
  );

  const pendingChanges = submission.approvalGates?.trackedChanges?.pending || 0;

  // Get latest activity from comments or approvals
  const latestActivity = React.useMemo(() => {
    const events: Array<{ text: string; date: Date }> = [];

    for (const comment of submission.comments || []) {
      events.push({
        text: `Comment by ${comment.authorId}`,
        date: new Date(comment.createdAt),
      });
    }
    for (const approval of submission.approvals || []) {
      events.push({
        text: `${approval.status === 'APPROVED' ? 'Approved' : 'Rejected'} by ${approval.approverEmail}`,
        date: new Date(approval.timestamp),
      });
    }

    events.sort((a, b) => b.date.getTime() - a.date.getTime());
    return events[0] || null;
  }, [submission.comments, submission.approvals]);

  return (
    <div className="submission-card" onClick={onClick} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      <div className="submission-card__header">
        <h4 className="submission-card__title">{submission.title}</h4>
        {isUrgent && (
          <span className="submission-card__urgent-badge">Urgent</span>
        )}
      </div>

      <div className="submission-card__meta">
        <span className="submission-card__submitter">{submission.submittedBy}</span>
        <span className="submission-card__time">
          {formatRelativeTime(new Date(submission.submittedAt))}
        </span>
      </div>

      {showApprovalTracker && submission.approvalGates && (
        <div className="submission-card__tracker">
          <ApprovalTracker variant="compact" gates={submission.approvalGates} />
        </div>
      )}

      <div className="submission-card__footer">
        {pendingChanges > 0 && (
          <span className="submission-card__changes-badge">
            {pendingChanges} pending change{pendingChanges !== 1 ? 's' : ''}
          </span>
        )}
        {showLatestActivity && latestActivity && (
          <span className="submission-card__activity">
            {latestActivity.text} {formatRelativeTime(latestActivity.date)}
          </span>
        )}
      </div>
    </div>
  );
};

export default SubmissionCard;
