import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useContent } from '../contexts/ContentContext';
import { ContentSubmission as ContentSubmissionComponent } from '../components/ContentSubmission';
import { SubmissionHistory } from '../components/SubmissionHistory';
import { ContentSubmission } from '../types/content';
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
    rejectSuggestion 
  } = useContent();
  const [selectedSubmission, setSelectedSubmission] = React.useState<ContentSubmission | null>(null);

  React.useEffect(() => {
    // Effect dependencies for re-rendering when user or submissions change
  }, [currentUser, submissions]);

  if (!currentUser) {
    return <div className="error-message">Please log in to view requests.</div>;
  }

  // Filter submissions based on user permissions
  const filteredSubmissions = userPermissions?.canViewFilteredSubmissions
    ? submissions // Show all submissions if user has permission
    : submissions.filter(submission => submission.submittedBy === currentUser.email); // Show only user's submissions

  return (
    <div className="content-management">
      <div className="content-header">
        <h1>Requests</h1>
        {selectedSubmission && (
          <button
            onClick={() => setSelectedSubmission(null)}
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
        ) : (
          <SubmissionHistory
            submissions={filteredSubmissions}
            onSelectSubmission={setSelectedSubmission}
            onDeleteSubmission={deleteSubmission}
            canViewFilteredSubmissions={userPermissions?.canViewFilteredSubmissions || false}
          />
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