import React, { useState } from 'react';
import { TrackedChangesEditor } from '../components/TrackedChangesEditor';
import { ContentSubmission, User, Comment, Change, Approval } from '../types/content';

// Demo data
const demoUser: User = {
  id: 'user-1',
  email: 'demo@example.com',
  name: 'Demo User',
  roles: ['CommsCadre', 'REVIEWER']
};

const initialSubmission: ContentSubmission = {
  id: 'submission-1',
  title: 'Communications Request: Annual Fundraiser Event',
  content: `Dear Communications Team,

We are planning our annual fundraiser event for next month and would like to request your assistance with the promotional materials and media coverage.

The event will take place on Saturday, March 15th, 2024, at the Community Center from 6:00 PM to 10:00 PM. We expect approximately 200 attendees including donors, volunteers, and community members.

We would need the following communications support:
- Event poster design and printing (100 copies)
- Social media campaign starting two weeks before the event
- Press release to local media outlets
- Event photography and videography
- Thank you email template for attendees

Please let us know if you can accommodate these requests and what the timeline would be for each deliverable.

Best regards,
Event Planning Committee`,
  status: 'in_review',
  submittedBy: 'Event Planning Committee',
  submittedAt: new Date('2024-01-15'),
  formFields: [],
  comments: [],
  approvals: [],
  changes: [
    {
      id: 'change-1',
      field: 'content',
      oldValue: 'March 15th, 2024',
      newValue: 'March 22nd, 2024',
      changedBy: 'Sarah Johnson',
      timestamp: new Date('2024-01-16T10:30:00')
    },
    {
      id: 'change-2',
      field: 'content',
      oldValue: '200 attendees',
      newValue: '250-300 attendees',
      changedBy: 'Mike Chen',
      timestamp: new Date('2024-01-16T14:15:00')
    },
    {
      id: 'change-3',
      field: 'content',
      oldValue: 'Event poster design and printing (100 copies)',
      newValue: 'Event poster design and printing (150 copies)',
      changedBy: 'Lisa Wang',
      timestamp: new Date('2024-01-17T09:00:00')
    }
  ],
  assignedReviewers: ['reviewer-1', 'reviewer-2'],
  assignedCouncilManagers: ['council-1'],
  suggestedEdits: [],
  requiredApprovers: []
};

export const TrackedChangesDemo: React.FC = () => {
  const [submission, setSubmission] = useState<ContentSubmission>(initialSubmission);

  const handleSave = (updatedSubmission: ContentSubmission) => {
    setSubmission(updatedSubmission);
    console.log('Saved submission:', updatedSubmission);
  };

  const handleComment = (comment: Comment) => {
    setSubmission(prev => ({
      ...prev,
      comments: [...prev.comments, comment]
    }));
    console.log('Added comment:', comment);
  };

  const handleApprove = (changeId: string) => {
    const approval: Approval = {
      id: `approval-${Date.now()}`,
      approverId: demoUser.id,
      approverEmail: demoUser.email,
      status: 'APPROVED',
      comment: 'Looks good',
      timestamp: new Date()
    };

    setSubmission(prev => ({
      ...prev,
      approvals: [...prev.approvals, approval]
    }));
    console.log('Approved change:', changeId);
  };

  const handleReject = (changeId: string) => {
    const approval: Approval = {
      id: `approval-${Date.now()}`,
      approverId: demoUser.id,
      approverEmail: demoUser.email,
      status: 'REJECTED',
      comment: 'Needs revision',
      timestamp: new Date()
    };

    setSubmission(prev => ({
      ...prev,
      approvals: [...prev.approvals, approval]
    }));
    console.log('Rejected change:', changeId);
  };

  const handleSuggestion = (suggestion: Change) => {
    setSubmission(prev => ({
      ...prev,
      changes: [...prev.changes, suggestion]
    }));
    console.log('Added suggestion:', suggestion);
  };

  const handleUndo = (changeId: string) => {
    setSubmission(prev => ({
      ...prev,
      changes: prev.changes.map(change => 
        change.id === changeId 
          ? { ...change, status: 'pending', approvedBy: undefined, rejectedBy: undefined }
          : change
      )
    }));
    console.log('Undid change:', changeId);
  };

  const handleApproveProposedVersion = (approverId: string, comment?: string) => {
    const approval: Approval = {
      id: `approval-${Date.now()}`,
      approverId,
      approverEmail: demoUser.email,
      status: 'APPROVED',
      comment,
      timestamp: new Date()
    };

    setSubmission(prev => ({
      ...prev,
      approvals: [...prev.approvals, approval]
    }));
    console.log('Approved proposed version:', { approverId, comment });
  };

  const handleRejectProposedVersion = (rejecterId: string, comment?: string) => {
    const approval: Approval = {
      id: `approval-${Date.now()}`,
      approverId: rejecterId,
      approverEmail: demoUser.email,
      status: 'REJECTED',
      comment,
      timestamp: new Date()
    };

    setSubmission(prev => ({
      ...prev,
      approvals: [...prev.approvals, approval]
    }));
    console.log('Rejected proposed version:', { rejecterId, comment });
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TrackedChangesEditor
        submission={submission}
        currentUser={demoUser}
        onSave={handleSave}
        onComment={handleComment}
        onApprove={handleApprove}
        onReject={handleReject}
        onSuggestion={handleSuggestion}
        onUndo={handleUndo}
        onApproveProposedVersion={handleApproveProposedVersion}
        onRejectProposedVersion={handleRejectProposedVersion}
      />
    </div>
  );
};