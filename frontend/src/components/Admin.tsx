import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { API_URL } from '../config';
import './Admin.css';
import Navbar from './Navbar';

import { User, UserType, Group } from '../types';
import { LogoutUserReact } from '../utils/userActions';
import PageManagement from './PageManagement';

// Extended User interface with required fields for admin panel
interface AdminUser extends User {
  id: string;
  approved: boolean;
  isAdmin: boolean;
  userType: UserType;
  groups: string[];
}

// Interface for bulk user entry
interface BulkUserEntry {
  name: string;
  email: string;
  approved: boolean;
}

// Admin panel tabs
enum AdminTab {
  Users = 'users',
  Groups = 'groups',
  BulkAdd = 'bulkAdd',
  Pages = 'pages'
}

// Email dialog interface
interface EmailDialogProps {
  groupId: string;
  groupName: string;
  onClose: () => void;
  onSend: (subject: string, message: string) => void;
  status?: string | null;
}

// Email dialog component
const EmailDialog: React.FC<EmailDialogProps> = ({ groupId, groupName, onClose, onSend, status }) => {
  const [subject, setSubject] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const handleSend = () => {
    if (!subject.trim()) {
      setError('Subject is required');
      return;
    }
    if (!message.trim()) {
      setError('Message is required');
      return;
    }
    onSend(subject, message);
  };

  return (
    <div className="email-dialog-overlay">
      <div className="email-dialog">
        <div className="email-dialog-header">
          <h3>Send Email to {groupName}</h3>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        <div className="email-dialog-content">
          {error && <div className="error">{error}</div>}
          {status && <div className={status.startsWith('Error') ? 'error' : 'success-message'}>{status}</div>}
          <div className="form-group">
            <label htmlFor="emailSubject">Subject:</label>
            <input 
              type="text" 
              id="emailSubject" 
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Enter email subject"
            />
          </div>
          <div className="form-group">
            <label htmlFor="emailMessage">Message:</label>
            <textarea 
              id="emailMessage" 
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Enter email message"
              rows={6}
            />
          </div>
        </div>
        <div className="email-dialog-footer">
          <button className="cancel-button" onClick={onClose}>Cancel</button>
          <button className="send-button" onClick={handleSend}>Send Email</button>
        </div>
      </div>
    </div>
  );
};

