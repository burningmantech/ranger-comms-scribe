import React, { useState } from 'react';
import { ContentSubmission } from '../components/ContentSubmission';
import { ContentSubmission as ContentSubmissionType, User, SuggestedEdit, Comment } from '../types/content';

// Example usage of the Suggested Edits functionality
export const SuggestedEditsExample: React.FC = () => {
  // Mock data for demonstration
  const [submission, setSubmission] = useState<ContentSubmissionType>({
    id: 'submission-1',
    title: 'Sample Content Submission',
    content: 'This is the original content that can be edited with suggestions.',
    richTextContent: '{"root":{"children":[{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"This is the original content that can be edited with suggestions.","type":"text","version":1}],"direction":"ltr","format":"","indent":0,"type":"paragraph","version":1}],"direction":"ltr","format":"","indent":0,"type":"root","version":1}}',
    status: 'in_review',
    submittedBy: 'user-2',
    submittedAt: new Date('2024-01-15'),
    formFields: [
      {
        id: 'field-1',
        label: 'Target Audience',
        type: 'text',
        value: 'General Public',
        required: true
      }
    ],
    comments: [
      {
        id: 'comment-1',
        content: 'This looks good, but I have some suggestions for improvements.',
        authorId: 'user-1',
        createdAt: new Date('2024-01-16'),
        type: 'COMMENT',
        resolved: false
      }
    ],
    approvals: [],
    changes: [],
    assignedReviewers: ['user-1'],
    assignedCouncilManagers: [],
    suggestedEdits: [
      {
        id: 'suggestion-1',
        originalText: 'original content',
        suggestedText: 'improved content',
        range: {
          startOffset: 12,
          endOffset: 28,
          startKey: 'text-node-1',
          endKey: 'text-node-1'
        },
        authorId: 'user-1',
        createdAt: new Date('2024-01-16'),
        status: 'PENDING'
      }
    ]
  });

  const [users] = useState<User[]>([
    {
      id: 'user-1',
      email: 'reviewer@example.com',
      name: 'Jane Reviewer',
      roles: ['REVIEWER', 'CommsCadre']
    },
    {
      id: 'user-2', 
      email: 'submitter@example.com',
      name: 'John Submitter',
      roles: ['SUBMITTER']
    },
    {
      id: 'user-3',
      email: 'manager@example.com', 
      name: 'Sarah Manager',
      roles: ['CouncilManager']
    }
  ]);

  // Current user - for this example, we're a reviewer who can create and approve suggestions
  const currentUser = users[0]; // Jane Reviewer

  // Event handlers
  const handleSave = (updatedSubmission: ContentSubmissionType) => {
    setSubmission(updatedSubmission);
    console.log('Submission saved:', updatedSubmission);
  };

  const handleApprove = (submission: ContentSubmissionType) => {
    console.log('Submission approved:', submission);
    setSubmission({ ...submission, status: 'approved' });
  };

  const handleReject = (submission: ContentSubmissionType) => {
    console.log('Submission rejected:', submission);
    setSubmission({ ...submission, status: 'rejected' });
  };

  const handleComment = async (submission: ContentSubmissionType, comment: Comment) => {
    console.log('New comment added:', comment);
    setSubmission({
      ...submission,
      comments: [...submission.comments, comment]
    });
  };

  const handleSuggestionCreate = async (submission: ContentSubmissionType, suggestion: SuggestedEdit) => {
    console.log('New suggestion created:', suggestion);
    setSubmission({
      ...submission,
      suggestedEdits: [...submission.suggestedEdits, suggestion]
    });
  };

  const handleSuggestionApprove = async (submission: ContentSubmissionType, suggestionId: string, reason?: string) => {
    console.log('Suggestion approved:', suggestionId, reason);
    setSubmission({
      ...submission,
      suggestedEdits: submission.suggestedEdits.map(s =>
        s.id === suggestionId
          ? { 
              ...s, 
              status: 'APPROVED' as const, 
              reviewerId: currentUser.id,
              reviewedAt: new Date(),
              reason 
            }
          : s
      )
    });
  };

  const handleSuggestionReject = async (submission: ContentSubmissionType, suggestionId: string, reason?: string) => {
    console.log('Suggestion rejected:', suggestionId, reason);
    setSubmission({
      ...submission,
      suggestedEdits: submission.suggestedEdits.map(s =>
        s.id === suggestionId
          ? { 
              ...s, 
              status: 'REJECTED' as const, 
              reviewerId: currentUser.id,
              reviewedAt: new Date(),
              reason 
            }
          : s
      )
    });
  };

  return (
    <div className="min-h-screen bg-gray-100 py-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900 mb-4">
            Suggested Edits Example
          </h1>
          <p className="text-lg text-gray-600">
            This demonstrates the suggested edits functionality. You can:
          </p>
          <ul className="text-sm text-gray-500 mt-2 space-y-1">
            <li>• Select text in the editor to create suggestions</li>
            <li>• View pending and reviewed suggestions</li>
            <li>• Approve or reject suggestions with reasons</li>
            <li>• See inline suggestion indicators in the content</li>
          </ul>
        </div>

        <ContentSubmission
          submission={submission}
          currentUser={currentUser}
          onSave={handleSave}
          onApprove={handleApprove}
          onReject={handleReject}
          onComment={handleComment}
          onSuggestionCreate={handleSuggestionCreate}
          onSuggestionApprove={handleSuggestionApprove}
          onSuggestionReject={handleSuggestionReject}
          users={users}
        />
      </div>
    </div>
  );
};

export default SuggestedEditsExample; 