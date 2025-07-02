import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ContentSubmission, Change, SubmissionStatus } from '../types/content';

interface SubmissionHistoryProps {
  submissions: ContentSubmission[];
  onSelectSubmission: (submission: ContentSubmission) => void;
  canViewFilteredSubmissions?: boolean;
}

export const SubmissionHistory: React.FC<SubmissionHistoryProps> = ({
  submissions,
  onSelectSubmission,
  canViewFilteredSubmissions = false
}) => {
  const navigate = useNavigate();
  const [selectedStatuses, setSelectedStatuses] = useState<Set<SubmissionStatus | 'all'>>(new Set(['all']));

  const allStatuses: (SubmissionStatus | 'all')[] = ['all', 'draft', 'submitted', 'in_review', 'approved', 'rejected', 'sent'];

  const handleStatusChange = (status: SubmissionStatus | 'all') => {
    const newSelectedStatuses = new Set(selectedStatuses);
    
    if (status === 'all') {
      if (newSelectedStatuses.has('all')) {
        newSelectedStatuses.clear();
        newSelectedStatuses.add('submitted');
      } else {
        allStatuses.forEach(s => newSelectedStatuses.add(s));
      }
    } else {
      newSelectedStatuses.delete('all');
      if (newSelectedStatuses.has(status)) {
        if (newSelectedStatuses.size > 1) {
          newSelectedStatuses.delete(status);
        }
      } else {
        newSelectedStatuses.add(status);
      }
    }
    
    setSelectedStatuses(newSelectedStatuses);
  };

  const filteredSubmissions = selectedStatuses.has('all') || selectedStatuses.size === 0
    ? submissions 
    : submissions.filter(sub => selectedStatuses.has(sub.status));

  const renderChange = (change: Change) => (
    <div key={change.id} className="text-sm text-gray-600">
      <span className="font-medium">{change.field}</span> changed by {change.changedBy} on {new Date(change.timestamp).toLocaleDateString()}
    </div>
  );

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold mb-4">Submission History</h2>
      
      {canViewFilteredSubmissions && (
        <div className="mb-6 p-4 bg-white rounded-lg shadow-sm">
          <h3 className="text-lg font-semibold mb-3">Filter by Status</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {allStatuses.map((status) => (
              <label key={status} className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={selectedStatuses.has(status)}
                  onChange={() => handleStatusChange(status)}
                  className="form-checkbox h-5 w-5 text-blue-600 rounded focus:ring-blue-500"
                />
                <span className="text-gray-700 capitalize">
                  {status === 'all' ? 'All Statuses' : status.replace('_', ' ')}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      
      <div className="space-y-4">
        {filteredSubmissions.map((submission) => (
          <div key={submission.id} className="border rounded-lg overflow-hidden">
            <div className="p-4">
              <div 
                className="cursor-pointer hover:bg-gray-50"
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
              
              <div className="mt-3 flex space-x-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectSubmission(submission);
                  }}
                  className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  View Details
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/tracked-changes/${submission.id}`);
                  }}
                  className="px-3 py-1 text-sm bg-gray-600 text-white rounded hover:bg-gray-700"
                >
                  Tracked Changes
                </button>
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