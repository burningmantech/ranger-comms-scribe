import React, { useState } from 'react';
import { ContentSubmission } from '../types/content';
import { ContentSubmission as ContentSubmissionComponent } from '../components/ContentSubmission';
import { CouncilManagerManagement } from '../components/CouncilManagerManagement';
import { CommsCadreManagement } from '../components/CommsCadreManagement';
import { SubmissionHistory } from '../components/SubmissionHistory';
import { ApprovalReminders } from '../components/ApprovalReminders';
import { useContent } from '../contexts/ContentContext';

export const ContentManagement: React.FC = () => {
  const {
    submissions,
    councilManagers,
    commsCadreMembers,
    currentUser,
    saveSubmission,
    approveSubmission,
    rejectSubmission,
    addComment,
    saveCouncilManagers,
    addCommsCadreMember,
    removeCommsCadreMember,
    sendReminder,
    createSuggestion,
    approveSuggestion,
    rejectSuggestion
  } = useContent();

  const [selectedSubmission, setSelectedSubmission] = useState<ContentSubmission | null>(null);
  const [activeTab, setActiveTab] = useState<'submissions' | 'council' | 'cadre' | 'reminders'>('submissions');

  const pendingSubmissions = submissions.filter(
    submission => submission.status === 'in_review'
  );

  if (!currentUser) {
    return <div className="error-message">Please log in to access content management.</div>;
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'submissions':
        return selectedSubmission ? (
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
            submissions={submissions}
            onSelectSubmission={setSelectedSubmission}
          />
        );
      case 'council':
        return (
          <CouncilManagerManagement
            initialManagers={councilManagers}
            onSave={saveCouncilManagers}
          />
        );
      case 'cadre':
        return (
          <CommsCadreManagement
            members={commsCadreMembers}
            onAddMember={addCommsCadreMember}
            onRemoveMember={removeCommsCadreMember}
          />
        );
      case 'reminders':
        return (
          <ApprovalReminders
            pendingSubmissions={pendingSubmissions}
            councilManagers={councilManagers}
            onSendReminder={sendReminder}
          />
        );
    }
  };

  return (
    <div className="content-management">
      <div className="content-header">
        <h1>Content Management</h1>
        {selectedSubmission && (
          <button
            onClick={() => setSelectedSubmission(null)}
            className="back-button"
          >
            ← Back to Submissions
          </button>
        )}
      </div>

      {!selectedSubmission && (
        <div className="content-tabs">
          <button
            onClick={() => setActiveTab('submissions')}
            className={`tab-button ${activeTab === 'submissions' ? 'active' : ''}`}
          >
            Submissions
          </button>
          <button
            onClick={() => setActiveTab('council')}
            className={`tab-button ${activeTab === 'council' ? 'active' : ''}`}
          >
            Council Management
          </button>
          <button
            onClick={() => setActiveTab('cadre')}
            className={`tab-button ${activeTab === 'cadre' ? 'active' : ''}`}
          >
            Comms Cadre
          </button>
          <button
            onClick={() => setActiveTab('reminders')}
            className={`tab-button ${activeTab === 'reminders' ? 'active' : ''}`}
          >
            Approval Reminders
          </button>
        </div>
      )}

      <div className="content-body">
        {renderContent()}
      </div>
    </div>
  );
}; 