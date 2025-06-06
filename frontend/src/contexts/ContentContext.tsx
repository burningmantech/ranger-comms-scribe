import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { ContentSubmission, User, CouncilManager, SubmissionStatus, Approval, Comment, SuggestedEdit } from '../types/content';
import { API_URL } from '../config';

interface ContentContextType {
  submissions: ContentSubmission[];
  councilManagers: CouncilManager[];
  commsCadreMembers: User[];
  currentUser: User | null;
  saveSubmission: (submission: ContentSubmission) => Promise<void>;
  approveSubmission: (submission: ContentSubmission) => Promise<void>;
  rejectSubmission: (submission: ContentSubmission) => Promise<void>;
  addComment: (submission: ContentSubmission, comment: Comment) => Promise<void>;
  saveCouncilManagers: (managers: CouncilManager[]) => Promise<void>;
  removeCouncilManager: (managerId: string) => Promise<void>;
  addCommsCadreMember: (email: string, name: string) => Promise<void>;
  removeCommsCadreMember: (userId: string) => Promise<void>;
  sendReminder: (submission: ContentSubmission, manager: CouncilManager) => Promise<void>;
  createSuggestion: (submission: ContentSubmission, suggestion: SuggestedEdit) => Promise<void>;
  approveSuggestion: (submission: ContentSubmission, suggestionId: string, reason?: string) => Promise<void>;
  rejectSuggestion: (submission: ContentSubmission, suggestionId: string, reason?: string) => Promise<void>;
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

