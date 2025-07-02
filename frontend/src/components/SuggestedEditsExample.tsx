import React, { useState } from 'react';
import { ContentSubmission as ContentSubmissionType, User } from '../types/content';
import { ContentSubmission } from './ContentSubmission';

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
    requiredApprovers: ['council.manager@example.com'],
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
      email: 'user1@example.com',
      name: 'User One',
      roles: ['Admin']
    },
    {
      id: 'user-2',
      email: 'user2@example.com',
      name: 'User Two',
      roles: ['CouncilManager']
    }
  ]);

  const currentUser = users[0];

  const handleSave = (updatedSubmission: ContentSubmissionType) => {
    setSubmission(updatedSubmission);
  };

  const handleApprove = (updatedSubmission: ContentSubmissionType) => {
    setSubmission(updatedSubmission);
  };

  const handleReject = (updatedSubmission: ContentSubmissionType) => {
    setSubmission(updatedSubmission);
  };

  const handleComment = async (updatedSubmission: ContentSubmissionType, comment: any) => {
    setSubmission(updatedSubmission);
  };

  return (
    <div className="p-4">
      <ContentSubmission
        submission={submission}
        currentUser={currentUser}
        onSave={handleSave}
        onApprove={handleApprove}
        onReject={handleReject}
        onComment={handleComment}
        users={users}
      />
    </div>
  );
}; 