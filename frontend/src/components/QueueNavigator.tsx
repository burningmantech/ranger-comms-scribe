import React, { useState, useEffect, useCallback } from 'react';
import { API_URL } from '../config';
import './QueueNavigator.css';

interface QueueNavigatorProps {
  currentSubmissionId: string;
  onNavigate: (submissionId: string) => void;
  /**
   * The user works from the review queue: the same check MySubmissions uses to show the
   * ReviewerDashboard (whose "Needs My Action" + "In Progress" columns are this queue).
   * Authors get the SubmitterDashboard, so the pager is never shown to them.
   */
  isReviewer: boolean;
}

interface QueueItem {
  id: string;
  title: string;
}

/**
 * Whether to show the pager. The queue is /my-actions (needsAction, then inProgress), the
 * list the ReviewerDashboard shows. /my-actions returns every in-flight submission for
 * any signed-in user, so being in it doesn't mean the user came from a queue: show the
 * pager only to reviewers, only when this submission is in their queue (so it isn't a
 * sent / declined one opened from history or a notification) and the queue has more than
 * one item.
 */
export function shouldShowQueue(queue: QueueItem[], currentSubmissionId: string, isReviewer: boolean): boolean {
  if (!isReviewer || queue.length < 2) return false;
  return queue.some((q) => q.id === currentSubmissionId);
}

const QueueNavigator: React.FC<QueueNavigatorProps> = ({ currentSubmissionId, onNavigate, isReviewer }) => {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const sessionId = localStorage.getItem('sessionId');

  useEffect(() => {
    if (!isReviewer) return;
    const fetchQueue = async () => {
      if (!sessionId) return;
      try {
        const res = await fetch(`${API_URL}/content/submissions/my-actions`, {
          headers: { Authorization: `Bearer ${sessionId}` },
        });
        if (res.ok) {
          const data = await res.json();
          const items = [...(data.needsAction || []), ...(data.inProgress || [])];
          setQueue(items.map((s: any) => ({ id: s.id, title: s.title })));
        }
      } catch { /* ignore */ }
    };
    fetchQueue();
  }, [sessionId, isReviewer]);

  const visible = shouldShowQueue(queue, currentSubmissionId, isReviewer);
  const currentIndex = queue.findIndex(q => q.id === currentSubmissionId);
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex < queue.length - 1 && currentIndex >= 0;

  const handlePrevious = useCallback(() => {
    if (hasPrevious) onNavigate(queue[currentIndex - 1].id);
  }, [hasPrevious, queue, currentIndex, onNavigate]);

  const handleNext = useCallback(() => {
    if (hasNext) onNavigate(queue[currentIndex + 1].id);
  }, [hasNext, queue, currentIndex, onNavigate]);

  // Keyboard shortcuts: [ for previous, ] for next (only while the pager is shown)
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // The rich-text editor is a contenteditable element; typing [ or ] there must
      // not jump to another submission.
      if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '[') handlePrevious();
      if (e.key === ']') handleNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, handlePrevious, handleNext]);

  if (!visible) return null;

  return (
    <nav className="queue-nav" aria-label="Review queue">
      <button
        type="button"
        className="queue-nav__btn"
        onClick={handlePrevious}
        disabled={!hasPrevious}
        title="Previous request ([)"
        aria-label="Previous request"
      >
        <i className="fas fa-chevron-left" aria-hidden="true" />
      </button>
      <span className="queue-nav__position">
        Request {currentIndex + 1} of {queue.length}
      </span>
      <button
        type="button"
        className="queue-nav__btn"
        onClick={handleNext}
        disabled={!hasNext}
        title="Next request (])"
        aria-label="Next request"
      >
        <i className="fas fa-chevron-right" aria-hidden="true" />
      </button>
    </nav>
  );
};

export default QueueNavigator;
