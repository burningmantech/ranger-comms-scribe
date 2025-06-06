import React, { useState, useEffect } from 'react';
import { ContentSubmission as ContentSubmissionType, FormField, Comment, Approval, Change, User, SuggestedEdit } from '../types/content';
import LexicalEditorComponent from './editor/LexicalEditor';
import { SuggestionsList } from './SuggestionsList';
import { API_URL } from '../config';

interface ContentSubmissionComponentProps {
  submission: ContentSubmissionType;
  currentUser: User;
  onSave: (submission: ContentSubmissionType) => void;
  onApprove: (submission: ContentSubmissionType) => void;
  onReject: (submission: ContentSubmissionType) => void;
  onComment: (submission: ContentSubmissionType, comment: Comment) => Promise<void>;
  onSuggestionCreate?: (submission: ContentSubmissionType, suggestion: SuggestedEdit) => Promise<void>;
  onSuggestionApprove?: (submission: ContentSubmissionType, suggestionId: string, reason?: string) => Promise<void>;
  onSuggestionReject?: (submission: ContentSubmissionType, suggestionId: string, reason?: string) => Promise<void>;
  users?: User[];
}

interface RolePermissions {
  canEdit: boolean;
  canApprove: boolean;
  canCreateSuggestions: boolean;
  canApproveSuggestions: boolean;
  canReviewSuggestions: boolean;
}

interface UserWithPermissions extends User {
  rolePermissions?: RolePermissions;
}

