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
    sendReminder
  } = useContent();

  const [selectedSubmission, setSelectedSubmission] = useState<ContentSubmission | null>(null);
  const [activeTab, setActiveTab] = useState<'submissions' | 'council' | 'cadre' | 'reminders'>('submissions');

  const pendingSubmissions = submissions.filter(
    submission => submission.status === 'UNDER_REVIEW'
  );

  if (!currentUser) {
    return <div>Please log in to access content management.</div>;
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
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-3xl font-bold text-gray-900">Content Management</h1>
            {selectedSubmission && (
              <button
                onClick={() => setSelectedSubmission(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                ← Back to Submissions
              </button>
            )}
          </div>

          {!selectedSubmission && (
            <div className="border-b border-gray-200 mb-6">
              <nav className="-mb-px flex space-x-8">
                <button
                  onClick={() => setActiveTab('submissions')}
                  className={`${
                    activeTab === 'submissions'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
                >
                  Submissions
                </button>
                <button
                  onClick={() => setActiveTab('council')}
                  className={`${
                    activeTab === 'council'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
                >
                  Council Management
                </button>
                <button
                  onClick={() => setActiveTab('cadre')}
                  className={`${
                    activeTab === 'cadre'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
                >
                  Comms Cadre
                </button>
                <button
                  onClick={() => setActiveTab('reminders')}
                  className={`${
                    activeTab === 'reminders'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
                >
                  Approval Reminders
                </button>
              </nav>
            </div>
          )}

          <div className="bg-white shadow rounded-lg">
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  );
}; 