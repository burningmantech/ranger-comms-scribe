import React, { useState } from 'react';
import { ContentSubmission as ContentSubmissionType, FormField, Comment, Approval, Change, User } from '../types/content';

interface ContentSubmissionComponentProps {
  submission: ContentSubmissionType;
  currentUser: User;
  onSave: (submission: ContentSubmissionType) => void;
  onApprove: (submission: ContentSubmissionType) => void;
  onReject: (submission: ContentSubmissionType) => void;
  onComment: (submission: ContentSubmissionType, comment: Comment) => void;
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
  const [editedFormFields, setEditedFormFields] = useState(submission.formFields);

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

    onSave({
      ...submission,
      content: editedContent,
      formFields: editedFormFields,
      changes: [...submission.changes, ...changes]
    });
    setIsEditing(false);
  };

  const handleAddComment = () => {
    if (newComment.trim()) {
      const comment: Comment = {
        id: crypto.randomUUID(),
        content: newComment,
        authorId: currentUser.id,
        createdAt: new Date(),
        type: 'COMMENT',
        resolved: false
      };
      onComment(submission, comment);
      setNewComment('');
    }
  };

  return (
    <div className="p-4">
      <div className="mb-6">
        <h2 className="text-2xl font-bold mb-2">{submission.title}</h2>
        <p className="text-sm text-gray-600">
          Submitted by {submission.submittedBy} on {submission.submittedAt.toLocaleDateString()}
        </p>
        <p className="text-sm text-gray-600">Status: {submission.status}</p>
      </div>

      {isEditing ? (
        <div className="mb-6">
          <textarea
            value={editedContent}
            onChange={(e) => setEditedContent(e.target.value)}
            className="w-full p-2 border rounded min-h-[200px]"
          />
          
          <div className="mt-4">
            <h3 className="text-lg font-semibold mb-2">Form Fields</h3>
            {editedFormFields.map((field) => (
              <div key={field.id} className="mb-4 p-3 border rounded">
                <input
                  type="text"
                  value={field.label}
                  onChange={(e) => handleFormFieldChange(field.id, 'label', e.target.value)}
                  placeholder="Field Label"
                  className="w-full p-2 border rounded mb-2"
                />
                <select
                  value={field.type}
                  onChange={(e) => handleFormFieldChange(field.id, 'type', e.target.value)}
                  className="w-full p-2 border rounded mb-2"
                >
                  <option value="text">Text</option>
                  <option value="date">Date</option>
                  <option value="time">Time</option>
                  <option value="select">Select</option>
                  <option value="multiselect">Multi-select</option>
                </select>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={field.required}
                    onChange={(e) => handleFormFieldChange(field.id, 'required', e.target.checked)}
                    className="mr-2"
                  />
                  Required
                </label>
              </div>
            ))}
            <button
              onClick={handleAddFormField}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              Add Form Field
            </button>
          </div>

          <div className="mt-4 flex space-x-2">
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
            >
              Save Changes
            </button>
            <button
              onClick={() => setIsEditing(false)}
              className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-6">
          <div className="prose max-w-none">
            {submission.content}
          </div>
          
          <div className="mt-4">
            <h3 className="text-lg font-semibold mb-2">Form Fields</h3>
            {submission.formFields.map((field) => (
              <div key={field.id} className="mb-2">
                <label className="font-medium">{field.label}</label>
                <p className="text-gray-600">{field.value}</p>
              </div>
            ))}
          </div>

          {canEdit && (
            <button
              onClick={() => setIsEditing(true)}
              className="mt-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              Edit Content
            </button>
          )}
        </div>
      )}

      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">Comments</h3>
        <div className="space-y-4">
          {submission.comments.map((comment) => (
            <div key={comment.id} className="p-3 border rounded">
              <p className="text-sm text-gray-600">
                {comment.authorId} - {comment.createdAt.toLocaleDateString()}
              </p>
              <p>{comment.content}</p>
              <p className="text-sm text-gray-500">Type: {comment.type}</p>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder="Add a comment..."
            className="w-full p-2 border rounded"
          />
          <button
            onClick={handleAddComment}
            className="mt-2 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Add Comment
          </button>
        </div>
      </div>

      {canApprove && (
        <div className="flex space-x-2">
          <button
            onClick={() => onApprove(submission)}
            className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
          >
            Approve
          </button>
          <button
            onClick={() => onReject(submission)}
            className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}; 