const Admin: React.FC = () => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<AdminTab>(AdminTab.Users);
  const [newGroupName, setNewGroupName] = useState<string>('');
  const [newGroupDescription, setNewGroupDescription] = useState<string>('');
  const [showEmailDialog, setShowEmailDialog] = useState<boolean>(false);
  const [selectedGroup, setSelectedGroup] = useState<{id: string, name: string} | null>(null);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [bulkUsers, setBulkUsers] = useState<BulkUserEntry[]>(Array(5).fill(null).map(() => ({ 
    name: '', 
    email: '', 
    approved: false 
  })));
  const [bulkAddStatus, setBulkAddStatus] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    // Check if user is admin
    checkAdminStatus();
  }, []);

  // Fetch users and groups when admin status is confirmed
  useEffect(() => {
    if (isAdmin) {
      fetchUsers();
      fetchGroups();
    }
  }, [isAdmin]);

  const checkAdminStatus = async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/check`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        throw new Error('Not authorized');
      }

      const data = await response.json();
      setIsAdmin(data.isAdmin);

      if (!data.isAdmin) {
        setError('You do not have admin privileges');
        setTimeout(() => {
          navigate('/');
        }, 3000);
      }
    } catch (err) {
      setError('Error checking admin status');
      setTimeout(() => {
        navigate('/');
      }, 3000);
    }
  };

  const fetchUsers = async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/users`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch users');
      }

      const data = await response.json();
      setUsers(data.users);
      setLoading(false);
    } catch (err) {
      setError('Error fetching users');
      setLoading(false);
    }
  };

  const approveUser = async (userId: string) => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/approve-user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        throw new Error('Failed to approve user');
      }

      // Update the local state
      setUsers(users.map(user => 
        user.id === userId ? { ...user, approved: true } : user
      ));
    } catch (err) {
      setError('Error approving user');
    }
  };

  const fetchGroups = async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/groups`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch groups');
      }

      const data = await response.json();
      setGroups(data.groups);
    } catch (err) {
      setError('Error fetching groups');
    }
  };

  const createGroup = async () => {
    if (!newGroupName.trim()) {
      setError('Group name is required');
      return;
    }

    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/groups`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ 
          name: newGroupName,
          description: newGroupDescription 
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to create group');
      }

      const data = await response.json();
      
      // Add the new group to the list
      setGroups([...groups, data.group]);
      
      // Clear the form
      setNewGroupName('');
      setNewGroupDescription('');
    } catch (err) {
      setError('Error creating group');
    }
  };

  const deleteGroup = async (groupId: string) => {
    if (!window.confirm('Are you sure you want to delete this group? This action cannot be undone.')) {
      return;
    }

    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/groups/${groupId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to delete group');
      }

      // Remove the deleted group from the list
      setGroups(groups.filter(group => group.id !== groupId));
    } catch (err) {
      setError('Error deleting group');
    }
  };

  const addUserToGroup = async (userId: string, groupId: string) => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/groups/${groupId}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        throw new Error('Failed to add user to group');
      }

  // Update the local state
  setUsers(users.map(user => 
    user.id === userId 
      ? { ...user, groups: user.groups ? [...user.groups, groupId] : [groupId] } 
      : user
  ));
    } catch (err) {
      setError('Error adding user to group');
    }
  };

  const removeUserFromGroup = async (userId: string, groupId: string) => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/groups/${groupId}/members/${userId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to remove user from group');
      }

      // Update the local state
      setUsers(users.map(user => 
        user.id === userId 
          ? { ...user, groups: user.groups ? user.groups.filter(g => g !== groupId) : [] } 
          : user
      ));
    } catch (err) {
      setError('Error removing user from group');
    }
  };

  const changeUserType = async (userId: string, userType: UserType) => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/change-user-type`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ userId, userType }),
      });

      if (!response.ok) {
        throw new Error('Failed to change user type');
      }

      // Update the local state
      setUsers(users.map(user => 
        user.id === userId 
          ? { ...user, userType, isAdmin: userType === UserType.Admin } 
          : user
      ));
    } catch (err) {
      setError('Error changing user type');
    }
  };

  const makeAdmin = async (userId: string) => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/make-admin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        throw new Error('Failed to make user admin');
      }

      // Update the local state
      setUsers(users.map(user => 
        user.id === userId ? { ...user, isAdmin: true } : user
      ));
    } catch (err) {
      setError('Error making user admin');
    }
  };

  // Handle bulk user entry updates
  const updateBulkUserEntry = (index: number, field: keyof BulkUserEntry, value: string | boolean) => {
    const updatedEntries = [...bulkUsers];
    updatedEntries[index] = { 
      ...updatedEntries[index], 
      [field]: value 
    };
    setBulkUsers(updatedEntries);
  };

  // Add a new row to the bulk user entries
  const addBulkUserRow = () => {
    setBulkUsers([...bulkUsers, { name: '', email: '', approved: false }]);
  };

  // Remove a row from the bulk user entries
  const removeBulkUserRow = (index: number) => {
    const updatedEntries = [...bulkUsers];
    updatedEntries.splice(index, 1);
    setBulkUsers(updatedEntries);
  };

  // Submit bulk user creation
  const submitBulkUsers = async () => {
    // Validate entries
    const validEntries = bulkUsers.filter(entry => entry.name.trim() && entry.email.trim());
    
    if (validEntries.length === 0) {
      setBulkAddStatus('Error: No valid entries to submit');
      return;
    }

    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      setBulkAddStatus('Creating users...');
      const response = await fetch(`${API_URL}/admin/bulk-create-users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ users: validEntries }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create users');
      }

      const data = await response.json();
      
      // Update the users list with the newly created users
      setUsers([...users, ...data.users]);
      
      // Reset the form
      setBulkUsers(Array(5).fill(null).map(() => ({ 
        name: '', 
        email: '', 
        approved: false 
      })));
      
      setBulkAddStatus(`Success: Created ${data.users.length} users`);
      
      // Clear success message after a few seconds
      setTimeout(() => {
        setBulkAddStatus(null);
      }, 5000);
    } catch (err) {
      setBulkAddStatus(`Error: ${(err as Error).message}`);
    }
  };

  const handleLogout = () => {
    LogoutUserReact(navigate);
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div className="error">{error}</div>;
  }

  if (!isAdmin) {
    return <div>Redirecting to login...</div>;
  }

  return (
    <div className="admin-dashboard">
      <Navbar />
      <h1>Admin Dashboard</h1>
      <div className="admin-header">
        <div className="admin-tabs">
          <button 
            className={activeTab === AdminTab.Users ? 'active' : ''} 
            onClick={() => setActiveTab(AdminTab.Users)}
          >
            User Management
          </button>
          <button 
            className={activeTab === AdminTab.Groups ? 'active' : ''} 
            onClick={() => setActiveTab(AdminTab.Groups)}
          >
            Group Management
          </button>
          <button 
            className={activeTab === AdminTab.BulkAdd ? 'active' : ''} 
            onClick={() => setActiveTab(AdminTab.BulkAdd)}
          >
            Bulk Add Users
          </button>
          <button 
            className={activeTab === AdminTab.Pages ? 'active' : ''} 
            onClick={() => setActiveTab(AdminTab.Pages)}
          >
            Page Management
          </button>
        </div>
        <div className="admin-actions">
          <Link to="/" className="home-button">Home</Link>
          <button onClick={handleLogout} className="logout-button">Logout</button>
        </div>
      </div>
      
      {activeTab === AdminTab.Users && (
        <div className="admin-section">
          <h2>User Management</h2>
          {users.length === 0 ? (
            <p>No users found. New users will appear here when they sign up.</p>
          ) : (
            <table className="users-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Role</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(user => (
                  <tr key={user.id}>
                    <td>{user.name}</td>
                    <td>{user.email}</td>
                    <td>{user.approved ? 'Approved' : 'Pending'}</td>
                    <td>{user.userType}</td>
                    <td>
                      <div className="action-buttons">
                        {!user.approved && (
                          <button 
                            onClick={() => approveUser(user.id)}
                            className="approve-button"
                          >
                            Approve
                          </button>
                        )}
                        <select 
                          value={user.userType}
                          onChange={(e) => changeUserType(user.id, e.target.value as UserType)}
                          className="user-type-select"
                        >
                          <option value={UserType.Public}>Public</option>
                          <option value={UserType.Member}>Member</option>
                          <option value={UserType.Lead}>Lead</option>
                          <option value={UserType.Admin}>Admin</option>
                        </select>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      
      {activeTab === AdminTab.Groups && (
        <div className="admin-section">
          <h2>Group Management</h2>
          
          <div className="create-group-form">
            <h3>Create New Group</h3>
            <div className="form-group">
              <label htmlFor="groupName">Group Name:</label>
              <input 
                type="text" 
                id="groupName" 
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Enter group name"
              />
            </div>
            <div className="form-group">
              <label htmlFor="groupDescription">Description:</label>
              <textarea 
                id="groupDescription" 
                value={newGroupDescription}
                onChange={(e) => setNewGroupDescription(e.target.value)}
                placeholder="Enter group description"
              />
            </div>
            <button 
              onClick={createGroup}
              className="create-button"
            >
              Create Group
            </button>
          </div>
          
          <div className="groups-list">
            <h3>Existing Groups</h3>
            {groups.length === 0 ? (
              <p>No groups found. Create a new group to get started.</p>
            ) : (
              <div className="groups-container">
                {groups.map(group => (
                  <div key={group.id} className="group-card">
                    <div className="group-header">
                      <h4>{group.name}</h4>
                      <div className="group-actions">
                        <button 
                          onClick={() => {
                            setSelectedGroup({ id: group.id, name: group.name });
                            setShowEmailDialog(true);
                          }}
                          className="email-button"
                        >
                          Send Email
                        </button>
                        <button 
                          onClick={() => deleteGroup(group.id)}
                          className="delete-button"
                        >
                          Delete Group
                        </button>
                      </div>
                    </div>
                    <p>{group.description}</p>
                    <div className="group-details">
                      <p><strong>Created:</strong> {new Date(group.createdAt).toLocaleDateString()}</p>
                      <p><strong>Members:</strong> {group.members ? group.members.length : 0}</p>
                    </div>
                    <div className="group-members">
                      <h5>Members</h5>
                      <ul>
                        {group.members ? group.members.map(memberId => {
                          const member = users.find(u => u.id === memberId);
                          return member ? (
                            <li key={memberId}>
                              {member.name} ({member.email})
                              <button 
                                onClick={() => removeUserFromGroup(memberId, group.id)}
                                className="remove-button"
                              >
                                Remove
                              </button>
                            </li>
                          ) : null;
                        }) : <li>No members</li>}
                      </ul>
                    </div>
                    <div className="add-member-form">
                      <h5>Add Member</h5>
                      <select 
                        onChange={(e) => {
                          if (e.target.value) {
                            addUserToGroup(e.target.value, group.id);
                            e.target.value = ''; // Reset select after adding
                          }
                        }}
                        defaultValue=""
                      >
                        <option value="" disabled>Select a user</option>
                        {users
                          .filter(user => !group.members || !group.members.includes(user.id))
                          .map(user => (
                            <option key={user.id} value={user.id}>
                              {user.name} ({user.email})
                            </option>
                          ))
                        }
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === AdminTab.BulkAdd && (
        <div className="admin-section">
          <h2>Bulk Add Users</h2>
          
          {bulkAddStatus && (
            <div className={bulkAddStatus.startsWith('Error') ? 'error' : 'success-message'}>
              {bulkAddStatus}
            </div>
          )}
          
          <div className="bulk-add-form">
            <p>Add multiple users at once. Fill in the name and email for each user. Check the "Approve" box to automatically approve the user.</p>
            
            <div className="bulk-users-table">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Approve</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {bulkUsers.map((user, index) => (
                    <tr key={index}>
                      <td>
                        <input 
                          type="text" 
                          value={user.name}
                          onChange={(e) => updateBulkUserEntry(index, 'name', e.target.value)}
                          placeholder="Enter name"
                        />
                      </td>
                      <td>
                        <input 
                          type="email" 
                          value={user.email}
                          onChange={(e) => updateBulkUserEntry(index, 'email', e.target.value)}
                          placeholder="Enter email"
                        />
                      </td>
                      <td className="approve-checkbox">
                        <input 
                          type="checkbox" 
                          checked={user.approved}
                          onChange={(e) => updateBulkUserEntry(index, 'approved', e.target.checked)}
                        />
                      </td>
                      <td>
                        <button 
                          onClick={() => removeBulkUserRow(index)}
                          className="remove-button"
                          disabled={bulkUsers.length <= 1}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            <div className="bulk-add-actions">
              <button 
                onClick={addBulkUserRow}
                className="add-row-button"
              >
                + Add Row
              </button>
              
              <button 
                onClick={submitBulkUsers}
                className="submit-button"
                disabled={bulkUsers.every(user => !user.name.trim() || !user.email.trim())}
              >
                Submit
              </button>
            </div>
          </div>
        </div>
      )}
      
      {activeTab === AdminTab.Pages && (
        <PageManagement />
      )}
      {showEmailDialog && selectedGroup && (
        <EmailDialog 
          groupId={selectedGroup.id}
          groupName={selectedGroup.name}
          status={emailStatus}
          onClose={() => {
            setShowEmailDialog(false);
            setSelectedGroup(null);
            setEmailStatus(null);
          }}
          onSend={async (subject, message) => {
            const sessionId = localStorage.getItem('sessionId');
            if (!sessionId) {
              navigate('/');
              return;
            }

            try {
              setEmailStatus('Sending emails...');
              const response = await fetch(`${API_URL}/admin/groups/${selectedGroup.id}/send-email`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${sessionId}`,
                },
                body: JSON.stringify({ subject, message }),
              });

              const data = await response.json();
              
              if (!response.ok) {
                throw new Error(data.error || 'Failed to send emails');
              }

              setEmailStatus(`Success: ${data.message}`);
              setTimeout(() => {
                setShowEmailDialog(false);
                setSelectedGroup(null);
                setEmailStatus(null);
              }, 3000);
            } catch (err) {
              setEmailStatus(`Error: ${(err as Error).message}`);
            }
          }}
        />
      )}
    </div>
  );
};

export default Admin;
