import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { UserType, User } from '../types';
import { withAuth } from '../authWrappers';
import { Env } from '../utils/sessionManager';
import { getObject, putObject, deleteObject } from '../services/cacheService';

export const router = AutoRouter({ base: '/api/comms-cadre' });

interface CommsCadreMember {
  id: string;
  userId: string;
  email: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// Get all Comms Cadre members
router.get('/', withAuth, async (request: Request, env: Env) => {
  const members = await getObject<CommsCadreMember[]>('comms_cadre:active', env) || [];
  return json(members.filter(m => m.active));
});

// Add a new Comms Cadre member
router.post('/', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user as User;
  if (!user || user.userType !== UserType.Admin) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const member: Partial<CommsCadreMember> = await request.json();
  
  const newMember: CommsCadreMember = {
    id: crypto.randomUUID(),
    userId: member.userId!,
    email: member.email!,
    name: member.name!,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Get existing members
  const members = await getObject<CommsCadreMember[]>('comms_cadre:active', env) || [];
  
  // Add new member
  members.push(newMember);
  
  // Update cache
  await putObject('comms_cadre:active', members, env);

  // Update user type to CommsCadre
  const users = await getObject<User[]>('users', env) || [];
  const userIndex = users.findIndex(u => u.id === newMember.userId);
  if (userIndex !== -1) {
    users[userIndex].userType = UserType.CommsCadre;
    await putObject('users', users, env);
  }

  return json(newMember);
});

// Update a Comms Cadre member
router.put('/:id', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user as User;
  if (!user || user.userType !== UserType.Admin) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = (request as any).params;
  const updates: Partial<CommsCadreMember> = await request.json();

  // Get existing members
  const members = await getObject<CommsCadreMember[]>('comms_cadre:active', env) || [];
  const memberIndex = members.findIndex(m => m.id === id);
  
  if (memberIndex === -1) {
    return json({ error: 'Comms Cadre member not found' }, { status: 404 });
  }

  const updatedMember: CommsCadreMember = {
    ...members[memberIndex],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  // Update member in array
  members[memberIndex] = updatedMember;
  
  // Update cache
  await putObject('comms_cadre:active', members, env);

  return json(updatedMember);
});

// Deactivate a Comms Cadre member
router.delete('/:id', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user as User;
  if (!user || user.userType !== UserType.Admin) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = (request as any).params;
  
  // Get existing members
  const members = await getObject<CommsCadreMember[]>('comms_cadre:active', env) || [];
  const memberIndex = members.findIndex(m => m.id === id);
  
  if (memberIndex === -1) {
    return json({ error: 'Comms Cadre member not found' }, { status: 404 });
  }

  const member = members[memberIndex];
  
  // Update member to inactive
  members[memberIndex] = {
    ...member,
    active: false,
    updatedAt: new Date().toISOString()
  };
  
  // Update cache
  await putObject('comms_cadre:active', members, env);

  // Check if user has any other active roles
  const activeRoles = members.filter(m => m.userId === member.userId && m.active).length;

  if (activeRoles === 0) {
    // Revert user type if they are no longer a Comms Cadre member
    const users = await getObject<User[]>('users', env) || [];
    const userIndex = users.findIndex(u => u.id === member.userId);
    if (userIndex !== -1) {
      users[userIndex].userType = UserType.Member;
      await putObject('users', users, env);
    }
  }

  return new Response(null, { status: 204 });
}); 