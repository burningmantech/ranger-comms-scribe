import React, { useState } from 'react';
import { SuggestedEdit, User } from '../types/content';

interface SuggestionsListProps {
  suggestions: SuggestedEdit[];
  currentUser: User;
  onApproveSuggestion: (suggestionId: string, reason?: string) => void;
  onRejectSuggestion: (suggestionId: string, reason?: string) => void;
  onCommentOnSuggestion?: (suggestionId: string, comment: string) => void;
  users: User[];
}

export const SuggestionsList: React.FC<SuggestionsListProps> = ({
  suggestions,
  currentUser,
  onApproveSuggestion,
  onRejectSuggestion,
  onCommentOnSuggestion,
  users = [],
}) => {
  const [activeAction, setActiveAction] = useState<{
    suggestionId: string;
    action: 'approve' | 'reject';
  } | null>(null);
  const [reason, setReason] = useState('');

  const canReviewSuggestions = currentUser.roles.includes('CommsCadre') ||
                            currentUser.roles.includes('CouncilManager');

  const getUserName = (userId: string) => {
    const user = users.find(u => u.id === userId);
    return user ? user.name || user.email : userId;
  };

  const formatDate = (date: Date | string | undefined) => {
    if (!date) return '';
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    return dateObj.toLocaleDateString();
  };

  const handleActionConfirm = () => {
    if (!activeAction) return;

    if (activeAction.action === 'approve') {
      onApproveSuggestion(activeAction.suggestionId, reason.trim() || undefined);
    } else {
      onRejectSuggestion(activeAction.suggestionId, reason.trim() || undefined);
    }

    setActiveAction(null);
    setReason('');
  };

  const handleActionCancel = () => {
    setActiveAction(null);
    setReason('');
  };

  const pendingSuggestions = suggestions.filter(s => s.status === 'PENDING');
  const reviewedSuggestions = suggestions.filter(s => s.status !== 'PENDING');

  if (suggestions.length === 0) {
    return (
      <div className="suggestions-list">
        <h3>Suggested Edits</h3>
        <p className="text-center text-gray-500">No suggested edits for this submission.</p>
      </div>
    );
  }

  return (
    <div className="suggestions-list">
      <h3>Suggested Edits ({suggestions.length})</h3>
      
      {pendingSuggestions.length > 0 && (
        <>
          <h4 className="suggestions-section-title">Pending Review ({pendingSuggestions.length})</h4>
          {pendingSuggestions.map((suggestion) => (
            <div key={suggestion.id} className="suggestion-item">
              <div className="suggestion-meta">
                <div>
                  <span className="suggestion-author">
                    Suggested by {getUserName(suggestion.authorId)}
                  </span>
                  <span className="suggestion-date">
                    {formatDate(suggestion.createdAt)}
                  </span>
                </div>
                <span className={`suggestion-status ${suggestion.status.toLowerCase()}`}>
                  {suggestion.status}
                </span>
              </div>

              <div className="suggestion-content">
                <div className="suggestion-text-compare">
                  <div className="suggestion-text-before">
                    <strong>Original:</strong><br />
                    {suggestion.originalText}
                  </div>
                  <div className="suggestion-text-after">
                    <strong>Suggested:</strong><br />
                    {suggestion.suggestedText}
                  </div>
                </div>
              </div>

              {canReviewSuggestions && suggestion.status === 'PENDING' && (
                <div className="suggestion-actions">
                  <button
                    className="btn btn-tertiary btn-sm"
                    onClick={() => setActiveAction({ 
                      suggestionId: suggestion.id, 
                      action: 'approve' 
                    })}
                  >
                    <i className="fas fa-check"></i>
                    <span className="btn-text">Approve</span>
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => setActiveAction({ 
                      suggestionId: suggestion.id, 
                      action: 'reject' 
                    })}
                  >
                    <i className="fas fa-times"></i>
                    <span className="btn-text">Reject</span>
                  </button>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {reviewedSuggestions.length > 0 && (
        <>
          <h4 className="suggestions-section-title">Reviewed ({reviewedSuggestions.length})</h4>
          {reviewedSuggestions.map((suggestion) => (
            <div key={suggestion.id} className="suggestion-item">
              <div className="suggestion-meta">
                <div>
                  <span className="suggestion-author">
                    Suggested by {getUserName(suggestion.authorId)}
                  </span>
                  <span className="suggestion-date">
                    {formatDate(suggestion.createdAt)}
                  </span>
                  {suggestion.reviewedAt && (
                    <span className="suggestion-date">
                      • Reviewed {formatDate(suggestion.reviewedAt)}
                    </span>
                  )}
                </div>
                <span className={`suggestion-status ${suggestion.status.toLowerCase()}`}>
                  {suggestion.status}
                </span>
              </div>

              <div className="suggestion-content">
                <div className="suggestion-text-compare">
                  <div className="suggestion-text-before">
                    <strong>Original:</strong><br />
                    {suggestion.originalText}
                  </div>
                  <div className="suggestion-text-after">
                    <strong>Suggested:</strong><br />
                    {suggestion.suggestedText}
                  </div>
                </div>
                {suggestion.reason && (
                  <div className="suggestion-reason">
                    <strong>Reason:</strong> {suggestion.reason}
                  </div>
                )}
              </div>
            </div>
          ))}
        </>
      )}

      {activeAction && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>
                {activeAction.action === 'approve' ? 'Approve' : 'Reject'} Suggestion
              </h3>
              <button 
                className="modal-close"
                onClick={handleActionCancel}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>
                Are you sure you want to {activeAction.action} this suggestion?
              </p>
              <div className="form-group">
                <label>Reason (optional):</label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="form-control"
                  rows={3}
                  placeholder={`Optional reason for ${activeAction.action}ing this suggestion...`}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button 
                className={`btn ${activeAction.action === 'approve' ? 'btn-tertiary' : 'btn-danger'}`}
                onClick={handleActionConfirm}
              >
                {activeAction.action === 'approve' ? 'Approve' : 'Reject'}
              </button>
              <button 
                className="btn btn-neutral"
                onClick={handleActionCancel}
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