import React, { useState, useEffect, useCallback } from 'react';
import { TimelineEvent, TimelineEventType } from '../types/content';
import { API_URL } from '../config';
import './ActivityTimeline.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActivityTimelineProps {
  submissionId: string;
  events?: TimelineEvent[];
  maxItems?: number;
  showGroupedEdits?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
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
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

function getEventIcon(type: TimelineEventType, details?: Record<string, any>): string {
  switch (type) {
    case 'submission_created':
      return 'fas fa-paper-plane';
    case 'status_changed':
      return 'fas fa-exchange-alt';
    case 'approval_decision':
      return details?.status === 'approved'
        ? 'fas fa-check-circle'
        : 'fas fa-times-circle';
    case 'comment_added':
      return 'fas fa-comment';
    case 'tracked_changes_made':
      return 'fas fa-pencil-alt';
    case 'tracked_change_reviewed':
      return 'fas fa-clipboard-check';
    case 'approver_added':
      return 'fas fa-user-plus';
    case 'approver_removed':
      return 'fas fa-user-minus';
    case 'override_approval':
      return 'fas fa-bolt';
    default:
      return 'fas fa-circle';
  }
}

function getEventColor(type: TimelineEventType, details?: Record<string, any>): string {
  switch (type) {
    case 'approval_decision':
      return details?.status === 'approved'
        ? 'var(--accent-teal)'
        : 'var(--danger)';
    case 'tracked_change_reviewed':
      return details?.decision === 'approved'
        ? 'var(--accent-teal)'
        : 'var(--danger)';
    case 'override_approval':
      return 'var(--accent-gold)';
    case 'submission_created':
      return 'var(--accent-teal)';
    default:
      return 'var(--text-medium)';
  }
}

// Group events by groupKey
interface EventGroup {
  key: string;
  events: TimelineEvent[];
}

function groupEvents(events: TimelineEvent[]): Array<TimelineEvent | EventGroup> {
  const result: Array<TimelineEvent | EventGroup> = [];
  const groupMap = new Map<string, TimelineEvent[]>();
  const ungroupedIndices: Array<{ index: number; event: TimelineEvent }> = [];

  // First pass: collect groups
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.groupKey) {
      const existing = groupMap.get(event.groupKey);
      if (existing) {
        existing.push(event);
      } else {
        groupMap.set(event.groupKey, [event]);
        ungroupedIndices.push({ index: i, event });
      }
    } else {
      ungroupedIndices.push({ index: i, event });
    }
  }

  // Second pass: build result maintaining order
  const processedGroups = new Set<string>();
  for (const { event } of ungroupedIndices) {
    if (event.groupKey && !processedGroups.has(event.groupKey)) {
      const groupEvents = groupMap.get(event.groupKey)!;
      if (groupEvents.length > 1) {
        result.push({ key: event.groupKey, events: groupEvents });
      } else {
        result.push(event);
      }
      processedGroups.add(event.groupKey);
    } else if (!event.groupKey) {
      result.push(event);
    }
  }

  return result;
}

