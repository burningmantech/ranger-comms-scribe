import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useContent } from '../contexts/ContentContext';
import { ContentSubmission as ContentSubmissionComponent } from '../components/ContentSubmission';
import { SubmissionHistory } from '../components/SubmissionHistory';
import { ContentSubmission } from '../types/content';
import ReviewerDashboard from '../components/ReviewerDashboard';
import SubmitterDashboard from '../components/SubmitterDashboard';
import './MySubmissions.css';

export const MySubmissions: React.FC = () => {
  const navigate = useNavigate();
  const {
    submissions,
    currentUser,
    userPermissions,
    saveSubmission,
    approveSubmission,
    rejectSubmission,
    addComment,
    deleteSubmission,
    createSuggestion,
    approveSuggestion,
    rejectSuggestion,
    refreshSubmissions
  } = useContent();
  const [selectedSubmission, setSelectedSubmission] = React.useState<ContentSubmission | null>(null);

  if (!currentUser) {
    return <div className="error-message">Please log in to view requests.</div>;
  }

  const isReviewer = userPermissions?.canViewFilteredSubmissions ||
    currentUser.roles?.some(r => ['CommsCadre', 'CouncilManager', 'Admin'].includes(r));

  return (
    <div className="content-management">
      <div className="content-header">
        <h1>Requests</h1>
        {selectedSubmission && (
          <button
            onClick={async () => { setSelectedSubmission(null); await refreshSubmissions(); }}
            className="btn btn-neutral"
          >
            ← Back to Requests
          </button>
        )}
      </div>

      <div className="content-body">
        {selectedSubmission ? (
          <ContentSubmissionComponent
            submission={selectedSubmission}
            currentUser={currentUser}
            onSave={saveSubmission}
            onApprove={approveSubmission}
            onReject={rejectSubmission}
            onComment={addComment}
            onSuggestionCreate={createSuggestion}
            onSuggestionApprove={approveSuggestion}
            onSuggestionReject={rejectSuggestion}
          />
        ) : isReviewer ? (
          <ReviewerDashboard />
        ) : (
          <SubmitterDashboard />
        )}
      </div>

      {/* Floating Action Button */}
      <button
        onClick={() => navigate('/comms-request')}
        className="floating-action-button"
        title="Create New Request"
      >
        <i className="fas fa-plus"></i>
      </button>
    </div>
  );
};
