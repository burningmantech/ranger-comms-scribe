import React, { useState } from 'react';
import { ContentSubmission as ContentSubmissionType, FormField, Comment, Approval, Change, User } from '../types/content';
import LexicalEditorComponent from './editor/LexicalEditor';

interface ContentSubmissionComponentProps {
  submission: ContentSubmissionType;
  currentUser: User;
  onSave: (submission: ContentSubmissionType) => void;
  onApprove: (submission: ContentSubmissionType) => void;
  onReject: (submission: ContentSubmissionType) => void;
  onComment: (submission: ContentSubmissionType, comment: Comment) => Promise<void>;
}

export const ContentSubmission: React.FC<ContentSubmissionComponentProps> = ({
  submission,
  currentUser,
  onSave,
  onApprove,
  onReject,
  onComment
}) => {
  const [newComment, setNewComment] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(submission.content);
  const [editedRichTextContent, setEditedRichTextContent] = useState(submission.richTextContent || '');
  const [editedFormFields, setEditedFormFields] = useState(submission.formFields);
  const [localComments, setLocalComments] = useState(submission.comments || []);

  // Update local comments when submission changes
  React.useEffect(() => {
    setLocalComments(submission.comments || []);
  }, [submission.comments]);

  const canEdit = currentUser.roles.includes('COMMS_CADRE') || 
                 currentUser.roles.includes('COUNCIL_MANAGER') ||
                 submission.submittedBy === currentUser.id;

  const canApprove = currentUser.roles.includes('COMMS_CADRE') || 
                    currentUser.roles.includes('COUNCIL_MANAGER');

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

  const handleSave = () => {
    const changes: Change[] = [];
    if (editedContent !== submission.content) {
      changes.push({
        id: crypto.randomUUID(),
        field: 'content',
        oldValue: submission.content,
        newValue: editedContent,
        changedBy: currentUser.id,
        timestamp: new Date()
      });
    }
    if (editedRichTextContent !== submission.richTextContent) {
      changes.push({
        id: crypto.randomUUID(),
        field: 'richTextContent',
        oldValue: submission.richTextContent || '',
        newValue: editedRichTextContent,
        changedBy: currentUser.id,
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
        authorId: currentUser.id,
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