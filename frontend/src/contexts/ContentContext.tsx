import React, { createContext, useContext, useState, useEffect } from 'react';
import { ContentSubmission, User, CouncilManager, SubmissionStatus, Approval } from '../types/content';
import { API_URL } from '../config';

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
  removeCouncilManager: (managerId: string) => Promise<void>;
  addCommsCadreMember: (email: string, name: string) => Promise<void>;
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

  useEffect(() => {
    const userJson = localStorage.getItem('user');
    if (userJson) {
      try {
        const user = JSON.parse(userJson);
        setCurrentUser(user);
      } catch (err) {
        console.error('Error parsing user data:', err);
      }
    }

    // Fetch initial data
    fetchSubmissions();
    fetchCouncilManagers();
    fetchCommsCadreMembers();
  }, []);

  const fetchSubmissions = async () => {
    try {
      const response = await fetch(`${API_URL}/content/submissions`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
      });
      if (response.ok) {
        const data = await response.json();
        // Convert date strings to Date objects
        const submissionsWithDates = data.map((submission: any) => ({
          ...submission,
          submittedAt: new Date(submission.submittedAt),
          comments: submission.comments.map((comment: any) => ({
            ...comment,
            createdAt: new Date(comment.createdAt),
            updatedAt: new Date(comment.updatedAt)
          })),
          approvals: submission.approvals.map((approval: any) => ({
            ...approval,
            createdAt: new Date(approval.createdAt),
            updatedAt: new Date(approval.updatedAt)
          })),
          changes: submission.changes.map((change: any) => ({
            ...change,
            changedAt: new Date(change.changedAt)
          }))
        }));
        setSubmissions(submissionsWithDates);
      }
    } catch (err) {
      console.error('Error fetching submissions:', err);
    }
  };

  const fetchCouncilManagers = async () => {
    try {
      const response = await fetch(`${API_URL}/council/members`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
      });
      if (response.ok) {
        const data = await response.json();
        setCouncilManagers(data);
      }
    } catch (err) {
      console.error('Error fetching council managers:', err);
    }
  };

  const fetchCommsCadreMembers = async () => {
    try {
      const response = await fetch(`${API_URL}/comms-cadre`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
      });
      if (response.ok) {
        const data = await response.json();
        setCommsCadreMembers(data);
      }
    } catch (err) {
      console.error('Error fetching comms cadre members:', err);
    }
  };

  const saveSubmission = async (submission: ContentSubmission) => {
    try {
      const isNewSubmission = !submissions.some(s => s.id === submission.id);
      const url = isNewSubmission 
        ? `${API_URL}/content/submissions`
        : `${API_URL}/content/submissions/${submission.id}`;
      
      const response = await fetch(url, {
        method: isNewSubmission ? 'POST' : 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
        body: JSON.stringify(submission),
      });
      
      if (response.ok) {
        const data = await response.json();
        // Convert date strings to Date objects
        const updatedSubmission = {
          ...data,
          submittedAt: new Date(data.submittedAt),
          comments: data.comments.map((comment: any) => ({
            ...comment,
            createdAt: new Date(comment.createdAt),
            updatedAt: new Date(comment.updatedAt)
          })),
          approvals: data.approvals.map((approval: any) => ({
            ...approval,
            createdAt: new Date(approval.createdAt),
            updatedAt: new Date(approval.updatedAt)
          })),
          changes: data.changes.map((change: any) => ({
            ...change,
            changedAt: new Date(change.changedAt)
          }))
        };

        if (isNewSubmission) {
          setSubmissions(prev => [...prev, updatedSubmission]);
        } else {
          setSubmissions(prev => 
            prev.map(s => s.id === submission.id ? updatedSubmission : s)
          );
        }
      }
    } catch (err) {
      console.error('Error saving submission:', err);
      throw err;
    }
  };

  const approveSubmission = async (submission: ContentSubmission) => {
    try {
      const response = await fetch(`${API_URL}/content/submissions/${submission.id}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
      });
      if (response.ok) {
        const updatedSubmission = await response.json();
        setSubmissions(prev => 
          prev.map(s => s.id === submission.id ? updatedSubmission : s)
        );
      }
    } catch (err) {
      console.error('Error approving submission:', err);
      throw err;
    }
  };

  const rejectSubmission = async (submission: ContentSubmission) => {
    try {
      const response = await fetch(`${API_URL}/content/submissions/${submission.id}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
      });
      if (response.ok) {
        const updatedSubmission = await response.json();
        setSubmissions(prev => 
          prev.map(s => s.id === submission.id ? updatedSubmission : s)
        );
      }
    } catch (err) {
      console.error('Error rejecting submission:', err);
      throw err;
    }
  };

  const addComment = async (submission: ContentSubmission, comment: any) => {
    try {
      const response = await fetch(`${API_URL}/content/submissions/${submission.id}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
        body: JSON.stringify(comment),
      });
      if (response.ok) {
        const updatedSubmission = await response.json();
        setSubmissions(prev => 
          prev.map(s => s.id === submission.id ? updatedSubmission : s)
        );
      }
    } catch (err) {
      console.error('Error adding comment:', err);
      throw err;
    }
  };

  const saveCouncilManagers = async (managers: CouncilManager[]) => {
    try {
      // Process each manager
      const results = await Promise.all(managers.map(async (manager) => {
        const isNew = !manager.id;
        const method = isNew ? 'POST' : 'PUT';
        const url = isNew ? `${API_URL}/council/members` : `${API_URL}/council/members/${manager.id}`;

        const response = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
          },
          body: JSON.stringify(manager),
        });

        if (!response.ok) {
          throw new Error(`Failed to ${isNew ? 'create' : 'update'} council manager`);
        }

        return response.json();
      }));

      setCouncilManagers(results);
    } catch (err) {
      console.error('Error saving council managers:', err);
      throw err;
    }
  };

  const removeCouncilManager = async (managerId: string) => {
    try {
      const response = await fetch(`${API_URL}/council/members/${managerId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
      });
      if (response.ok) {
        setCouncilManagers(prev => prev.filter(manager => manager.id !== managerId));
      } else {
        throw new Error('Failed to remove council manager');
      }
    } catch (err) {
      console.error('Error removing council manager:', err);
      throw err;
    }
  };

  const addCommsCadreMember = async (email: string, name: string) => {
    try {
      const response = await fetch(`${API_URL}/comms-cadre`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
        body: JSON.stringify({ email, name }),
      });
      if (response.ok) {
        const newMember = await response.json();
        setCommsCadreMembers(prev => [...prev, newMember]);
      }
    } catch (err) {
      console.error('Error adding comms cadre member:', err);
      throw err;
    }
  };

  const removeCommsCadreMember = async (userId: string) => {
    try {
      const response = await fetch(`${API_URL}/comms-cadre/${userId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
      });
      if (response.ok) {
        setCommsCadreMembers(prev => prev.filter(member => member.id !== userId));
      }
    } catch (err) {
      console.error('Error removing comms cadre member:', err);
      throw err;
    }
  };

  const sendReminder = async (submission: ContentSubmission, manager: CouncilManager) => {
    try {
      const response = await fetch(`${API_URL}/content/submissions/${submission.id}/remind`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
        body: JSON.stringify({ managerId: manager.id }),
      });
      if (!response.ok) {
        throw new Error('Failed to send reminder');
      }
    } catch (err) {
      console.error('Error sending reminder:', err);
      throw err;
    }
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
    removeCouncilManager,
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