import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ContentSubmission, Change, SubmissionStatus } from '../types/content';

interface SubmissionHistoryProps {
  submissions: ContentSubmission[];
  onSelectSubmission: (submission: ContentSubmission) => void;
  onDeleteSubmission: (submissionId: string) => Promise<void>;
  canViewFilteredSubmissions?: boolean;
}

export const SubmissionHistory: React.FC<SubmissionHistoryProps> = ({
  submissions,
  onSelectSubmission,
  onDeleteSubmission,
  canViewFilteredSubmissions = false
}) => {
  const navigate = useNavigate();
  const [selectedStatuses, setSelectedStatuses] = useState<Set<SubmissionStatus | 'all'>>(new Set(['all']));
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [submissionToDelete, setSubmissionToDelete] = useState<ContentSubmission | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

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

  const renderChange = (change: Change) => {
    const formatDate = (timestamp: Date | string | undefined) => {
      if (!timestamp) return 'Unknown date';
      
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) return 'Unknown date';
      
      return date.toLocaleDateString();
    };

    return (
      <div key={change.id} className="text-sm text-gray-600">
        <span className="font-medium">{change.field}</span> changed by {change.changedBy} on {formatDate(change.timestamp)}
      </div>
    );
  };

  const handleDeleteClick = (submission: ContentSubmission, e: React.MouseEvent) => {
    e.stopPropagation();
    setSubmissionToDelete(submission);
    setShowDeleteModal(true);
  };

  const handleDeleteConfirm = async () => {
    if (!submissionToDelete) return;
    
    setIsDeleting(true);
    try {
      await onDeleteSubmission(submissionToDelete.id);
      setShowDeleteModal(false);
      setSubmissionToDelete(null);
    } catch (error) {
      console.error('Error deleting submission:', error);
      // You could add a toast notification here
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteCancel = () => {
    setShowDeleteModal(false);
    setSubmissionToDelete(null);
  };

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
      
      {canViewFilteredSubmissions && (
        <hr className="border-gray-300 my-6" />
      )}
      
      <div className="space-y-4">
        {filteredSubmissions.map((submission, index) => (
          <div key={submission.id}>
            <div className="border rounded-lg overflow-hidden">
              <div className="p-4">
                <div 
                  className="cursor-pointer p-3 rounded-lg border-2 border-dashed border-gray-200 hover:border-blue-400 hover:bg-gray-50 transition-all duration-200"
                  onClick={() => navigate(`/tracked-changes/${submission.id}`)}
                >
                  <h3 className="text-lg font-semibold text-blue-600 hover:text-blue-800 transition-colors">
                    {submission.title}
                  </h3>
                  <p className="text-sm text-gray-600 mt-2">
                    Submitted by {submission.submittedBy} on {submission.submittedAt ? new Date(submission.submittedAt).toLocaleDateString() : 'Unknown date'}
                  </p>
                  <p className="text-sm text-gray-600">Status: {submission.status}</p>
                  
                  <div className="mt-3 flex space-x-2">
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
                
                <div className="btn-group">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectSubmission(submission);
                    }}
                    className="btn btn-secondary btn-with-icon"
                  >
                    <i className="fas fa-eye"></i>
                    <span className="btn-text">View Details</span>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/tracked-changes/${submission.id}`);
                    }}
                    className="btn btn-tertiary btn-with-icon"
                  >
                    <i className="fas fa-history"></i>
                    <span className="btn-text">Tracked Changes</span>
                  </button>
                  <button
                    onClick={(e) => handleDeleteClick(submission, e)}
                    className="btn btn-danger btn-with-icon"
                  >
                    <i className="fas fa-trash"></i>
                    <span className="btn-text">Delete</span>
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
            
            {index < filteredSubmissions.length - 1 && (
              <hr className="border-gray-200 my-6" />
            )}
          </div>
        ))}
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteModal && submissionToDelete && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Delete Request</h3>
              <button 
                className="modal-close"
                onClick={handleDeleteCancel}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>
                Are you sure you want to delete the request "{submissionToDelete.title}"?
              </p>
              <p className="text-sm text-gray-600 mt-2">
                This action cannot be undone. All comments, approvals, and changes associated with this request will be permanently deleted.
              </p>
            </div>
            <div className="modal-footer">
              <button 
                className="btn btn-danger"
                onClick={handleDeleteConfirm}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete Request'}
              </button>
              <button 
                className="btn btn-neutral"
                onClick={handleDeleteCancel}
                disabled={isDeleting}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}; 