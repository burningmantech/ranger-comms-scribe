import React, { useState } from 'react';
import { ApprovalGates } from '../types/content';
import './ApprovalTracker.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApprovalTrackerProps {
  gates: ApprovalGates;
  variant: 'full' | 'compact';
  onNavigateToChanges?: () => void;
  showOverride?: boolean;
  overrideInfo?: {
    by: string;
    reason: string;
    at: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function countMetGates(gates: ApprovalGates): number {
  let count = 0;
  if (gates.councilManager.met) count++;
  if (gates.commsCadre.met) count++;
  if (gates.requiredApprovers.met) count++;
  if (gates.trackedChanges.met) count++;
  return count;
}

type GateStatus = 'met' | 'warning' | 'not-started' | 'rejected';

function getRequiredApproversStatus(
  gate: ApprovalGates['requiredApprovers']
): GateStatus {
  if (gate.met) return 'met';
  const hasRejection = gate.details.some((d) => d.status === 'rejected');
  if (hasRejection) return 'rejected';
  if (gate.approved > 0) return 'warning';
  return 'not-started';
}

function getTrackedChangesStatus(
  gate: ApprovalGates['trackedChanges']
): GateStatus {
  if (gate.met) return 'met';
  if (gate.pending > 0) return 'warning';
  return 'not-started';
}

function getSimpleGateStatus(met: boolean): GateStatus {
  return met ? 'met' : 'not-started';
}

function gateStatusToColor(status: GateStatus): string {
  switch (status) {
    case 'met':
      return 'var(--accent-teal)';
    case 'warning':
      return 'var(--accent-gold)';
    case 'rejected':
      return 'var(--danger)';
    case 'not-started':
    default:
      return '#ccc';
  }
}

function gateStatusToIcon(status: GateStatus): string {
  switch (status) {
    case 'met':
      return 'fas fa-check-circle';
    case 'warning':
      return 'fas fa-exclamation-triangle';
    case 'rejected':
      return 'fas fa-times-circle';
    case 'not-started':
    default:
      return 'far fa-circle';
  }
}

// ---------------------------------------------------------------------------
// Full Variant Sub-components
// ---------------------------------------------------------------------------

interface GateRowProps {
  label: string;
  status: GateStatus;
  statusText: string;
  expandedContent?: React.ReactNode;
  onClick?: () => void;
  isClickable?: boolean;
}

const GateRow: React.FC<GateRowProps> = ({
  label,
  status,
  statusText,
  expandedContent,
  onClick,
  isClickable = false,
}) => {
  const [expanded, setExpanded] = useState(false);
  const hasExpandedContent = !!expandedContent;

  const handleClick = () => {
    if (isClickable && onClick) {
      onClick();
    } else if (hasExpandedContent) {
      setExpanded((prev) => !prev);
    }
  };

  const isInteractive = hasExpandedContent || isClickable;

  return (
    <div className="approval-gate-row">
      <div
        className={`approval-gate-row__header ${isInteractive ? 'approval-gate-row__header--interactive' : ''}`}
        onClick={handleClick}
        role={isInteractive ? 'button' : undefined}
        tabIndex={isInteractive ? 0 : undefined}
        onKeyDown={
          isInteractive
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleClick();
                }
              }
            : undefined
        }
      >
        <span className="approval-gate-row__icon">
          <i
            className={gateStatusToIcon(status)}
            style={{ color: gateStatusToColor(status) }}
          />
        </span>
        <span className="approval-gate-row__label">{label}</span>
        <span className={`approval-gate-row__status approval-gate-row__status--${status}`}>
          {statusText}
        </span>
        {hasExpandedContent && !isClickable && (
          <span className="approval-gate-row__chevron">
            <i className={`fas fa-chevron-${expanded ? 'up' : 'down'}`} />
          </span>
        )}
        {isClickable && (
          <span className="approval-gate-row__chevron">
            <i className="fas fa-external-link-alt" />
          </span>
        )}
      </div>
      {hasExpandedContent && !isClickable && (
        <div
          className={`approval-gate-row__details ${expanded ? 'approval-gate-row__details--expanded' : ''}`}
        >
          <div className="approval-gate-row__details-inner">
            {expandedContent}
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Full Variant
// ---------------------------------------------------------------------------

const ApprovalTrackerFull: React.FC<ApprovalTrackerProps> = ({
  gates,
  onNavigateToChanges,
  showOverride,
  overrideInfo,
}) => {
  // Council Manager gate
  const cmStatus = getSimpleGateStatus(gates.councilManager.met);
  const cmStatusText = gates.councilManager.met
    ? `${gates.councilManager.approverName || gates.councilManager.approver || 'Approved'}${gates.councilManager.date ? ' \u2014 ' + formatDate(gates.councilManager.date) : ''}`
    : 'Waiting';
  const cmDetails = gates.councilManager.met ? (
    <div className="approval-gate-detail">
      {gates.councilManager.approverName && (
        <div className="approval-gate-detail__row">
          <span className="approval-gate-detail__label">Approved by:</span>
          <span className="approval-gate-detail__value">
            {gates.councilManager.approverName}
          </span>
        </div>
      )}
      {gates.councilManager.date && (
        <div className="approval-gate-detail__row">
          <span className="approval-gate-detail__label">Date:</span>
          <span className="approval-gate-detail__value">
            {formatDate(gates.councilManager.date)}
          </span>
        </div>
      )}
      {gates.councilManager.comment && (
        <div className="approval-gate-detail__row">
          <span className="approval-gate-detail__label">Comment:</span>
          <span className="approval-gate-detail__value">
            {gates.councilManager.comment}
          </span>
        </div>
      )}
    </div>
  ) : undefined;

  // Comms Cadre gate
  const ccStatus = getSimpleGateStatus(gates.commsCadre.met);
  const ccStatusText = gates.commsCadre.met
    ? `${gates.commsCadre.approverName || gates.commsCadre.approver || 'Approved'}${gates.commsCadre.date ? ' \u2014 ' + formatDate(gates.commsCadre.date) : ''}`
    : 'Waiting';
  const ccDetails = gates.commsCadre.met ? (
    <div className="approval-gate-detail">
      {gates.commsCadre.approverName && (
        <div className="approval-gate-detail__row">
          <span className="approval-gate-detail__label">Approved by:</span>
          <span className="approval-gate-detail__value">
            {gates.commsCadre.approverName}
          </span>
        </div>
      )}
      {gates.commsCadre.date && (
        <div className="approval-gate-detail__row">
          <span className="approval-gate-detail__label">Date:</span>
          <span className="approval-gate-detail__value">
            {formatDate(gates.commsCadre.date)}
          </span>
        </div>
      )}
      {gates.commsCadre.comment && (
        <div className="approval-gate-detail__row">
          <span className="approval-gate-detail__label">Comment:</span>
          <span className="approval-gate-detail__value">
            {gates.commsCadre.comment}
          </span>
        </div>
      )}
    </div>
  ) : undefined;

  // Required Approvers gate
  const raStatus = getRequiredApproversStatus(gates.requiredApprovers);
  const raStatusText =
    gates.requiredApprovers.total === 0
      ? 'Needs assignment'
      : `${gates.requiredApprovers.approved} of ${gates.requiredApprovers.total}`;
  const raDetails =
    gates.requiredApprovers.details.length > 0 ? (
      <div className="approval-gate-detail">
        {gates.requiredApprovers.details.map((detail, idx) => (
          <div key={idx} className="approval-gate-detail__approver">
            <span className="approval-gate-detail__approver-icon">
              <i
                className={
                  detail.status === 'approved'
                    ? 'fas fa-check'
                    : detail.status === 'rejected'
                      ? 'fas fa-times'
                      : 'far fa-clock'
                }
                style={{
                  color:
                    detail.status === 'approved'
                      ? 'var(--accent-teal)'
                      : detail.status === 'rejected'
                        ? 'var(--danger)'
                        : '#ccc',
                }}
              />
            </span>
            <span className="approval-gate-detail__approver-name">
              {detail.name || detail.email}
            </span>
            {detail.date && (
              <span className="approval-gate-detail__approver-date">
                {formatDate(detail.date)}
              </span>
            )}
          </div>
        ))}
      </div>
    ) : undefined;

  // Tracked Changes gate
  const tcStatus = getTrackedChangesStatus(gates.trackedChanges);
  const tcStatusText = gates.trackedChanges.met
    ? 'All edits resolved'
    : gates.trackedChanges.pending > 0
      ? `${gates.trackedChanges.pending} pending`
      : 'No changes';

  return (
    <div className="approval-tracker approval-tracker--full">
      {showOverride && overrideInfo && (
        <div className="approval-tracker__override-banner">
          <i className="fas fa-bolt approval-tracker__override-icon" />
          <div className="approval-tracker__override-content">
            <span className="approval-tracker__override-title">
              Approval Override
            </span>
            <span className="approval-tracker__override-detail">
              by {overrideInfo.by}
              {overrideInfo.at ? ` on ${formatDate(overrideInfo.at)}` : ''}
            </span>
            {overrideInfo.reason && (
              <span className="approval-tracker__override-reason">
                {overrideInfo.reason}
              </span>
            )}
          </div>
        </div>
      )}
      <div className="approval-tracker__gates">
        <GateRow
          label="Council Manager"
          status={cmStatus}
          statusText={cmStatusText}
          expandedContent={cmDetails}
        />
        <GateRow
          label="Comms Cadre"
          status={ccStatus}
          statusText={ccStatusText}
          expandedContent={ccDetails}
        />
        <GateRow
          label="Required Approvers"
          status={raStatus}
          statusText={raStatusText}
          expandedContent={raDetails}
        />
        <GateRow
          label="Edits Resolved"
          status={tcStatus}
          statusText={tcStatusText}
          onClick={onNavigateToChanges}
          isClickable={!!onNavigateToChanges && gates.trackedChanges.pending > 0}
        />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Compact Variant
// ---------------------------------------------------------------------------

const ApprovalTrackerCompact: React.FC<ApprovalTrackerProps> = ({ gates }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const metCount = countMetGates(gates);

  const gateEntries: Array<{ label: string; status: GateStatus }> = [
    {
      label: 'Council Manager',
      status: getSimpleGateStatus(gates.councilManager.met),
    },
    {
      label: 'Comms Cadre',
      status: getSimpleGateStatus(gates.commsCadre.met),
    },
    {
      label: 'Required Approvers',
      status: getRequiredApproversStatus(gates.requiredApprovers),
    },
    {
      label: 'Edits Resolved',
      status: getTrackedChangesStatus(gates.trackedChanges),
    },
  ];

  return (
    <div
      className="approval-tracker approval-tracker--compact"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <div className="approval-tracker-compact__dots">
        {gateEntries.map((entry, idx) => (
          <span
            key={idx}
            className={`approval-tracker-compact__dot approval-tracker-compact__dot--${entry.status}`}
            style={{ backgroundColor: gateStatusToColor(entry.status) }}
          />
        ))}
      </div>
      <span className="approval-tracker-compact__text">
        {metCount}/4 conditions met
      </span>
      {showTooltip && (
        <div className="approval-tracker-compact__tooltip">
          {gateEntries.map((entry, idx) => (
            <div key={idx} className="approval-tracker-compact__tooltip-row">
              <i
                className={gateStatusToIcon(entry.status)}
                style={{ color: gateStatusToColor(entry.status) }}
              />
              <span className="approval-tracker-compact__tooltip-label">
                {entry.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

const ApprovalTracker: React.FC<ApprovalTrackerProps> = (props) => {
  if (props.variant === 'compact') {
    return <ApprovalTrackerCompact {...props} />;
  }
  return <ApprovalTrackerFull {...props} />;
};

export default ApprovalTracker;
