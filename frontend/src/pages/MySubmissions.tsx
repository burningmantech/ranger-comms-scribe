import React from 'react';
import { useContent } from '../contexts/ContentContext';
import { ContentSubmission as ContentSubmissionComponent } from '../components/ContentSubmission';
import { SubmissionHistory } from '../components/SubmissionHistory';
import { ContentSubmission } from '../types/content';
import './MySubmissions.css';

export const MySubmissions: React.FC = () => {
  const { 
    submissions, 
    currentUser, 
    userPermissions,
    saveSubmission, 
    approveSubmission, 
    rejectSubmission, 
    addComment, 
    createSuggestion, 
    approveSuggestion, 
    rejectSuggestion 
  } = useContent();
  const [selectedSubmission, setSelectedSubmission] = React.useState<ContentSubmission | null>(null);

  React.useEffect(() => {
    console.log('Current User:', currentUser);
    console.log('All Submissions:', submissions);
  }, [currentUser, submissions]);

  if (!currentUser) {
    return <div className="error-message">Please log in to view your submissions.</div>;
  }

  // Filter submissions to only show those submitted by the current user
  const mySubmissions = submissions.filter(
    submission => submission.submittedBy === currentUser.email
  );

  console.log('Filtered Submissions:', mySubmissions);

  return (
    <div className="content-management">
      <div className="content-header">
        <h1>My Submissions</h1>
        {selectedSubmission && (
          <button
            onClick={() => setSelectedSubmission(null)}
            className="back-button"
          >
            ← Back to Submissions
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
            submissions={mySubmissions}
            onSelectSubmission={setSelectedSubmission}
            canViewFilteredSubmissions={userPermissions?.canViewFilteredSubmissions || false}
          />
        )}
      </div>
    </div>
  );
}; 