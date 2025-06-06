import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { API_URL } from '../config';
import './Admin.css';
import Navbar from './Navbar';
import { RoleManagement } from './RoleManagement';
import './RoleManagement.css';

import { User, UserType, Group } from '../types';
import { LogoutUserReact } from '../utils/userActions';

// Extended User interface with required fields for admin panel
interface AdminUser extends User {
  id: string;
  approved: boolean;
  isAdmin: boolean;
  userType: UserType;
  groups: string[];
  isEditingName?: boolean;
  tempName?: string;
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
  Roles = 'roles'
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
          <button className="btn btn-secondary btn-with-icon" onClick={onClose}>
            <i className="fas fa-times"></i>
            <span className="btn-text">Cancel</span>
          </button>
          <button className="btn btn-primary btn-with-icon" onClick={handleSend}>
            <i className="fas fa-paper-plane"></i>
            <span className="btn-text">Send Email</span>
          </button>
        </div>
      </div>
    </div>
  );
};

interface AdminProps {
  skipNavbar?: boolean;
}

const Admin: React.FC<AdminProps> = ({ skipNavbar }) => {
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
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [bulkUsers, setBulkUsers] = useState<BulkUserEntry[]>(Array(5).fill(null).map(() => ({ 
    name: '', 
    email: '', 
    approved: false 
  })));
  const [bulkAddStatus, setBulkAddStatus] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
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

      // Update the local state for users
      setUsers(users.map(user => 
        user.id === userId 
          ? { ...user, groups: user.groups ? [...user.groups, groupId] : [groupId] } 
          : user
      ));
      
      // Update the local state for groups to show the new member immediately
      setGroups(groups.map(group => 
        group.id === groupId
          ? { ...group, members: [...(group.members || []), userId] }
          : group
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

      // Update the users state
      setUsers(users.map(user => 
        user.id === userId 
          ? { ...user, groups: user.groups ? user.groups.filter(g => g !== groupId) : [] } 
          : user
      ));
      
      // Update the groups state to remove the user from the group's members array
      setGroups(groups.map(group => 
        group.id === groupId
          ? { ...group, members: group.members ? group.members.filter(memberId => memberId !== userId) : [] }
          : group
      ));
      
      // If we're editing a group, update the editingGroup state as well
      if (editingGroup && editingGroup.id === groupId) {
        setEditingGroup({
          ...editingGroup,
          members: editingGroup.members ? editingGroup.members.filter(memberId => memberId !== userId) : []
        });
      }
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

  const deleteUser = async (userId: string) => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to delete user');
      }

      // Remove the deleted user from the list
      setUsers(users.filter(user => user.id !== userId));
    } catch (err) {
      setError('Error deleting user');
    }
  };

  const updateUserName = async (userId: string, newName: string) => {
    if (!newName.trim()) {
      setError('User name cannot be empty');
      return;
    }

    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      setError(null);
      const response = await fetch(`${API_URL}/admin/update-user-name`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ userId, name: newName }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update user name');
      }

      // Update the local state
      setUsers(users.map(user =>
        user.id === userId
          ? { ...user, name: newName, isEditingName: false, tempName: undefined }
          : user
      ));
      
      setSuccessMessage('User name updated successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(`Error updating user name: ${(err as Error).message}`);
    }
  };

  const startEditingUserName = (user: AdminUser) => {
    // Cancel any other editing first
    setUsers(users.map(u => ({ ...u, isEditingName: false, tempName: undefined })));
    
    // Then enable editing for this user
    setUsers(users.map(u =>
      u.id === user.id
        ? { ...u, isEditingName: true, tempName: user.name }
        : u
    ));
  };

  const cancelEditingUserName = (userId: string) => {
    setUsers(users.map(u =>
      u.id === userId
        ? { ...u, isEditingName: false, tempName: undefined }
        : u
    ));
  };

  const handleUserNameKeyDown = (e: React.KeyboardEvent, user: AdminUser) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (user.tempName && user.tempName.trim() !== user.name) {
        updateUserName(user.id, user.tempName.trim());
      } else {
        cancelEditingUserName(user.id);
      }
    } else if (e.key === 'Escape') {
      cancelEditingUserName(user.id);
    }
  };

  const updateBulkUserEntry = (index: number, field: keyof BulkUserEntry, value: string | boolean) => {
    const updatedBulkUsers = [...bulkUsers];
    updatedBulkUsers[index] = {
      ...updatedBulkUsers[index],
      [field]: value
    };
    setBulkUsers(updatedBulkUsers);
  };

  const removeBulkUserRow = (index: number) => {
    if (bulkUsers.length <= 1) return;
    
    const updatedBulkUsers = bulkUsers.filter((_, i) => i !== index);
    setBulkUsers(updatedBulkUsers);
  };

  const addBulkUserRow = () => {
    setBulkUsers([...bulkUsers, { name: '', email: '', approved: false }]);
  };

  const submitBulkUsers = async () => {
    const validUsers = bulkUsers.filter(user => user.name.trim() && user.email.trim());
    
    if (validUsers.length === 0) {
      setBulkAddStatus('Error: No valid users to add');
      return;
    }
    
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }
    
    try {
      setBulkAddStatus('Adding users...');
      
      const response = await fetch(`${API_URL}/admin/bulk-create-users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ users: validUsers }),
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to add users');
      }
      
      const data = await response.json();
      
      // Reset form and show success message
      setBulkUsers(Array(5).fill(null).map(() => ({ name: '', email: '', approved: false })));
      setBulkAddStatus(`Success: ${data.message || 'Users added successfully'}`);
      
      // Refresh the user list
      fetchUsers();
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
    <div className="admin-container">
      {!skipNavbar && <Navbar />}
      
      <div className="admin-content">
        <div className="admin-tabs">
          <button
            className={activeTab === AdminTab.Users ? 'active' : ''}
            onClick={() => setActiveTab(AdminTab.Users)}
          >
            Users
          </button>
          <button
            className={activeTab === AdminTab.Groups ? 'active' : ''}
            onClick={() => setActiveTab(AdminTab.Groups)}
          >
            Groups
          </button>
          <button
            className={activeTab === AdminTab.BulkAdd ? 'active' : ''}
            onClick={() => setActiveTab(AdminTab.BulkAdd)}
          >
            Bulk Add
          </button>
          <button
            className={activeTab === AdminTab.Roles ? 'active' : ''}
            onClick={() => setActiveTab(AdminTab.Roles)}
          >
            Roles
          </button>
        </div>

        {error && <div className="error-message">{error}</div>}
        {successMessage && <div className="success-message">{successMessage}</div>}

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
                      <td>
                        {user.isEditingName ? (
                          <div className="editable-name">
                            <input
                              type="text"
                              value={user.tempName || ''}
                              onChange={(e) =>
                                setUsers(users.map(u =>
                                  u.id === user.id
                                    ? { ...u, tempName: e.target.value }
                                    : u
                                ))
                              }
                              onBlur={() => {
                                if (user.tempName && user.tempName.trim() !== user.name) {
                                  updateUserName(user.id, user.tempName.trim());
                                } else {
                                  cancelEditingUserName(user.id);
                                }
                              }}
                              onKeyDown={(e) => handleUserNameKeyDown(e, user)}
                              autoFocus
                            />
                            <div className="editable-actions">
                              <button 
                                className="save-button"
                                onClick={() => {
                                  if (user.tempName && user.tempName.trim() !== user.name) {
                                    updateUserName(user.id, user.tempName.trim());
                                  }
                                }}
                                title="Save"
                              >
                                ✓
                              </button>
                              <button 
                                className="cancel-button"
                                onClick={() => cancelEditingUserName(user.id)}
                                title="Cancel"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="user-name" onClick={() => startEditingUserName(user)}>
                            <span>{user.name}</span>
                            <button className="edit-name-button" title="Edit Name">✎</button>
                          </div>
                        )}
                      </td>
                      <td>{user.email}</td>
                      <td>{user.approved ? 'Approved' : 'Pending'}</td>
                      <td>{user.userType}</td>
                      <td>
                        <div className="action-buttons">
                          {!user.approved && (
                            <button 
                              onClick={() => approveUser(user.id)}
                              className="btn btn-tertiary"
                            >
                              <i className="fas fa-check"></i>
                              <span className="btn-text">Approve</span>
                            </button>
                          )}
                          <select 
                            value={user.userType}
                            onChange={(e) => changeUserType(user.id, e.target.value as UserType)}
                            className="form-select"
                          >
                            <option value={UserType.Public}>Public</option>
                            <option value={UserType.Member}>Member</option>
                            <option value={UserType.Lead}>Lead</option>
                            <option value={UserType.Admin}>Admin</option>
                          </select>
                          <button 
                            onClick={() => {
                              if (window.confirm('Are you sure you want to delete this user? This action cannot be undone.')) {
                                deleteUser(user.id);
                              }
                            }}
                            className="btn btn-danger btn-with-icon"
                          >
                            <i className="fas fa-trash"></i>
                            <span className="btn-text">Delete</span>
                          </button>
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
                className="btn btn-primary btn-with-icon"
              >
                <i className="fas fa-plus"></i>
                <span className="btn-text">Create Group</span>
              </button>
            </div>
            
            <div className="groups-list">
              <h3>Existing Groups</h3>
              {groups.length === 0 ? (
                <p>No groups found. Create a new group to get started.</p>
              ) : (
                <div className="groups-container">
                  {groups.map(group => (
                    <div 
                      key={group.id} 
                      className="group-card"
                      style={{ cursor: 'default' }}
                    >
                        <div className="group-actions">
                          <button 
                            onClick={() => setEditingGroup(group)}
                            className="btn btn-tertiary btn-with-icon"
                          >
                            <i className="fas fa-edit"></i>
                            <span className="btn-text">Edit</span>
                          </button>
                          <button 
                            onClick={() => {
                              setSelectedGroup({ id: group.id, name: group.name });
                              setShowEmailDialog(true);
                            }}
                            className="btn btn-secondary btn-with-icon"
                          >
                            <i className="fas fa-envelope"></i>
                            <span className="btn-text">Email</span>
                          </button>
                          <button 
                            onClick={() => deleteGroup(group.id)}
                            className="btn btn-danger btn-with-icon"
                          >
                            <i className="fas fa-trash"></i>
                            <span className="btn-text">Delete</span>
                          </button>
                        </div>
                      <div className="group-header">
                        <h4>{group.name}</h4>

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
                                  onClick={(e) => {
                                    e.stopPropagation(); // Prevent event bubbling
                                    removeUserFromGroup(memberId, group.id);
                                  }}
                                  className="btn btn-danger btn-with-icon btn-sm"
                                >
                                  <i className="fas fa-times"></i>
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
                            e.stopPropagation(); // Prevent event bubbling
                            if (e.target.value) {
                              addUserToGroup(e.target.value, group.id);
                              e.target.value = ''; // Reset select after adding
                            }
                          }}
                          onClick={(e) => e.stopPropagation()} // Prevent event bubbling on click
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
                            className="btn btn-danger btn-with-icon btn-sm"
                            disabled={bulkUsers.length <= 1}
                          >
                            <i className="fas fa-times"></i>
                            <span className="btn-text">Remove</span>
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
                  className="btn btn-secondary btn-with-icon"
                >
                  <i className="fas fa-plus"></i>
                  <span className="btn-text">Add Row</span>
                </button>
                
                <button 
                  onClick={submitBulkUsers}
                  className="btn btn-primary btn-with-icon"
                  disabled={bulkUsers.every(user => !user.name.trim() || !user.email.trim())}
                >
                  <i className="fas fa-upload"></i>
                  <span className="btn-text">Submit</span>
                </button>
              </div>
            </div>
          </div>
        )}
        
        {activeTab === AdminTab.Roles && (
          <RoleManagement onSave={() => {
            setSuccessMessage('Role permissions updated successfully');
            setTimeout(() => setSuccessMessage(null), 3000);
          }} />
        )}
      </div>
      
      {editingGroup && (
        <div className="email-dialog-overlay">
          <div className="email-dialog">
            <div className="email-dialog-header">
              <h3>Edit Group: {editingGroup.name}</h3>
              <button className="close-button" onClick={() => setEditingGroup(null)}>×</button>
            </div>
            <div className="email-dialog-content">
              <div className="form-group">
                <label htmlFor="editGroupName">Group Name:</label>
                <input 
                  type="text" 
                  id="editGroupName" 
                  value={editingGroup.name}
                  onChange={(e) => setEditingGroup({...editingGroup, name: e.target.value})}
                />
              </div>
              <div className="form-group">
                <label htmlFor="editGroupDescription">Description:</label>
                <textarea 
                  id="editGroupDescription" 
                  value={editingGroup.description}
                  onChange={(e) => setEditingGroup({...editingGroup, description: e.target.value})}
                  rows={4}
                />
              </div>
              <div className="group-members">
                <h5>Members</h5>
                <ul>
                  {editingGroup.members && editingGroup.members.length > 0 ? editingGroup.members.map(memberId => {
                    const member = users.find(u => u.id === memberId);
                    return member ? (
                      <li key={memberId}>
                        {member.name} ({member.email})
                        <button 
                          onClick={(e) => {
                            e.stopPropagation(); // Prevent event bubbling
                            removeUserFromGroup(memberId, editingGroup.id);
                          }}
                          className="btn btn-danger btn-with-icon btn-sm"
                        >
                          <i className="fas fa-times"></i>
                          <span className="btn-text">Remove</span>
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
                    e.stopPropagation(); // Prevent event bubbling
                    if (e.target.value) {
                      addUserToGroup(e.target.value, editingGroup.id);
                      e.target.value = ''; // Reset select after adding
                    }
                  }}
                  onClick={(e) => e.stopPropagation()} // Prevent event bubbling on click
                  defaultValue=""
                >
                  <option value="" disabled>Select a user</option>
                  {users
                    .filter(user => !editingGroup.members || !editingGroup.members.includes(user.id))
                    .map(user => (
                      <option key={user.id} value={user.id}>
                        {user.name} ({user.email})
                      </option>
                    ))
                  }
                </select>
              </div>
            </div>
            <div className="email-dialog-footer">
              <button className="btn btn-secondary btn-with-icon" onClick={() => setEditingGroup(null)}>
                <i className="fas fa-times"></i>
                <span className="btn-text">Cancel</span>
              </button>
              <button 
                className="btn btn-primary btn-with-icon" 
                onClick={async () => {
                  if (!editingGroup) return;
                  
                  const sessionId = localStorage.getItem('sessionId');
                  if (!sessionId) {
                    navigate('/');
                    return;
                  }
                  
                  try {
                    const response = await fetch(`${API_URL}/admin/groups/${editingGroup.id}`, {
                      method: 'PUT',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${sessionId}`,
                      },
                      body: JSON.stringify({
                        name: editingGroup.name,
                        description: editingGroup.description
                      }),
                    });
                    
                    if (!response.ok) {
                      throw new Error('Failed to update group');
                    }
                    
                    // Update the groups list with the edited group
                    setGroups(groups.map(group => 
                      group.id === editingGroup.id ? editingGroup : group
                    ));
                    
                    setEditingGroup(null);
                    setError(null);
                  } catch (err) {
                    setError('Error updating group');
                  }
                }}
              >
                <i className="fas fa-save"></i>
                <span className="btn-text">Save Changes</span>
              </button>
            </div>
          </div>
        </div>
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
