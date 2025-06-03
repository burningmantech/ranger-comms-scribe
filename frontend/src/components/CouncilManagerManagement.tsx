import React, { useState, useEffect } from 'react';
import { CouncilManager, CouncilRole } from '../types/content';

interface CouncilManagerManagementProps {
  onSave: (managers: CouncilManager[]) => void;
  initialManagers?: CouncilManager[];
}

export const CouncilManagerManagement: React.FC<CouncilManagerManagementProps> = ({
  onSave,
  initialManagers = []
}) => {
  const [managers, setManagers] = useState<CouncilManager[]>(initialManagers);
  const [newManager, setNewManager] = useState<Partial<CouncilManager>>({
    email: '',
    name: '',
    role: 'COMMUNICATIONS_MANAGER'
  });

  const handleAddManager = () => {
    if (newManager.email && newManager.name && newManager.role) {
      const manager: CouncilManager = {
        id: crypto.randomUUID(),
        email: newManager.email,
        name: newManager.name,
        role: newManager.role as CouncilRole
      };
      setManagers([...managers, manager]);
      setNewManager({ email: '', name: '', role: 'COMMUNICATIONS_MANAGER' });
    }
  };

  const handleRemoveManager = (id: string) => {
    setManagers(managers.filter(manager => manager.id !== id));
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
            className="p-2 border rounded"
          />
          <input
            type="email"
            placeholder="Email"
            value={newManager.email}
            onChange={(e) => setNewManager({ ...newManager, email: e.target.value })}
            className="p-2 border rounded"
          />
          <select
            value={newManager.role}
            onChange={(e) => setNewManager({ ...newManager, role: e.target.value as CouncilRole })}
            className="p-2 border rounded"
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
        <button
          onClick={handleAddManager}
          className="mt-3 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          Add Manager
        </button>
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
                className="px-3 py-1 text-red-500 hover:text-red-700"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={handleSave}
        className="px-6 py-2 bg-green-500 text-white rounded hover:bg-green-600"
      >
        Save Changes
      </button>
    </div>
  );
}; 