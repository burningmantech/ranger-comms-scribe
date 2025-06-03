import React, { useState } from 'react';
import { User } from '../types/content';

interface CommsCadreManagementProps {
  members: User[];
  onAddMember: (email: string) => void;
  onRemoveMember: (userId: string) => void;
}

export const CommsCadreManagement: React.FC<CommsCadreManagementProps> = ({
  members,
  onAddMember,
  onRemoveMember
}) => {
  const [newMemberEmail, setNewMemberEmail] = useState('');

  const handleAddMember = () => {
    if (newMemberEmail.trim()) {
      onAddMember(newMemberEmail.trim());
      setNewMemberEmail('');
    }
  };

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold mb-4">Comms Cadre Management</h2>
      
      <div className="mb-6 p-4 border rounded-lg">
        <h3 className="text-lg font-semibold mb-3">Add New Member</h3>
        <div className="flex space-x-2">
          <input
            type="email"
            placeholder="Member's email"
            value={newMemberEmail}
            onChange={(e) => setNewMemberEmail(e.target.value)}
            className="form-control"
          />
          <button
            onClick={handleAddMember}
            className="btn btn-primary btn-with-icon"
          >
            <i className="fas fa-plus"></i>
            <span className="btn-text">Add Member</span>
          </button>
        </div>
      </div>

      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3">Current Members</h3>
        <div className="space-y-4">
          {members.map((member) => (
            <div key={member.id} className="flex items-center justify-between p-3 border rounded">
              <div>
                <p className="font-medium">{member.name}</p>
                <p className="text-sm text-gray-600">{member.email}</p>
              </div>
              <button
                onClick={() => onRemoveMember(member.id)}
                className="btn btn-danger btn-with-icon"
              >
                <i className="fas fa-trash"></i>
                <span className="btn-text">Remove</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}; 