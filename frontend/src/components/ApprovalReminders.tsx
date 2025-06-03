import React from 'react';
import { ContentSubmission, User, CouncilManager } from '../types/content';

interface ApprovalRemindersProps {
  pendingSubmissions: ContentSubmission[];
  councilManagers: CouncilManager[];
  onSendReminder: (submission: ContentSubmission, manager: CouncilManager) => void;
}

export const ApprovalReminders: React.FC<ApprovalRemindersProps> = ({
  pendingSubmissions,
  councilManagers,
  onSendReminder
}) => {
  const getPendingApprovers = (submission: ContentSubmission) => {
    return councilManagers.filter(manager => 
      !submission.approvals.some(approval => 
        approval.approverId === manager.id && 
        approval.status !== 'PENDING'
      )
    );
  };

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold mb-4">Pending Approvals</h2>
      
      <div className="space-y-6">
        {pendingSubmissions.map((submission) => {
          const pendingApprovers = getPendingApprovers(submission);
          
          return (
            <div key={submission.id} className="border rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-2">{submission.title}</h3>
              <p className="text-sm text-gray-600">
                Submitted by {submission.submittedBy} on {submission.submittedAt.toLocaleDateString()}
              </p>
              
              <div className="mt-4">
                <h4 className="text-sm font-semibold mb-2">Pending Approvers</h4>
                <div className="space-y-2">
                  {pendingApprovers.map((approver) => (
                    <div key={approver.id} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                      <div>
                        <p className="font-medium">{approver.name}</p>
                        <p className="text-sm text-gray-600">{approver.email}</p>
                      </div>
                      <button
                        onClick={() => onSendReminder(submission, approver)}
                        className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
                      >
                        Send Reminder
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4">
                <h4 className="text-sm font-semibold mb-2">Approval Status</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-gray-600">Approved:</p>
                    <p className="font-medium">
                      {submission.approvals.filter(a => a.status === 'APPROVED').length}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Rejected:</p>
                    <p className="font-medium">
                      {submission.approvals.filter(a => a.status === 'REJECTED').length}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}; 