function isEventGroup(item: TimelineEvent | EventGroup): item is EventGroup {
  return 'key' in item && 'events' in item;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const TimelineEventItem: React.FC<{
  event: TimelineEvent;
  showDetails?: boolean;
}> = ({ event, showDetails = true }) => {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = showDetails && event.details && Object.keys(event.details).length > 0;

  return (
    <div className="timeline-event" onClick={hasDetails ? () => setExpanded(!expanded) : undefined}>
      <div className="timeline-event__dot">
        <i
          className={getEventIcon(event.type, event.details)}
          style={{ color: getEventColor(event.type, event.details) }}
        />
      </div>
      <div className="timeline-event__content">
        <div className="timeline-event__header">
          <span className="timeline-event__actor">{event.actorName}</span>
          <span className="timeline-event__time">{formatRelativeTime(event.timestamp)}</span>
        </div>
        <div className="timeline-event__summary">{event.summary}</div>
        {hasDetails && expanded && (
          <div className="timeline-event__details">
            {event.details!.comment && (
              <div className="timeline-event__detail-item">
                <span className="timeline-event__detail-label">Comment:</span>
                <span className="timeline-event__detail-value">{event.details!.comment}</span>
              </div>
            )}
            {event.details!.content && (
              <div className="timeline-event__detail-item">
                <span className="timeline-event__detail-value timeline-event__detail-value--comment">
                  {event.details!.content}
                </span>
              </div>
            )}
            {event.details!.reason && (
              <div className="timeline-event__detail-item">
                <span className="timeline-event__detail-label">Reason:</span>
                <span className="timeline-event__detail-value">{event.details!.reason}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const TimelineGroupItem: React.FC<{ group: EventGroup }> = ({ group }) => {
  const [expanded, setExpanded] = useState(false);
  const firstEvent = group.events[0];
  const count = group.events.length;

  return (
    <div className="timeline-group">
      <div className="timeline-event timeline-event--group" onClick={() => setExpanded(!expanded)}>
        <div className="timeline-event__dot">
          <i
            className={getEventIcon(firstEvent.type, firstEvent.details)}
            style={{ color: getEventColor(firstEvent.type, firstEvent.details) }}
          />
        </div>
        <div className="timeline-event__content">
          <div className="timeline-event__header">
            <span className="timeline-event__actor">{firstEvent.actorName}</span>
            <span className="timeline-event__time">{formatRelativeTime(firstEvent.timestamp)}</span>
          </div>
          <div className="timeline-event__summary">
            {count} edits
            <i className={`fas fa-chevron-${expanded ? 'up' : 'down'} timeline-group__chevron`} />
          </div>
        </div>
      </div>
      {expanded && (
        <div className="timeline-group__children">
          {group.events.map((event) => (
            <TimelineEventItem key={event.id} event={event} showDetails={false} />
          ))}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Loading Skeleton
// ---------------------------------------------------------------------------

const TimelineSkeleton: React.FC = () => (
  <div className="activity-timeline activity-timeline--loading">
    {[1, 2, 3].map((i) => (
      <div key={i} className="timeline-skeleton">
        <div className="timeline-skeleton__dot" />
        <div className="timeline-skeleton__content">
          <div className="timeline-skeleton__line timeline-skeleton__line--short" />
          <div className="timeline-skeleton__line timeline-skeleton__line--long" />
        </div>
      </div>
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

const ActivityTimeline: React.FC<ActivityTimelineProps> = ({
  submissionId,
  events: propEvents,
  maxItems,
  showGroupedEdits = true,
}) => {
  const [events, setEvents] = useState<TimelineEvent[]>(propEvents || []);
  const [loading, setLoading] = useState(!propEvents);
  const [error, setError] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    try {
      setLoading(true);
      const sessionId = localStorage.getItem('sessionId');
      const response = await fetch(
        `${API_URL}/timeline/submission/${submissionId}`,
        {
          headers: {
            Authorization: `Bearer ${sessionId}`,
          },
        }
      );
      if (!response.ok) {
        throw new Error(`Failed to load timeline`);
      }
      const data = await response.json();
      setEvents(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load timeline');
    } finally {
      setLoading(false);
    }
  }, [submissionId]);

  useEffect(() => {
    if (!propEvents) {
      fetchEvents();
    }
  }, [propEvents, fetchEvents]);

  useEffect(() => {
    if (propEvents) {
      setEvents(propEvents);
      setLoading(false);
    }
  }, [propEvents]);

  if (loading) {
    return <TimelineSkeleton />;
  }

  if (error) {
    return (
      <div className="activity-timeline activity-timeline--error">
        <p>{error}</p>
        <button className="btn btn-sm btn-neutral" onClick={fetchEvents}>
          Retry
        </button>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="activity-timeline activity-timeline--empty">
        <i className="far fa-clock" />
        <span>No activity yet</span>
      </div>
    );
  }

  const displayEvents = maxItems ? events.slice(0, maxItems) : events;
  const items = showGroupedEdits ? groupEvents(displayEvents) : displayEvents;
  const hasMore = maxItems && events.length > maxItems;

  return (
    <div className="activity-timeline">
      <div className="activity-timeline__list">
        {items.map((item, idx) => {
          if (isEventGroup(item)) {
            return <TimelineGroupItem key={item.key} group={item} />;
          }
          return <TimelineEventItem key={item.id || idx} event={item} />;
        })}
      </div>
      {hasMore && (
        <div className="activity-timeline__view-all">
          View all {events.length} events
        </div>
      )}
    </div>
  );
};

export default ActivityTimeline;