  const addComment = async (submission: ContentSubmission, comment: Comment) => {
    try {
      console.log('Adding comment to submission in memory:', submission.id, comment);
      
      // Update the submission in memory
      setSubmissions(prev => {
        const updatedSubmissions = prev.map(s => {
          if (s.id === submission.id) {
            const updatedSubmission = {
              ...s,
              comments: [...(s.comments || []), comment]
            };
            console.log('Updated submission with new comment:', updatedSubmission);
            return updatedSubmission;
          }
          return s;
        });
        console.log('Updated submissions array:', updatedSubmissions);
        return updatedSubmissions;
      });
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

        // For new managers, we need to create the user first
        if (isNew) {
          // Create the user
          const createUserResponse = await fetch(`${API_URL}/admin/bulk-create-users`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
            },
            body: JSON.stringify({
              users: [{
                name: manager.name,
                email: manager.email,
                approved: true
              }]
            }),
          });

          if (!createUserResponse.ok) {
            throw new Error('Failed to create user');
          }

          // Change user type to CouncilManager which will add them to the group
          const changeTypeResponse = await fetch(`${API_URL}/admin/change-user-type`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
            },
            body: JSON.stringify({
              userId: manager.email,
              userType: 'CouncilManager'
            }),
          });

          if (!changeTypeResponse.ok) {
            throw new Error('Failed to set user type to CouncilManager');
          }
        }

        // Add/update the council member
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
      // Get the manager's email before removing them
      const manager = councilManagers.find(m => m.id === managerId);
      if (!manager) {
        throw new Error('Council manager not found');
      }

      // First remove from the CouncilManager group
      const groupsResponse = await fetch(`${API_URL}/admin/groups`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
      });

      if (!groupsResponse.ok) {
        throw new Error('Failed to fetch groups');
      }

      const groups = await groupsResponse.json();
      const councilManagerGroup = groups.find((g: any) => g.name === 'CouncilManager');
      
      if (councilManagerGroup) {
        const removeFromGroupResponse = await fetch(`${API_URL}/admin/groups/${councilManagerGroup.id}/members/${manager.email}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
          },
        });

        if (!removeFromGroupResponse.ok) {
          throw new Error('Failed to remove from CouncilManager group');
        }
      }

      // Then remove from council members
      const response = await fetch(`${API_URL}/council/members/${managerId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
      });

      if (response.ok) {
        // Finally change user type to Public
        const changeTypeResponse = await fetch(`${API_URL}/admin/change-user-type`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
          },
          body: JSON.stringify({
            userId: manager.email,
            userType: 'Public'
          }),
        });

        if (!changeTypeResponse.ok) {
          throw new Error('Failed to update user type');
        }

        setCouncilManagers(prev => prev.filter(m => m.id !== managerId));
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
      // First create the user
      const createUserResponse = await fetch(`${API_URL}/admin/bulk-create-users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
        body: JSON.stringify({
          users: [{
            name,
            email,
            approved: true
          }]
        }),
      });

      if (!createUserResponse.ok) {
        throw new Error('Failed to create user');
      }

      // Change user type to CommsCadre which will add them to the group
      const changeTypeResponse = await fetch(`${API_URL}/admin/change-user-type`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
        body: JSON.stringify({
          userId: email,
          userType: 'CommsCadre'
        }),
      });

      if (!changeTypeResponse.ok) {
        throw new Error('Failed to set user type to CommsCadre');
      }

      // Then add them to the comms cadre
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
      } else {
        throw new Error('Failed to add comms cadre member');
      }
    } catch (err) {
      console.error('Error adding comms cadre member:', err);
      throw err;
    }
  };

  const removeCommsCadreMember = async (userId: string) => {
    try {
      // Get the member's email before removing them
      const member = commsCadreMembers.find(m => m.id === userId);
      if (!member) {
        throw new Error('Comms cadre member not found');
      }

      // First remove from the CommsCadre group
      const groupsResponse = await fetch(`${API_URL}/admin/groups`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
      });

      if (!groupsResponse.ok) {
        throw new Error('Failed to fetch groups');
      }

      const groups = await groupsResponse.json();
      const commsCadreGroup = groups.find((g: any) => g.name === 'CommsCadre');
      
      if (commsCadreGroup) {
        const removeFromGroupResponse = await fetch(`${API_URL}/admin/groups/${commsCadreGroup.id}/members/${member.email}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
          },
        });

        if (!removeFromGroupResponse.ok) {
          throw new Error('Failed to remove from CommsCadre group');
        }
      }

      // Then remove from comms cadre
      const response = await fetch(`${API_URL}/comms-cadre/${userId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
      });

      if (response.ok) {
        // Finally change user type to Public
        const changeTypeResponse = await fetch(`${API_URL}/admin/change-user-type`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
          },
          body: JSON.stringify({
            userId: member.email,
            userType: 'Public'
          }),
        });

        if (!changeTypeResponse.ok) {
          throw new Error('Failed to update user type');
        }

        setCommsCadreMembers(prev => prev.filter(m => m.id !== userId));
      } else {
        throw new Error('Failed to remove comms cadre member');
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

  const createSuggestion = async (submission: ContentSubmission, suggestion: SuggestedEdit) => {
    try {
      console.log('Creating suggestion:', suggestion);
      
      // For now, update local state since backend might not have suggestion endpoints yet
      // TODO: Add backend API call when endpoints are available
      /*
      const response = await fetch(`${API_URL}/content/submissions/${submission.id}/suggestions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
        body: JSON.stringify(suggestion),
      });
      
      if (!response.ok) {
        throw new Error('Failed to create suggestion');
      }
      */
      
      // Update local state
      setSubmissions(prev => 
        prev.map(s => 
          s.id === submission.id 
            ? { ...s, suggestedEdits: [...(s.suggestedEdits || []), suggestion] }
            : s
        )
      );
    } catch (err) {
      console.error('Error creating suggestion:', err);
      throw err;
    }
  };

  const approveSuggestion = async (submission: ContentSubmission, suggestionId: string, reason?: string) => {
    try {
      console.log('Approving suggestion:', suggestionId, reason);
      
      // For now, update local state since backend might not have suggestion endpoints yet
      // TODO: Add backend API call when endpoints are available
      /*
      const response = await fetch(`${API_URL}/content/submissions/${submission.id}/suggestions/${suggestionId}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
        body: JSON.stringify({ reason }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to approve suggestion');
      }
      */
      
      // Update local state
      setSubmissions(prev => 
        prev.map(s => 
          s.id === submission.id 
            ? {
                ...s, 
                suggestedEdits: (s.suggestedEdits || []).map(suggestion =>
                  suggestion.id === suggestionId
                    ? { 
                        ...suggestion, 
                        status: 'APPROVED' as const,
                        reviewerId: currentUser?.id || currentUser?.email,
                        reviewedAt: new Date(),
                        reason 
                      }
                    : suggestion
                )
              }
            : s
        )
      );
    } catch (err) {
      console.error('Error approving suggestion:', err);
      throw err;
    }
  };

  const rejectSuggestion = async (submission: ContentSubmission, suggestionId: string, reason?: string) => {
    try {
      console.log('Rejecting suggestion:', suggestionId, reason);
      
      // For now, update local state since backend might not have suggestion endpoints yet
      // TODO: Add backend API call when endpoints are available
      /*
      const response = await fetch(`${API_URL}/content/submissions/${submission.id}/suggestions/${suggestionId}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
        body: JSON.stringify({ reason }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to reject suggestion');
      }
      */
      
      // Update local state
      setSubmissions(prev => 
        prev.map(s => 
          s.id === submission.id 
            ? {
                ...s, 
                suggestedEdits: (s.suggestedEdits || []).map(suggestion =>
                  suggestion.id === suggestionId
                    ? { 
                        ...suggestion, 
                        status: 'REJECTED' as const,
                        reviewerId: currentUser?.id || currentUser?.email,
                        reviewedAt: new Date(),
                        reason 
                      }
                    : suggestion
                )
              }
            : s
        )
      );
    } catch (err) {
      console.error('Error rejecting suggestion:', err);
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
    sendReminder,
    createSuggestion,
    approveSuggestion,
    rejectSuggestion
  };

  return (
    <ContentContext.Provider value={value}>
      {children}
    </ContentContext.Provider>
  );
}; 