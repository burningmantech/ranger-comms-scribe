import React from 'react';
import { SubmissionStatus, ApprovalGates } from '../types/content';
import './StatusPipeline.css';

interface StatusPipelineProps {
  status: SubmissionStatus;
  approvalGates?: ApprovalGates;
  blockingReason?: string;
}

const PIPELINE_STAGES: Array<{ key: SubmissionStatus[]; label: string }> = [
  { key: ['submitted', 'draft'], label: 'Submitted' },
  { key: ['in_review'], label: 'In Review' },
  { key: ['approved', 'comms_approved'], label: 'Approved' },
  { key: ['sent'], label: 'Sent' },
];

function getStageIndex(status: SubmissionStatus): number {
  if (status === 'rejected') return -1;
  for (let i = 0; i < PIPELINE_STAGES.length; i++) {
    if (PIPELINE_STAGES[i].key.includes(status)) return i;
  }
  return 0;
}

function getBlockingText(gates?: ApprovalGates): string | null {
  if (!gates) return null;
  if (!gates.councilManager.met) return 'Waiting on Council Manager approval';
  if (!gates.commsCadre.met) return 'Waiting on Comms Cadre approval';
  if (!gates.requiredApprovers.met) {
    const remaining = gates.requiredApprovers.total - gates.requiredApprovers.approved;
    return `Waiting on ${remaining} required approver${remaining !== 1 ? 's' : ''}`;
  }
  if (!gates.trackedChanges.met) {
    return `${gates.trackedChanges.pending} tracked change${gates.trackedChanges.pending !== 1 ? 's' : ''} pending review`;
  }
  return null;
}

const StatusPipeline: React.FC<StatusPipelineProps> = ({
  status,
  approvalGates,
  blockingReason,
}) => {
  const currentIndex = getStageIndex(status);
  const isRejected = status === 'rejected';
  const blocking = blockingReason || getBlockingText(approvalGates);

  return (
    <div className="status-pipeline">
      <div className="status-pipeline__stages">
        {PIPELINE_STAGES.map((stage, idx) => {
          const isPast = !isRejected && idx < currentIndex;
          const isCurrent = !isRejected && idx === currentIndex;
          const isFuture = isRejected || idx > currentIndex;

          return (
            <React.Fragment key={stage.label}>
              {idx > 0 && (
                <div
                  className={`status-pipeline__connector ${isPast ? 'status-pipeline__connector--complete' : ''}`}
                />
              )}
              <div
                className={`status-pipeline__stage ${
                  isPast ? 'status-pipeline__stage--complete' : ''
                } ${isCurrent ? 'status-pipeline__stage--current' : ''} ${
                  isFuture ? 'status-pipeline__stage--future' : ''
                }`}
              >
                <div className="status-pipeline__dot">
                  {isPast ? (
                    <i className="fas fa-check" />
                  ) : isCurrent ? (
                    <div className="status-pipeline__dot-pulse" />
                  ) : null}
                </div>
                <span className="status-pipeline__label">{stage.label}</span>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {isRejected && (
        <div className="status-pipeline__rejected">
          <i className="fas fa-times-circle" />
          <span>Rejected</span>
        </div>
      )}

      {blocking && !isRejected && (
        <div className="status-pipeline__blocking">
          <i className="fas fa-info-circle" />
          <span>{blocking}</span>
        </div>
      )}
    </div>
  );
};

export default StatusPipeline;
