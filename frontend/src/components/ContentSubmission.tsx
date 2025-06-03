import React, { useState } from 'react';
import { ContentSubmission as ContentSubmissionType, FormField, Comment, Approval, Change, User } from '../types/content';
import LexicalEditorComponent from './editor/LexicalEditor';

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
  const [editedRichTextContent, setEditedRichTextContent] = useState(submission.richTextContent || '');
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
          <LexicalEditorComponent
            initialContent={editedRichTextContent}
            onChange={handleEditorChange}
            placeholder="Edit the content..."
            className="h-96"
          />

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
            <LexicalEditorComponent
              initialContent={submission.richTextContent || ''}
              readOnly={true}
              showToolbar={false}
              className="h-96"
            />
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

      <div className="mt-8">
        <h3 className="text-lg font-semibold mb-4">Comments</h3>
        <div className="space-y-4">
          {submission.comments.map((comment) => (
            <div key={comment.id} className="p-4 bg-gray-50 rounded">
              <p className="text-sm text-gray-600">
                {comment.authorId} - {comment.createdAt.toLocaleDateString()}
              </p>
              <p className="mt-2">{comment.content}</p>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            className="w-full p-2 border rounded"
            rows={3}
            placeholder="Add a comment..."
          />
          <button
            onClick={handleAddComment}
            className="mt-2 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Add Comment
          </button>
        </div>
      </div>

      {canApprove && submission.status === 'in_review' && (
        <div className="mt-8 flex space-x-4">
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