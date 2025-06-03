import { Env } from '../utils/sessionManager';
import { CouncilRole, UserType, CouncilMember } from '../types';

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
    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE email = ?'
    ).bind(entry.email).first();

    if (user) {
      // Check if they're already a council member
      const existingMember = await env.DB.prepare(
        'SELECT * FROM council_members WHERE userId = ? AND role = ? AND active = true'
      ).bind(user.id, entry.role).first();

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

        await env.DB.prepare(
          'INSERT INTO council_members (id, userId, role, email, name, active, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          newMember.id,
          newMember.userId,
          newMember.role,
          newMember.email,
          newMember.name,
          newMember.active,
          newMember.createdAt,
          newMember.updatedAt
        ).run();

        // Update user type
        await env.DB.prepare(
          'UPDATE users SET userType = ? WHERE id = ?'
        ).bind(UserType.CouncilManager, user.id).run();
      }
    }
  }
}

export async function getCouncilManagersForRole(role: CouncilRole, env: Env): Promise<CouncilMember[]> {
  const members = (await env.DB.prepare(
    'SELECT * FROM council_members WHERE role = ? AND active = true'
  ).bind(role).all()) as unknown as D1Result<CouncilMember>;
  
  return members.results;
}

export async function updateOrgChartData(newData: OrgChartEntry[]) {
  // This function would be called when the org chart is updated
  // It would update the orgChartData array and then call identifyCouncilManagers
  // to ensure the database is in sync with the org chart
  orgChartData.length = 0;
  orgChartData.push(...newData);
} 