export const ContentSubmission: React.FC<ContentSubmissionComponentProps> = ({
  submission,
  currentUser,
  onSave,
  onApprove,
  onReject,
  onComment,
  onSuggestionCreate,
  onSuggestionApprove,
  onSuggestionReject,
  users = []
}) => {
  const [newComment, setNewComment] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(submission.content);
  const [editedRichTextContent, setEditedRichTextContent] = useState(submission.richTextContent || submission.content || '');
  const [editedFormFields, setEditedFormFields] = useState(submission.formFields);
  const [localComments, setLocalComments] = useState(submission.comments || []);
  const [localSuggestions, setLocalSuggestions] = useState(submission.suggestedEdits || []);
  const [userPermissions, setUserPermissions] = useState<RolePermissions | null>(null);

  // Fetch user permissions when component mounts
  useEffect(() => {
    const fetchUserPermissions = async () => {
      try {
        const sessionId = localStorage.getItem('sessionId');
        if (!sessionId) return;

        const response = await fetch(`${API_URL}/admin/roles/${currentUser.roles[0]}`, {
          headers: {
            Authorization: `Bearer ${sessionId}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          setUserPermissions(data.role.permissions);
        }
      } catch (error) {
        console.error('Error fetching user permissions:', error);
      }
    };

    fetchUserPermissions();
  }, [currentUser.roles]);

  // Update local state when submission changes
  React.useEffect(() => {
    setLocalComments(submission.comments || []);
    setLocalSuggestions(submission.suggestedEdits || []);
  }, [submission.comments, submission.suggestedEdits]);

  // Use permissions from the backend
  const canEdit = userPermissions?.canEdit || submission.submittedBy === currentUser.id;
  const canApprove = userPermissions?.canApprove || false;
  const canCreateSuggestions = userPermissions?.canCreateSuggestions || false;
  const canApproveSuggestions = userPermissions?.canApproveSuggestions || false;
  const canReviewSuggestions = userPermissions?.canReviewSuggestions || false;

  // Debug: Log user permissions
  console.log('🔍 Current User Debug:', {
    id: currentUser.id,
    userId: (currentUser as any).userId,
    email: currentUser.email,
    name: currentUser.name,  
    roles: currentUser.roles,
    fullUserObject: currentUser,
    canCreateSuggestions: currentUser.roles.includes('CommsCadre') || 
                         currentUser.roles.includes('CouncilManager') ||
                         (currentUser as any).isAdmin
  });

  // Use email as fallback for user ID since the id field is undefined
  const effectiveUserId = currentUser.id || currentUser.email;

  // Debug: Log permission calculations
  console.log('🔑 Permission Debug:', {
    userRoles: currentUser.roles,
    canEdit,
    canApprove,
    canCreateSuggestions,
    canApproveSuggestions,
    canReviewSuggestions,
    effectiveUserId,
    isEditing
  });

  const handleAddFormField = () => {
    const newField: FormField = {
      id: crypto.randomUUID(),
      label: '',
      type: 'text',
      value: '',
      required: false
    };
    setEditedFormFields([...editedFormFields, newField]);
  };

  const handleFormFieldChange = (id: string, field: keyof FormField, value: any) => {
    setEditedFormFields(editedFormFields.map(f => 
      f.id === id ? { ...f, [field]: value } : f
    ));
  };

  const handleEditorChange = (editor: any, json: string) => {
    setEditedRichTextContent(json);
  };

  const handleSuggestionCreate = async (suggestion: SuggestedEdit) => {
    if (onSuggestionCreate) {
      try {
        // Optimistically update local state
        setLocalSuggestions(prev => [...prev, suggestion]);
        
        await onSuggestionCreate(submission, suggestion);
      } catch (error: any) {
        console.error('Failed to create suggestion:', error);
        // Revert local state on error
        setLocalSuggestions(prev => prev.filter(s => s.id !== suggestion.id));
      }
    }
  };

  const handleSuggestionApprove = async (suggestionId: string, reason?: string) => {
    if (onSuggestionApprove) {
      try {
        // Optimistically update local state
        setLocalSuggestions(prev => prev.map(s => 
          s.id === suggestionId 
            ? { 
                ...s, 
                status: 'APPROVED' as const, 
                reviewerId: effectiveUserId, 
                reviewedAt: new Date(),
                reason 
              }
            : s
        ));
        
        await onSuggestionApprove(submission, suggestionId, reason);
      } catch (error: any) {
        console.error('Failed to approve suggestion:', error);
        // Revert local state on error
        setLocalSuggestions(prev => prev.map(s => 
          s.id === suggestionId ? { ...s, status: 'PENDING' as const } : s
        ));
      }
    }
  };

  const handleSuggestionReject = async (suggestionId: string, reason?: string) => {
    if (onSuggestionReject) {
      try {
        // Optimistically update local state
        setLocalSuggestions(prev => prev.map(s => 
          s.id === suggestionId 
            ? { 
                ...s, 
                status: 'REJECTED' as const, 
                reviewerId: effectiveUserId, 
                reviewedAt: new Date(),
                reason 
              }
            : s
        ));
        
        await onSuggestionReject(submission, suggestionId, reason);
      } catch (error: any) {
        console.error('Failed to reject suggestion:', error);
        // Revert local state on error
        setLocalSuggestions(prev => prev.map(s => 
          s.id === suggestionId ? { ...s, status: 'PENDING' as const } : s
        ));
      }
    }
  };

  const handleSave = () => {
    const changes: Change[] = [];
    if (editedContent !== submission.content) {
      changes.push({
        id: crypto.randomUUID(),
        field: 'content',
        oldValue: submission.content,
        newValue: editedContent,
        changedBy: effectiveUserId,
        timestamp: new Date()
      });
    }
    if (editedRichTextContent !== submission.richTextContent) {
      changes.push({
        id: crypto.randomUUID(),
        field: 'richTextContent',
        oldValue: submission.richTextContent || '',
        newValue: editedRichTextContent,
        changedBy: effectiveUserId,
        timestamp: new Date()
      });
    }

    onSave({
      ...submission,
      content: editedContent,
      richTextContent: editedRichTextContent,
      formFields: editedFormFields,
      changes: [...submission.changes, ...changes]
    });
    setIsEditing(false);
  };

  const handleAddComment = async () => {
    if (newComment.trim()) {
      const comment: Comment = {
        id: crypto.randomUUID(),
        content: newComment,
        authorId: effectiveUserId,
        createdAt: new Date(),
        type: 'COMMENT',
        resolved: false
      };
      
      // Optimistically update local state
      setLocalComments(prev => [...prev, comment]);
      setNewComment('');
      
      // Call the context method to persist to backend
      try {
        await onComment(submission, comment);
      } catch (error: any) {
        console.error('Failed to add comment:', error);
        // Revert local state on error
        setLocalComments(prev => prev.filter(c => c.id !== comment.id));
      }
    }
  };

  return (
    <div className="p-4">
      <div className="mb-6 bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-2xl font-bold mb-2">{submission.title}</h2>
        <p className="text-sm text-gray-600">
          Submitted by {submission.submittedBy} on {submission.submittedAt ? new Date(submission.submittedAt).toLocaleDateString() : 'Unknown date'}
        </p>
        <p className="text-sm text-gray-600">Status: {submission.status}</p>
      </div>

      {isEditing ? (
        <div className="mb-6 bg-white rounded-lg shadow-sm p-6">
          <LexicalEditorComponent
            initialContent={editedRichTextContent}
            onChange={handleEditorChange}
            placeholder="Edit the content..."
            className="h-96"
            currentUserId={effectiveUserId}
            onSuggestionCreate={handleSuggestionCreate}
            onSuggestionApprove={handleSuggestionApprove}
            onSuggestionReject={handleSuggestionReject}
            canCreateSuggestions={canCreateSuggestions}
            canApproveSuggestions={canApproveSuggestions}
          />

          <div className="mt-4 flex space-x-3">
            <button
              onClick={handleSave}
              className="btn btn-primary btn-with-icon"
            >
              <i className="fas fa-save"></i>
              <span className="btn-text">Save Changes</span>
            </button>
            <button
              onClick={() => setIsEditing(false)}
              className="btn btn-neutral btn-with-icon"
            >
              <i className="fas fa-times"></i>
              <span className="btn-text">Cancel</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-6 bg-white rounded-lg shadow-sm p-6">
          <div className="prose max-w-none">
            <LexicalEditorComponent
              initialContent={submission.richTextContent || submission.content || ''}
              readOnly={true}
              showToolbar={false}
              className="h-96"
              currentUserId={effectiveUserId}
              onSuggestionCreate={handleSuggestionCreate}
              onSuggestionApprove={handleSuggestionApprove}
              onSuggestionReject={handleSuggestionReject}
              canCreateSuggestions={canCreateSuggestions}
              canApproveSuggestions={canApproveSuggestions}
            />
          </div>
          
          <div className="mt-6 bg-gray-50 rounded-lg p-4">
            <h3 className="text-lg font-semibold mb-3">Form Fields</h3>
            <table className="w-full">
              <tbody>
                {submission.formFields?.map((field) => (
                  <tr key={field.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-4 font-medium text-gray-700 editor-text-italic">{field.label}:</td>
                    <td className="py-2 text-gray-600">{field.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canEdit && (
            <button
              onClick={() => setIsEditing(true)}
              className="btn btn-tertiary btn-with-icon"
            >
              <i className="fas fa-edit"></i>
              <span className="btn-text">Edit Content</span>
            </button>
          )}
        </div>
      )}

      {/* Suggested Edits Section */}
      {(localSuggestions.length > 0 || canCreateSuggestions) && (
        <SuggestionsList
          suggestions={localSuggestions}
          currentUser={currentUser}
          onApproveSuggestion={handleSuggestionApprove}
          onRejectSuggestion={handleSuggestionReject}
          users={users}
        />
      )}

      <div className="mt-8 bg-white rounded-lg shadow-sm p-6">
        <h3 className="text-lg font-semibold mb-4">Comments</h3>
        <div className="space-y-4">
          {localComments.map((comment) => (
            <div key={comment.id} className="p-4 bg-gray-50 rounded-lg shadow-sm">
              <p className="text-sm text-gray-600">
                {currentUser.email} - {comment.createdAt ? new Date(comment.createdAt).toLocaleDateString() : 'Unknown date'}
              </p>
              <p className="mt-2 text-gray-700">{comment.content}</p>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <div className="flex flex-col space-y-3">
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              className="w-full p-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors duration-200"
              rows={3}
              placeholder="Add a comment..."
            />
            <div className="flex justify-end">
              <button
                onClick={handleAddComment}
                className="btn btn-tertiary btn-with-icon"
              >
                <i className="fas fa-comment"></i>
                <span className="btn-text">Add Comment</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {canApprove && submission.status === 'in_review' && (
        <div className="mt-8 flex space-x-4">
          <button
            onClick={() => onApprove(submission)}
            className="btn btn-primary btn-with-icon"
          >
            <i className="fas fa-check"></i>
            <span className="btn-text">Approve</span>
          </button>
          <button
            onClick={() => onReject(submission)}
            className="btn btn-danger btn-with-icon"
          >
            <i className="fas fa-times"></i>
            <span className="btn-text">Reject</span>
          </button>
        </div>
      )}
    </div>
  );
}; 