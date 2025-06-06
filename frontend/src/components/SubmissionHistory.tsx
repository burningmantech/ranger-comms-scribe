import React from 'react';
import { ContentSubmission, Change } from '../types/content';

interface SubmissionHistoryProps {
  submissions: ContentSubmission[];
  onSelectSubmission: (submission: ContentSubmission) => void;
}

export const SubmissionHistory: React.FC<SubmissionHistoryProps> = ({
  submissions,
  onSelectSubmission
}) => {
  const renderChange = (change: Change) => (
    <div key={change.id} className="p-2 border-b">
      <p className="text-sm text-gray-600">
        Changed by {change.changedBy} on {new Date(change.timestamp).toLocaleDateString()}
      </p>
      <div className="mt-1">
        <p className="text-sm font-medium">Field: {change.field}</p>
        <div className="grid grid-cols-2 gap-4 mt-1">
          <div>
            <p className="text-xs text-gray-500">Old Value:</p>
            <p className="text-sm">{change.oldValue}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">New Value:</p>
            <p className="text-sm">{change.newValue}</p>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold mb-4">Submission History</h2>
      
      <div className="space-y-4">
        {submissions.map((submission) => (
          <div key={submission.id} className="border rounded-lg overflow-hidden">
            <div 
              className="p-4 cursor-pointer hover:bg-gray-50"
              onClick={() => onSelectSubmission(submission)}
            >
              <h3 className="text-lg font-semibold">{submission.title}</h3>
              <p className="text-sm text-gray-600">
                Submitted by {submission.submittedBy} on {submission.submittedAt ? new Date(submission.submittedAt).toLocaleDateString() : 'Unknown date'}
              </p>
              <p className="text-sm text-gray-600">Status: {submission.status}</p>
              
              <div className="mt-2 flex">
                <span className="px-2 py-1 text-xs rounded bg-blue-100 text-blue-800">
                  {`${submission.comments?.length || 0} Comments `}
                </span>
                <span className="px-2 py-1 text-xs rounded bg-green-100 text-green-800">
                  {`${submission.approvals?.length || 0} Approvals `}
                </span>
                <span className="px-2 py-1 text-xs rounded bg-purple-100 text-purple-800">
                  {`${submission.changes?.length || 0} Changes`}
                </span>
              </div>
            </div>

            {submission.changes?.length > 0 && (
              <div className="border-t">
                <div className="p-4">
                  <h4 className="text-sm font-semibold mb-2">Recent Changes</h4>
                  {submission.changes.slice(-3).map(renderChange)}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}; 