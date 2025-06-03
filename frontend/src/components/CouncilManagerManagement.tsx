import React, { useState, useEffect } from 'react';
import { CouncilManager, CouncilRole } from '../types/content';
import { useContent } from '../contexts/ContentContext';

interface CouncilManagerManagementProps {
  onSave: (managers: CouncilManager[]) => void;
  initialManagers?: CouncilManager[];
}

export const CouncilManagerManagement: React.FC<CouncilManagerManagementProps> = ({
  onSave,
  initialManagers = []
}) => {
  const { removeCouncilManager } = useContent();
  const [managers, setManagers] = useState<CouncilManager[]>(initialManagers);
  const [newManager, setNewManager] = useState<Partial<CouncilManager>>({
    email: '',
    name: '',
    role: 'COMMUNICATIONS_MANAGER'
  });

  const handleAddManager = () => {
    if (newManager.email && newManager.name && newManager.role) {
      const manager: Partial<CouncilManager> = {
        email: newManager.email,
        name: newManager.name,
        role: newManager.role as CouncilRole
      };
      setManagers([...managers, manager as CouncilManager]);
      setNewManager({ email: '', name: '', role: 'COMMUNICATIONS_MANAGER' });
    }
  };

  const handleRemoveManager = async (id: string) => {
    try {
      await removeCouncilManager(id);
      setManagers(managers.filter(manager => manager.id !== id));
    } catch (error) {
      console.error('Error removing manager:', error);
      // You might want to show an error message to the user here
    }
  };

  const handleSave = () => {
    onSave(managers);
  };

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold mb-4">Council Manager Management</h2>
      
      <div className="mb-6 p-4 border rounded-lg">
        <h3 className="text-lg font-semibold mb-3">Add New Manager</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <input
            type="text"
            placeholder="Name"
            value={newManager.name}
            onChange={(e) => setNewManager({ ...newManager, name: e.target.value })}
            className="form-control"
          />
          <input
            type="email"
            placeholder="Email"
            value={newManager.email}
            onChange={(e) => setNewManager({ ...newManager, email: e.target.value })}
            className="form-control"
          />
          <select
            value={newManager.role}
            onChange={(e) => setNewManager({ ...newManager, role: e.target.value as CouncilRole })}
            className="form-select"
          >
            <option value="COMMUNICATIONS_MANAGER">Communications Manager</option>
            <option value="INTAKE_MANAGER">Intake Manager</option>
            <option value="LOGISTICS_MANAGER">Logistics Manager</option>
            <option value="OPERATIONS_MANAGER">Operations Manager</option>
            <option value="PERSONNEL_MANAGER">Personnel Manager</option>
            <option value="DEPARTMENT_MANAGER">Department Manager</option>
            <option value="DEPUTY_DEPARTMENT_MANAGER">Deputy Department Manager</option>
          </select>
        </div>
        <div className="mt-3">
          <button
            onClick={handleAddManager}
            className="btn btn-primary btn-with-icon"
          >
            <i className="fas fa-plus"></i>
            <span className="btn-text">Add Manager</span>
          </button>
        </div>
      </div>

      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3">Current Managers</h3>
        <div className="space-y-4">
          {managers.map((manager) => (
            <div key={manager.id} className="flex items-center justify-between p-3 border rounded">
              <div>
                <p className="font-medium">{manager.name}</p>
                <p className="text-sm text-gray-600">{manager.email}</p>
                <p className="text-sm text-gray-500">{manager.role.replace(/_/g, ' ')}</p>
              </div>
              <button
                onClick={() => handleRemoveManager(manager.id)}
                className="btn btn-danger btn-with-icon"
              >
                <i className="fas fa-trash"></i>
                <span className="btn-text">Remove</span>
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="btn-group btn-group-right">
        <button
          onClick={handleSave}
          className="btn btn-secondary btn-with-icon"
        >
          <i className="fas fa-save"></i>
          <span className="btn-text">Save Changes</span>
        </button>
      </div>
    </div>
  );
}; 