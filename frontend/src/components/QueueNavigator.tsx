import React, { useState, useEffect, useCallback } from 'react';
import { API_URL } from '../config';
import './QueueNavigator.css';

interface QueueNavigatorProps {
  currentSubmissionId: string;
  onNavigate: (submissionId: string) => void;
}

interface QueueItem {
  id: string;
  title: string;
}

const QueueNavigator: React.FC<QueueNavigatorProps> = ({ currentSubmissionId, onNavigate }) => {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const sessionId = localStorage.getItem('sessionId');

  useEffect(() => {
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
  }, [sessionId]);

  const currentIndex = queue.findIndex(q => q.id === currentSubmissionId);
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex < queue.length - 1 && currentIndex >= 0;

  const handlePrevious = useCallback(() => {
    if (hasPrevious) onNavigate(queue[currentIndex - 1].id);
  }, [hasPrevious, queue, currentIndex, onNavigate]);

  const handleNext = useCallback(() => {
    if (hasNext) onNavigate(queue[currentIndex + 1].id);
  }, [hasNext, queue, currentIndex, onNavigate]);

  // Keyboard shortcuts: [ for previous, ] for next
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === '[') handlePrevious();
      if (e.key === ']') handleNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handlePrevious, handleNext]);

  if (queue.length <= 1) return null;

  return (
    <div className="queue-nav">
      <button
        className="queue-nav__btn"
        onClick={handlePrevious}
        disabled={!hasPrevious}
        title="Previous submission ([)"
      >
        <i className="fas fa-chevron-left" />
      </button>
      <span className="queue-nav__position">
        {currentIndex >= 0 ? currentIndex + 1 : '?'} of {queue.length}
      </span>
      <button
        className="queue-nav__btn"
        onClick={handleNext}
        disabled={!hasNext}
        title="Next submission (])"
      >
        <i className="fas fa-chevron-right" />
      </button>
    </div>
  );
};

export default QueueNavigator;
