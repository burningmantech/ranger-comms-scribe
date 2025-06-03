import { Env } from '../utils/sessionManager';
import { CouncilRole, UserType, CouncilMember } from '../types';
import { getObject, putObject, removeFromCache } from './cacheService';

interface OrgChartEntry {
  role: CouncilRole;
  email: string;
  name: string;
}

interface D1Result<T> {
  results: T[];
  success: boolean;
  error?: string;
}

// This would be populated from the org chart data
const orgChartData: OrgChartEntry[] = [
  // Example data - this would be replaced with actual data from the org chart
  {
    role: CouncilRole.CommunicationsManager,
    email: 'communications@rangers.burningman.org',
    name: 'Communications Manager'
  },
  {
    role: CouncilRole.IntakeManager,
    email: 'intake@rangers.burningman.org',
    name: 'Intake Manager'
  },
  {
    role: CouncilRole.LogisticsManager,
    email: 'logistics@rangers.burningman.org',
    name: 'Logistics Manager'
  },
  {
    role: CouncilRole.OperationsManager,
    email: 'operations@rangers.burningman.org',
    name: 'Operations Manager'
  },
  {
    role: CouncilRole.PersonnelManager,
    email: 'personnel@rangers.burningman.org',
    name: 'Personnel Manager'
  },
  {
    role: CouncilRole.DepartmentManager,
    email: 'department@rangers.burningman.org',
    name: 'Department Manager'
  },
  {
    role: CouncilRole.DeputyDepartmentManager,
    email: 'deputy@rangers.burningman.org',
    name: 'Deputy Department Manager'
  }
];

export async function identifyCouncilManagers(env: Env) {
  for (const entry of orgChartData) {
    // Check if user exists
    const user = await getObject<{ id: string }>(`users:${entry.email}`, env);

    if (user) {
      // Check if they're already a council member
      const existingMember = await getObject<CouncilMember>(`council_members:${user.id}:${entry.role}`, env);

      if (!existingMember) {
        // Create new council member entry
        const newMember = {
          id: crypto.randomUUID(),
          userId: user.id,
          role: entry.role,
          email: entry.email,
          name: entry.name,
          active: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        await putObject(`council_members:${user.id}:${entry.role}`, newMember, env);

        // Update user type
        await putObject(`users:${entry.email}`, { ...user, userType: UserType.CouncilManager }, env);
      }
    }
  }
}

export async function getCouncilManagersForRole(role: CouncilRole, env: Env): Promise<CouncilMember[]> {
  const members = await getObject<CouncilMember[]>(`council_members:role:${role}`, env);
  return members || [];
}

export async function updateOrgChartData(newData: OrgChartEntry[]) {
  // This function would be called when the org chart is updated
  // It would update the orgChartData array and then call identifyCouncilManagers
  // to ensure the database is in sync with the org chart
  orgChartData.length = 0;
  orgChartData.push(...newData);
} 