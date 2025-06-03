import React, { createContext, useContext, useState, useEffect } from 'react';
import { ContentSubmission, User, CouncilManager, SubmissionStatus, Approval } from '../types/content';

interface ContentContextType {
  submissions: ContentSubmission[];
  councilManagers: CouncilManager[];
  commsCadreMembers: User[];
  currentUser: User | null;
  saveSubmission: (submission: ContentSubmission) => Promise<void>;
  approveSubmission: (submission: ContentSubmission) => Promise<void>;
  rejectSubmission: (submission: ContentSubmission) => Promise<void>;
  addComment: (submission: ContentSubmission, comment: any) => Promise<void>;
  saveCouncilManagers: (managers: CouncilManager[]) => Promise<void>;
  addCommsCadreMember: (email: string) => Promise<void>;
  removeCommsCadreMember: (userId: string) => Promise<void>;
  sendReminder: (submission: ContentSubmission, manager: CouncilManager) => Promise<void>;
}

const ContentContext = createContext<ContentContextType | null>(null);

export const useContent = () => {
  const context = useContext(ContentContext);
  if (!context) {
    throw new Error('useContent must be used within a ContentProvider');
  }
  return context;
};

interface ContentProviderProps {
  children: React.ReactNode;
}

export const ContentProvider: React.FC<ContentProviderProps> = ({ children }) => {
  const [submissions, setSubmissions] = useState<ContentSubmission[]>([]);
  const [councilManagers, setCouncilManagers] = useState<CouncilManager[]>([]);
  const [commsCadreMembers, setCommsCadreMembers] = useState<User[]>([]);
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  // Mock data for development
  useEffect(() => {
    // Mock current user
    setCurrentUser({
      id: '1',
      email: 'test@example.com',
      name: 'Test User',
      roles: ['COMMS_CADRE']
    });

    // Mock submissions
    setSubmissions([
      {
        id: '1',
        title: 'Test Submission',
        content: 'This is a test submission',
        status: 'UNDER_REVIEW',
        submittedBy: '1',
        submittedAt: new Date(),
        formFields: [],
        comments: [],
        approvals: [],
        changes: [],
        assignedReviewers: [],
        assignedCouncilManagers: []
      }
    ]);

    // Mock council managers
    setCouncilManagers([
      {
        id: '1',
        email: 'manager@example.com',
        name: 'Test Manager',
        role: 'COMMUNICATIONS_MANAGER'
      }
    ]);

    // Mock comms cadre members
    setCommsCadreMembers([
      {
        id: '1',
        email: 'cadre@example.com',
        name: 'Test Cadre Member',
        roles: ['COMMS_CADRE']
      }
    ]);
  }, []);

  const saveSubmission = async (submission: ContentSubmission) => {
    // TODO: Implement API call
    setSubmissions(prev => 
      prev.map(s => s.id === submission.id ? submission : s)
    );
  };

  const approveSubmission = async (submission: ContentSubmission) => {
    // TODO: Implement API call
    const updatedSubmission: ContentSubmission = {
      ...submission,
      status: 'APPROVED' as SubmissionStatus,
      approvals: [
        ...submission.approvals,
        {
          id: crypto.randomUUID(),
          approverId: currentUser?.id || '',
          status: 'APPROVED',
          timestamp: new Date()
        }
      ]
    };
    setSubmissions(prev => 
      prev.map(s => s.id === submission.id ? updatedSubmission : s)
    );
  };

  const rejectSubmission = async (submission: ContentSubmission) => {
    // TODO: Implement API call
    const updatedSubmission: ContentSubmission = {
      ...submission,
      status: 'REJECTED' as SubmissionStatus,
      approvals: [
        ...submission.approvals,
        {
          id: crypto.randomUUID(),
          approverId: currentUser?.id || '',
          status: 'REJECTED',
          timestamp: new Date()
        }
      ]
    };
    setSubmissions(prev => 
      prev.map(s => s.id === submission.id ? updatedSubmission : s)
    );
  };

  const addComment = async (submission: ContentSubmission, comment: any) => {
    // TODO: Implement API call
    const updatedSubmission = {
      ...submission,
      comments: [...submission.comments, comment]
    };
    setSubmissions(prev => 
      prev.map(s => s.id === submission.id ? updatedSubmission : s)
    );
  };

  const saveCouncilManagers = async (managers: CouncilManager[]) => {
    // TODO: Implement API call
    setCouncilManagers(managers);
  };

  const addCommsCadreMember = async (email: string) => {
    // TODO: Implement API call
    const newMember: User = {
      id: crypto.randomUUID(),
      email,
      name: email.split('@')[0], // Mock name from email
      roles: ['COMMS_CADRE']
    };
    setCommsCadreMembers(prev => [...prev, newMember]);
  };

  const removeCommsCadreMember = async (userId: string) => {
    // TODO: Implement API call
    setCommsCadreMembers(prev => prev.filter(m => m.id !== userId));
  };

  const sendReminder = async (submission: ContentSubmission, manager: CouncilManager) => {
    // TODO: Implement API call
    console.log('Sending reminder to', manager.email, 'for submission', submission.id);
  };

  const value = {
    submissions,
    councilManagers,
    commsCadreMembers,
    currentUser,
    saveSubmission,
    approveSubmission,
    rejectSubmission,
    addComment,
    saveCouncilManagers,
    addCommsCadreMember,
    removeCommsCadreMember,
    sendReminder
  };

  return (
    <ContentContext.Provider value={value}>
      {children}
    </ContentContext.Provider>
  );
}; 