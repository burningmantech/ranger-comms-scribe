import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { ContentSubmission, User, CouncilManager, SubmissionStatus, Approval, Comment, SuggestedEdit } from '../types/content';
import { API_URL } from '../config';
import { USER_LOGIN_EVENT } from '../utils/userActions';

function getAuthHeaders(includeContentType = false): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
  };
  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function normalizeSubmission(data: any): ContentSubmission {
  return {
    ...data,
    submittedAt: new Date(data.submittedAt),
    comments: (data.comments || []).map((c: any) => ({
      ...c,
      createdAt: new Date(c.createdAt),
      updatedAt: new Date(c.updatedAt),
    })),
    approvals: (data.approvals || []).map((a: any) => ({
      ...a,
      approverEmail: a.approverEmail || a.approverId,
      status: typeof a.status === 'string' ? a.status.toUpperCase() : a.status,
      createdAt: new Date(a.createdAt),
      updatedAt: new Date(a.updatedAt),
    })),
    changes: (data.changes || []).map((ch: any) => ({
      ...ch,
      timestamp: new Date(ch.changedAt || ch.timestamp),
    })),
    approvalOverrideAt: data.approvalOverrideAt ? new Date(data.approvalOverrideAt) : undefined,
    sentAt: data.sentAt ? new Date(data.sentAt) : undefined,
  } as ContentSubmission;
}

interface ContentContextType {
  submissions: ContentSubmission[];
  councilManagers: CouncilManager[];
  commsCadreMembers: User[];
  currentUser: User | null;
  userPermissions: any;
  saveSubmission: (submission: ContentSubmission) => Promise<void>;
  refreshSubmissions: () => Promise<void>;
  approveSubmission: (submission: ContentSubmission) => Promise<void>;
  rejectSubmission: (submission: ContentSubmission) => Promise<void>;
  addComment: (submission: ContentSubmission, comment: Comment) => Promise<void>;
  deleteSubmission: (submissionId: string) => Promise<void>;
  createSuggestion: (submission: ContentSubmission, suggestion: SuggestedEdit) => Promise<void>;
  approveSuggestion: (submission: ContentSubmission, suggestionId: string, reason?: string) => Promise<void>;
  rejectSuggestion: (submission: ContentSubmission, suggestionId: string, reason?: string) => Promise<void>;
  overrideApprove: (submission: ContentSubmission, reason?: string) => Promise<void>;
  sendAnnouncementEmail: (submission: ContentSubmission, listIds?: string[]) => Promise<void>;
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
  const [userPermissions, setUserPermissions] = useState<any>(null);

