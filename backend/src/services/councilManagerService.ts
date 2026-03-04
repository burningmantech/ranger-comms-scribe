import { Env } from '../utils/sessionManager';
import { CouncilRole, UserType, CouncilMember, User } from '../types';
import { getObject, putObject, removeFromCache } from './cacheService';
import { getUser, saveUser } from './userService';

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
    const user = await getUser(entry.email, env);

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

        // Update user type and roles
        if (!user.roles) {
          user.roles = [];
        }
        if (!user.roles.includes('CouncilManager')) {
          user.roles.push('CouncilManager');
        }
        user.userType = UserType.CouncilManager;
        await saveUser(user, env);
      }
    }
  }
}

export async function getCouncilManagersForRole(role: CouncilRole, env: Env): Promise<CouncilMember[]> {
  const members = await getObject<CouncilMember[]>(`council_members:role:${role}`, env);
  console.log(`🔍 getCouncilManagersForRole(${role}):`, members);
  console.log(`🔍 getCouncilManagersForRole(${role}) count:`, members?.length || 0);
  return members || [];
}

export async function updateOrgChartData(newData: OrgChartEntry[]) {
  // This function would be called when the org chart is updated
  // It would update the orgChartData array and then call identifyCouncilManagers
  // to ensure the database is in sync with the org chart
  orgChartData.length = 0;
  orgChartData.push(...newData);
}

export async function addCouncilMember(email: string, role: CouncilRole, env: Env): Promise<CouncilMember | null> {
  try {
    console.log('🔄 Adding council member:', { email, role });
    
    // Get or create the user
    const user = await getUser(email, env);
    if (!user) {
      console.log('❌ User not found:', email);
      return null;
    }
    
    console.log('👤 Found user:', { email: user.email, name: user.name, userType: user.userType, roles: user.roles });

    // Get existing council members for this role
    const existingMembers = await getObject<CouncilMember[]>(`council_members:role:${role}`, env) || [];
    console.log('📋 Existing members for role:', role, existingMembers.length);

    // Check if user is already a council member for this role
    const isAlreadyMember = existingMembers.some(member => member.email === email);
    if (isAlreadyMember) {
      console.log('⚠️ User is already a council member for this role:', email);
      return null;
    }

    // Create new council member entry
    const newMember: CouncilMember = {
      id: crypto.randomUUID(),
      userId: user.id,
      role,
      email,
      name: user.name || email.split('@')[0],
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Add to role-specific list
    await putObject(`council_members:role:${role}`, [...existingMembers, newMember], env);
    console.log('✅ Added to role-specific list');

    // Add to user-specific entry
    await putObject(`council_members:${user.id}:${role}`, newMember, env);
    console.log('✅ Added to user-specific entry');

    // Update user type if needed
    if (user.userType !== UserType.CouncilManager) {
      console.log('🔄 Updating user to CouncilManager type:', user.email);
      
      // Ensure user has a roles array
      if (!user.roles) {
        user.roles = [];
      }
      
      // Add CouncilManager role if not already present
      if (!user.roles.includes('CouncilManager')) {
        user.roles.push('CouncilManager');
        console.log('➕ Added CouncilManager role to user:', user.email);
      }
      
      user.userType = UserType.CouncilManager;
      await saveUser(user, env);

      console.log('✅ Updated user roles:', user.roles);
    } else {
      console.log('👤 User is already CouncilManager type:', user.email);
    }

    console.log('🎉 Successfully added council member:', newMember);
    return newMember;
  } catch (error) {
    console.error('Error adding council member:', error);
    return null;
  }
}

export async function removeCouncilMember(email: string, role: CouncilRole, env: Env): Promise<boolean> {
  try {
    // Get the user
    const user = await getUser(email, env);
    if (!user) {
      return false;
    }

    // Get existing council members for this role
    const existingMembers = await getObject<CouncilMember[]>(`council_members:role:${role}`, env) || [];

    // Remove from role-specific list
    const updatedMembers = existingMembers.filter(member => member.email !== email);
    await putObject(`council_members:role:${role}`, updatedMembers, env);

    // Remove user-specific entry
    await removeFromCache(`council_members:${user.id}:${role}`, env);

    // Check if user has any other active council roles by checking each role individually
    let hasOtherRoles = false;
    for (const otherRole of Object.values(CouncilRole)) {
      if (otherRole === role) continue; // Skip the role we just removed
      const member = await getObject<CouncilMember>(`council_members:${user.id}:${otherRole}`, env);
      if (member && member.active) {
        hasOtherRoles = true;
        break;
      }
    }

    if (!hasOtherRoles) {
      // No other council roles - revert user type to Member
      user.userType = UserType.Member;
      user.roles = ['Member'];
      await saveUser(user, env);
    }

    return true;
  } catch (error) {
    console.error('Error removing council member:', error);
    return false;
  }
} 