import React, { useState } from 'react';
import ActivityTimeline from './ActivityTimeline';
import './ReviewRightPanel.css';

type RightPanelTab = 'changes' | 'timeline' | 'comments';

interface ReviewRightPanelProps {
  submissionId: string;
  changesContent: React.ReactNode;
  commentsContent: React.ReactNode;
  pendingCount: number;
}

const ReviewRightPanel: React.FC<ReviewRightPanelProps> = ({
  submissionId,
  changesContent,
  commentsContent,
  pendingCount,
}) => {
  const [activeTab, setActiveTab] = useState<RightPanelTab>('changes');

  return (
    <div className="review-right-panel">
      <div className="review-right-panel__tabs">
        <button
          className={`review-right-panel__tab ${activeTab === 'changes' ? 'active' : ''}`}
          onClick={() => setActiveTab('changes')}
        >
          Changes
          {pendingCount > 0 && (
            <span className="review-right-panel__badge">{pendingCount}</span>
          )}
        </button>
        <button
          className={`review-right-panel__tab ${activeTab === 'timeline' ? 'active' : ''}`}
          onClick={() => setActiveTab('timeline')}
        >
          Timeline
        </button>
        <button
          className={`review-right-panel__tab ${activeTab === 'comments' ? 'active' : ''}`}
          onClick={() => setActiveTab('comments')}
        >
          Comments
        </button>
      </div>

      <div className="review-right-panel__content">
        {activeTab === 'changes' && (
          <div className="review-right-panel__changes">
            {changesContent}
          </div>
        )}
        {activeTab === 'timeline' && (
          <div className="review-right-panel__timeline">
            <ActivityTimeline submissionId={submissionId} />
          </div>
        )}
        {activeTab === 'comments' && (
          <div className="review-right-panel__comments">
            {commentsContent}
          </div>
        )}
      </div>
    </div>
  );
};

export default ReviewRightPanel;