  // Refresh user data and permissions from the backend
  const refreshCurrentUser = async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) return;

    try {
      const response = await fetch(`${API_URL}/auth/me`, {
        headers: { 'Authorization': `Bearer ${sessionId}` }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.user) {
          setCurrentUser(data.user);
          localStorage.setItem('user', JSON.stringify(data.user));
        }
      } else if (response.status === 401) {
        // Session expired
        localStorage.removeItem('sessionId');
        localStorage.removeItem('user');
        localStorage.removeItem('userPermissions');
        setCurrentUser(null);
        setUserPermissions(null);
        // Notify Navbar and other listeners that user is logged out
        window.dispatchEvent(new CustomEvent(USER_LOGIN_EVENT, { detail: null }));
      }
    } catch (err) {
      console.error('Error refreshing user:', err);
    }
  };

  useEffect(() => {
    const fetchCurrentUser = async () => {
      const userJson = localStorage.getItem('user');
      const sessionId = localStorage.getItem('sessionId');

      // If we have user data in localStorage, use it temporarily
      if (userJson) {
        try {
          const user = JSON.parse(userJson);
          setCurrentUser(user);
        } catch (err) {
          console.error('Error parsing user from localStorage:', err);
          localStorage.removeItem('user');
        }
      }

      // Always fetch fresh user data from backend if we have a session
      if (sessionId) {
        try {
          const response = await fetch(`${API_URL}/auth/me`, {
            headers: {
              'Authorization': `Bearer ${sessionId}`
            }
          });

          if (response.ok) {
            const data = await response.json();
            if (data.user) {
              // The person's record as the server has it, with their access (utils/access.ts)
              setCurrentUser(data.user);
              localStorage.setItem('user', JSON.stringify(data.user));
            }
          } else {
            // Session is invalid, clear it
            localStorage.removeItem('sessionId');
            localStorage.removeItem('user');
            localStorage.removeItem('userPermissions');
            setCurrentUser(null);
            // Notify Navbar and other listeners that user is logged out
            window.dispatchEvent(new CustomEvent(USER_LOGIN_EVENT, { detail: null }));
          }
        } catch (err) {
          console.error('Error fetching current user:', err);
        }
      }
    };

    fetchCurrentUser();

    // Fetch initial data
    fetchSubmissions();
    fetchCouncilManagers();
    fetchCommsCadreMembers();
    fetchUserPermissions();

    // Refresh user data and permissions when tab becomes visible again
    // This handles the case where a user's role was changed while they were away
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshCurrentUser();
        fetchUserPermissions();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // The provider mounts once for the whole app, often on the login page with no session.
    // Reload the user and their data when they log in (and clear it when they log out);
    // otherwise pages like Requests show "Please log in" until a full page reload.
    const handleLoginStateChange = (event: Event) => {
      const user = (event as CustomEvent).detail;
      if (user) {
        fetchCurrentUser();
        fetchSubmissions();
        fetchCouncilManagers();
        fetchCommsCadreMembers();
        fetchUserPermissions();
      } else {
        setCurrentUser(null);
        setUserPermissions(null);
        setSubmissions([]);
      }
    };

    window.addEventListener(USER_LOGIN_EVENT, handleLoginStateChange as EventListener);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener(USER_LOGIN_EVENT, handleLoginStateChange as EventListener);
    };
  }, []);

  const fetchUserPermissions = async () => {
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) return;

      const response = await fetch(`${API_URL}/admin/user-roles`, {
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        console.log('🔑 User permissions:', data.permissions);
        setUserPermissions(data.permissions);
        localStorage.setItem('userPermissions', JSON.stringify(data.permissions));
      }
    } catch (err) {
      console.error('Error fetching user permissions:', err);
    }
  };

  const fetchSubmissions = async () => {
    try {
      const response = await fetch(`${API_URL}/content/submissions`, {
        headers: getAuthHeaders(),
      });
      if (response.ok) {
        const data = await response.json();
        setSubmissions(data.map(normalizeSubmission));
      }
    } catch (err) {
      console.error('Error fetching submissions:', err);
    }
  };

  const refreshSubmissions = async () => {
    await fetchSubmissions();
  };

  const fetchCouncilManagers = async () => {
    try {
      const response = await fetch(`${API_URL}/council/members`, {
        headers: getAuthHeaders(),
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
        headers: getAuthHeaders(),
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
      console.log('💾 saveSubmission called with:', submission);
      const isNewSubmission = !submissions.some(s => s.id === submission.id);
      const url = isNewSubmission 
        ? `${API_URL}/content/submissions`
        : `${API_URL}/content/submissions/${submission.id}`;
      
      console.log('🌐 Making request to:', url);
      console.log('📤 Request body:', JSON.stringify(submission, null, 2));
      
      const response = await fetch(url, {
        method: isNewSubmission ? 'POST' : 'PUT',
        headers: getAuthHeaders(true),
        body: JSON.stringify(submission),
      });
      
      console.log('📥 Response status:', response.status);
      console.log('📥 Response headers:', Object.fromEntries(response.headers.entries()));
      
      if (response.ok) {
        const data = await response.json();
        console.log('📥 Response data:', data);
        const updatedSubmission = normalizeSubmission(data);

        if (isNewSubmission) {
          setSubmissions(prev => [...prev, updatedSubmission]);
        } else {
          setSubmissions(prev =>
            prev.map(s => s.id === submission.id ? updatedSubmission : s)
          );
        }
      } else {
        console.error('❌ Response not ok:', response.status, response.statusText);
        const errorText = await response.text();
        console.error('❌ Error response body:', errorText);
        throw new Error(`Failed to save submission: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      console.error('❌ Error saving submission:', err);
      throw err;
    }
  };

  const approveSubmission = async (submission: ContentSubmission) => {
    try {
      // Optimistic update: add/update current user's approval as APPROVED
      if (currentUser) {
        setSubmissions(prev => prev.map(s => {
          if (s.id !== submission.id) return s;
          const existingIdx = (s.approvals || []).findIndex(a => a.approverEmail === currentUser.email || a.approverId === currentUser.id);
          const now = new Date();
          const approval = {
            id: (existingIdx !== -1 ? s.approvals[existingIdx].id : crypto.randomUUID()),
            approverId: currentUser.id || currentUser.email,
            approverEmail: currentUser.email,
            status: 'APPROVED' as const,
            comment: undefined,
            timestamp: now
          };
          const updatedApprovals = [...(s.approvals || [])];
          if (existingIdx !== -1) {
            updatedApprovals[existingIdx] = approval;
          } else {
            updatedApprovals.push(approval as any);
          }
          return { ...s, approvals: updatedApprovals };
        }));
      }

      const response = await fetch(`${API_URL}/content/submissions/${submission.id}/approve`, {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify({
          status: 'approved'
        })
      });
      if (response.ok) {
        // Refetch the submission to get latest state
        const refreshed = await fetch(`${API_URL}/content/submissions/${submission.id}`, {
          headers: getAuthHeaders()
        });
        if (refreshed.ok) {
          const data = await refreshed.json();
          const normalized = normalizeSubmission(data);
          setSubmissions(prev => prev.map(s => s.id === submission.id ? normalized : s));
        } else {
          await fetchSubmissions();
        }
      }
    } catch (err) {
      console.error('Error approving submission:', err);
      throw err;
    }
  };

  const rejectSubmission = async (submission: ContentSubmission) => {
    try {
      // Optimistic update: add/update current user's approval as REJECTED
      if (currentUser) {
        setSubmissions(prev => prev.map(s => {
          if (s.id !== submission.id) return s;
          const existingIdx = (s.approvals || []).findIndex(a => a.approverEmail === currentUser.email || a.approverId === currentUser.id);
          const now = new Date();
          const approval = {
            id: (existingIdx !== -1 ? s.approvals[existingIdx].id : crypto.randomUUID()),
            approverId: currentUser.id || currentUser.email,
            approverEmail: currentUser.email,
            status: 'REJECTED' as const,
            comment: undefined,
            timestamp: now
          };
          const updatedApprovals = [...(s.approvals || [])];
          if (existingIdx !== -1) {
            updatedApprovals[existingIdx] = approval;
          } else {
            updatedApprovals.push(approval as any);
          }
          return { ...s, approvals: updatedApprovals };
        }));
      }

      const response = await fetch(`${API_URL}/content/submissions/${submission.id}/approve`, {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify({
          status: 'rejected'
        })
      });
      if (response.ok) {
        // Refetch single submission to sync
        const refreshed = await fetch(`${API_URL}/content/submissions/${submission.id}`, {
          headers: getAuthHeaders()
        });
        if (refreshed.ok) {
          const data = await refreshed.json();
          const normalized = normalizeSubmission(data);
          setSubmissions(prev => prev.map(s => s.id === submission.id ? normalized : s));
        } else {
          await fetchSubmissions();
        }
      }
    } catch (err) {
      console.error('Error rejecting submission:', err);
      throw err;
    }
  };

  const overrideApprove = async (submission: ContentSubmission, reason?: string) => {
    try {
      const response = await fetch(`${API_URL}/content/submissions/${submission.id}/override-approve`, {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify({ confirm: true, reason })
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Failed to override approve');
      }
      const updated = await response.json();
      const normalized = normalizeSubmission(updated);
      setSubmissions(prev => prev.map(s => s.id === submission.id ? normalized : s));
    } catch (err) {
      console.error('Error overriding approval:', err);
      throw err;
    }
  };

  const sendAnnouncementEmail = async (submission: ContentSubmission, listIds?: string[]) => {
    try {
      const response = await fetch(`${API_URL}/content/submissions/${submission.id}/send-email`, {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify(listIds ? { listIds } : {}),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || 'Failed to send email');
      }
      // Refresh submissions list
      await fetchSubmissions();
    } catch (err) {
      console.error('Error sending announcement email:', err);
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

  const deleteSubmission = async (submissionId: string) => {
    try {
      const response = await fetch(`${API_URL}/content/submissions/${submissionId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      
      if (response.ok) {
        // Remove the submission from local state
        setSubmissions(prev => prev.filter(s => s.id !== submissionId));
      } else {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to delete submission');
      }
    } catch (err) {
      console.error('Error deleting submission:', err);
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
        headers: getAuthHeaders(true),
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
        headers: getAuthHeaders(true),
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
        headers: getAuthHeaders(true),
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
    userPermissions,
    saveSubmission,
    refreshSubmissions,
    approveSubmission,
    rejectSubmission,
    addComment,
    deleteSubmission,
    createSuggestion,
    approveSuggestion,
    rejectSuggestion,
    overrideApprove,
    sendAnnouncementEmail
  };

  return (
    <ContentContext.Provider value={value}>
      {children}
    </ContentContext.Provider>
  );
}; 