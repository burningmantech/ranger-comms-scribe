import React, { useState, useEffect } from 'react';
import { API_URL } from '../config';

interface Role {
  name: string;
  description: string;
  permissions: {
    canEdit: boolean;
    canApprove: boolean;
    canCreateSuggestions: boolean;
    canApproveSuggestions: boolean;
    canReviewSuggestions: boolean;
    canViewFilteredSubmissions: boolean;
  };
}

interface RoleManagementProps {
  onSave?: () => void;
}

export const RoleManagement: React.FC<RoleManagementProps> = ({ onSave }) => {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newRole, setNewRole] = useState<Partial<Role>>({
    name: '',
    description: '',
    permissions: {
      canEdit: false,
      canApprove: false,
      canCreateSuggestions: false,
      canApproveSuggestions: false,
      canReviewSuggestions: false,
      canViewFilteredSubmissions: false
    }
  });

  useEffect(() => {
    fetchRoles();
  }, []);

  const fetchRoles = async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      setError('No session found');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/roles`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch roles');
      }

      const data = await response.json();
      setRoles(data.roles);
      setLoading(false);
    } catch (err) {
      setError('Error fetching roles');
      setLoading(false);
    }
  };

  const createRole = async () => {
    if (!newRole.name || !newRole.description) {
      setError('Name and description are required');
      return;
    }

    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      setError('No session found');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/roles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify(newRole),
      });

      if (!response.ok) {
        throw new Error('Failed to create role');
      }

      setSuccessMessage('Role created successfully');
      setShowCreateForm(false);
      setNewRole({
        name: '',
        description: '',
        permissions: {
          canEdit: false,
          canApprove: false,
          canCreateSuggestions: false,
          canApproveSuggestions: false,
          canReviewSuggestions: false,
          canViewFilteredSubmissions: false
        }
      });
      
      // Refresh roles
      fetchRoles();
      
      if (onSave) {
        onSave();
      }
    } catch (err) {
      setError('Error creating role');
    }
  };

  const deleteRole = async (roleName: string) => {
    if (!window.confirm(`Are you sure you want to delete the role "${roleName}"? This will also delete the corresponding group.`)) {
      return;
    }

    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      setError('No session found');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/admin/roles/${roleName}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to delete role');
      }

      setSuccessMessage('Role deleted successfully');
      
      // Refresh roles
      fetchRoles();
      
      if (onSave) {
        onSave();
      }
    } catch (err) {
      setError('Error deleting role');
    }
  };

  const updateRolePermissions = async (roleName: string, permissions: Role['permissions']) => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      setError('No session found');
      return;
    }

    try {
      // Find the current role
      const currentRole = roles.find(r => r.name === roleName);
      if (!currentRole) {
        setError('Role not found');
        return;
      }

      // Create updated role object
      const updatedRole: Role = {
        ...currentRole,
        permissions
      };

      const response = await fetch(`${API_URL}/admin/roles/${roleName}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify(updatedRole),
      });

      if (!response.ok) {
        throw new Error('Failed to update role permissions');
      }

      setSuccessMessage('Role permissions updated successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
      
      // Refresh roles
      fetchRoles();
      
      if (onSave) {
        onSave();
      }
    } catch (err) {
      setError('Error updating role permissions');
    }
  };

  if (loading) {
    return <div>Loading roles...</div>;
  }

  return (
    <div className="role-management">
      <h2>Role Management</h2>
      
      {successMessage && (
        <div className="success-message">{successMessage}</div>
      )}
      
      {error && (
        <div className="error-message">{error}</div>
      )}

      <div className="role-actions">
        <button 
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="btn btn-primary btn-with-icon"
        >
          <i className="fas fa-plus"></i>
          <span className="btn-text">Create New Role</span>
        </button>
      </div>

      {showCreateForm && (
        <div className="create-role-form">
          <h3>Create New Role</h3>
          <div className="form-group">
            <label htmlFor="roleName">Role Name:</label>
            <input
              type="text"
              id="roleName"
              value={newRole.name}
              onChange={(e) => setNewRole({ ...newRole, name: e.target.value })}
              placeholder="Enter role name"
            />
          </div>
          <div className="form-group">
            <label htmlFor="roleDescription">Description:</label>
            <textarea
              id="roleDescription"
              value={newRole.description}
              onChange={(e) => setNewRole({ ...newRole, description: e.target.value })}
              placeholder="Enter role description"
            />
          </div>
          <div className="permissions-section">
            <h4>Permissions</h4>
            <div className="permission-item">
              <label>
                <input
                  type="checkbox"
                  checked={newRole.permissions?.canEdit}
                  onChange={(e) => setNewRole({
                    ...newRole,
                    permissions: {
                      ...newRole.permissions!,
                      canEdit: e.target.checked
                    }
                  })}
                />
                Can Edit Content
              </label>
            </div>
            <div className="permission-item">
              <label>
                <input
                  type="checkbox"
                  checked={newRole.permissions?.canApprove}
                  onChange={(e) => setNewRole({
                    ...newRole,
                    permissions: {
                      ...newRole.permissions!,
                      canApprove: e.target.checked
                    }
                  })}
                />
                Can Approve Content
              </label>
            </div>
            <div className="permission-item">
              <label>
                <input
                  type="checkbox"
                  checked={newRole.permissions?.canCreateSuggestions}
                  onChange={(e) => setNewRole({
                    ...newRole,
                    permissions: {
                      ...newRole.permissions!,
                      canCreateSuggestions: e.target.checked
                    }
                  })}
                />
                Can Create Suggestions
              </label>
            </div>
            <div className="permission-item">
              <label>
                <input
                  type="checkbox"
                  checked={newRole.permissions?.canApproveSuggestions}
                  onChange={(e) => setNewRole({
                    ...newRole,
                    permissions: {
                      ...newRole.permissions!,
                      canApproveSuggestions: e.target.checked
                    }
                  })}
                />
                Can Approve Suggestions
              </label>
            </div>
            <div className="permission-item">
              <label>
                <input
                  type="checkbox"
                  checked={newRole.permissions?.canReviewSuggestions}
                  onChange={(e) => setNewRole({
                    ...newRole,
                    permissions: {
                      ...newRole.permissions!,
                      canReviewSuggestions: e.target.checked
                    }
                  })}
                />
                Can Review Suggestions
              </label>
            </div>
            <div className="permission-item">
              <label>
                <input
                  type="checkbox"
                  checked={newRole.permissions?.canViewFilteredSubmissions}
                  onChange={(e) => setNewRole({
                    ...newRole,
                    permissions: {
                      ...newRole.permissions!,
                      canViewFilteredSubmissions: e.target.checked
                    }
                  })}
                />
                Can View Filtered Submissions
              </label>
            </div>
          </div>
          <div className="form-actions">
            <button 
              onClick={createRole}
              className="btn btn-primary btn-with-icon"
              disabled={!newRole.name || !newRole.description}
            >
              <i className="fas fa-save"></i>
              <span className="btn-text">Create Role</span>
            </button>
            <button 
              onClick={() => setShowCreateForm(false)}
              className="btn btn-secondary btn-with-icon"
            >
              <i className="fas fa-times"></i>
              <span className="btn-text">Cancel</span>
            </button>
          </div>
        </div>
      )}

      <div className="roles-grid">
        {roles.map((role) => (
          <div key={role.name} className="role-card">
            <div className="role-header">
              <h3>{role.name}</h3>
              <button 
                onClick={() => deleteRole(role.name)}
                className="btn btn-danger btn-with-icon"
              >
                <i className="fas fa-trash"></i>
              </button>
            </div>
            <p>{role.description}</p>
            
            <div className="permissions-section">
              <h4>Permissions</h4>
              
              <div className="permission-item">
                <label>
                  <input
                    type="checkbox"
                    checked={role.permissions.canEdit}
                    onChange={(e) => updateRolePermissions(role.name, {
                      ...role.permissions,
                      canEdit: e.target.checked
                    })}
                  />
                  Can Edit Content
                </label>
              </div>

              <div className="permission-item">
                <label>
                  <input
                    type="checkbox"
                    checked={role.permissions.canApprove}
                    onChange={(e) => updateRolePermissions(role.name, {
                      ...role.permissions,
                      canApprove: e.target.checked
                    })}
                  />
                  Can Approve Content
                </label>
              </div>

              <div className="permission-item">
                <label>
                  <input
                    type="checkbox"
                    checked={role.permissions.canCreateSuggestions}
                    onChange={(e) => updateRolePermissions(role.name, {
                      ...role.permissions,
                      canCreateSuggestions: e.target.checked
                    })}
                  />
                  Can Create Suggestions
                </label>
              </div>

              <div className="permission-item">
                <label>
                  <input
                    type="checkbox"
                    checked={role.permissions.canApproveSuggestions}
                    onChange={(e) => updateRolePermissions(role.name, {
                      ...role.permissions,
                      canApproveSuggestions: e.target.checked
                    })}
                  />
                  Can Approve Suggestions
                </label>
              </div>

              <div className="permission-item">
                <label>
                  <input
                    type="checkbox"
                    checked={role.permissions.canReviewSuggestions}
                    onChange={(e) => updateRolePermissions(role.name, {
                      ...role.permissions,
                      canReviewSuggestions: e.target.checked
                    })}
                  />
                  Can Review Suggestions
                </label>
              </div>

              <div className="permission-item">
                <label>
                  <input
                    type="checkbox"
                    checked={role.permissions.canViewFilteredSubmissions}
                    onChange={(e) => updateRolePermissions(role.name, {
                      ...role.permissions,
                      canViewFilteredSubmissions: e.target.checked
                    })}
                  />
                  Can View Filtered Submissions
                </label>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}; 