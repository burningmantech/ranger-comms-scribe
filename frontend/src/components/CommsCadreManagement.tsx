import React, { useState } from 'react';
import { User } from '../types/content';

interface CommsCadreManagementProps {
  members: User[];
  onAddMember: (email: string, name: string) => void;
  onRemoveMember: (userId: string) => void;
}

export const CommsCadreManagement: React.FC<CommsCadreManagementProps> = ({
  members,
  onAddMember,
  onRemoveMember
}) => {
  const [newMember, setNewMember] = useState({
    email: '',
    name: ''
  });

  const handleAddMember = () => {
    if (newMember.email.trim() && newMember.name.trim()) {
      onAddMember(newMember.email.trim(), newMember.name.trim());
      setNewMember({ email: '', name: '' });
    }
  };

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold mb-4">Comms Cadre Management</h2>
      
      <div className="mb-6 p-4 border rounded-lg">
        <h3 className="text-lg font-semibold mb-3">Add New Member</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <input
            type="text"
            placeholder="Name"
            value={newMember.name}
            onChange={(e) => setNewMember({ ...newMember, name: e.target.value })}
            className="form-control"
          />
          <input
            type="email"
            placeholder="Email"
            value={newMember.email}
            onChange={(e) => setNewMember({ ...newMember, email: e.target.value })}
            className="form-control"
          />
        </div>
        <div className="mt-3">
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