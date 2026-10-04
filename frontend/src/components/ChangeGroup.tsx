import React from 'react';
import { Change } from '../types/content';
import './ChangeGroup.css';

interface ChangeGroupProps<T extends Change = Change> {
  authorName: string;
  authorEmail: string;
  timestamp: string;
  changes: T[];
  expanded: boolean;
  onToggle: () => void;
  onApproveGroup: () => void;
  onRejectGroup: () => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  canReview: boolean;
  renderChange: (change: T) => React.ReactNode;
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
    hour: 'numeric',
    minute: '2-digit',
  });
}

function abbreviateName(name: string): string {
  const parts = name.split(/[@.\s]+/);
  if (parts.length >= 2 && parts[1]) {
    return `${parts[0].charAt(0).toUpperCase()}. ${parts[1].charAt(0).toUpperCase() + parts[1].slice(1)}`;
  }
  return name;
}

const ChangeGroup: React.FC<ChangeGroupProps> = ({
  authorName,
  timestamp,
  changes,
  expanded,
  onToggle,
  onApproveGroup,
  onRejectGroup,
  selectedIds,
  onToggleSelect,
  canReview,
  renderChange,
}) => {
  const pendingCount = changes.filter(c => c.status === 'pending').length;
  const allPending = pendingCount === changes.length;

  return (
    <div className={`change-group ${expanded ? 'change-group--expanded' : ''}`}>
      <div className="change-group__header" onClick={onToggle}>
        <div className="change-group__summary">
          <span className="change-group__author">{abbreviateName(authorName)}</span>
          <span className="change-group__count">
            made {changes.length} edit{changes.length !== 1 ? 's' : ''}
          </span>
          <span className="change-group__time">
            — {formatRelativeTime(new Date(timestamp))}
          </span>
        </div>
        <div className="change-group__actions">
          {canReview && allPending && (
            <>
              <button
                className="btn btn-icon btn-sm change-group__approve"
                onClick={(e) => { e.stopPropagation(); onApproveGroup(); }}
                title="Approve all in group"
              >
                ✓
              </button>
              <button
                className="btn btn-icon btn-sm change-group__reject"
                onClick={(e) => { e.stopPropagation(); onRejectGroup(); }}
                title="Reject all in group"
              >
                ✗
              </button>
            </>
          )}
          <i className={`fas fa-chevron-${expanded ? 'up' : 'down'} change-group__chevron`} />
        </div>
      </div>
      {expanded && (
        <div className="change-group__children">
          {changes.map((change) => (
            <div key={change.id} className="change-group__item">
              {canReview && change.status === 'pending' && (
                <input
                  type="checkbox"
                  className="change-select-checkbox"
                  checked={selectedIds.has(change.id)}
                  onChange={() => onToggleSelect(change.id)}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
              {renderChange(change)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ChangeGroup;

// Utility: group changes by author within 2-minute windows
export interface ChangeGroupData<T extends Change = Change> {
  authorName: string;
  authorEmail: string;
  timestamp: string;
  changes: T[];
}

export function groupChanges<T extends Change>(changes: T[]): ChangeGroupData<T>[] {
  const sorted = [...changes].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const groups: ChangeGroupData<T>[] = [];
  for (const change of sorted) {
    const lastGroup = groups[groups.length - 1];
    if (
      lastGroup &&
      lastGroup.authorEmail === change.changedBy &&
      Math.abs(
        new Date(change.timestamp).getTime() -
          new Date(lastGroup.timestamp).getTime()
      ) < 120000
    ) {
      lastGroup.changes.push(change);
    } else {
      groups.push({
        authorName: (change as any).changedByName || change.changedBy,
        authorEmail: change.changedBy,
        timestamp: change.timestamp as any,
        changes: [change],
      });
    }
  }
  return groups;
}
