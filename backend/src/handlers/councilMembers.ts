import { AutoRouter } from 'itty-router';
import { CouncilMember, CouncilRole, UserType, User } from '../types';
import { withAuth } from '../authWrappers';
import { Env } from '../utils/sessionManager';
import { getObject, putObject, listObjects, removeFromCache } from '../services/cacheService';
import { changeUserType, getUser } from '../services/userService';

export const router = AutoRouter({ base: '/api/council' });

// Get all council members (from both storage locations for completeness)
router.get('/members', withAuth, async (request: Request, env: Env) => {
  console.log('GET /council/members called');
  const membersMap = new Map<string, CouncilMember>();

  // Read from legacy council_member/ storage
  const objects = await listObjects('council_member/', env);
  for (const object of objects.objects) {
    const member = await getObject<CouncilMember>(object.key, env);
    if (member && member.active) {
      membersMap.set(member.email + ':' + member.role, member);
    }
  }

  // Also read from role-based storage used by approval system
  for (const role of Object.values(CouncilRole)) {
    const roleMembers = await getObject<CouncilMember[]>(`council_members:role:${role}`, env) || [];
    for (const member of roleMembers) {
      if (member && member.active) {
        membersMap.set(member.email + ':' + member.role, member);
      }
    }
  }

  return new Response(JSON.stringify(Array.from(membersMap.values())), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Add a new council member
router.post('/members', withAuth, async (request: Request, env: Env) => {
  console.log('🔍 Received request to add council member');
  const authUser = (request as any).user as User;
  console.log('👤 Authenticated user:', { id: authUser.id, email: authUser.email, userType: authUser.userType });

  if (!authUser || (authUser.userType !== UserType.Admin && !authUser.isAdmin)) {
    console.error('❌ Unauthorized: User is not an admin');
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const member: Partial<CouncilMember> = await request.json();
    console.log('📝 Request body:', member);

    const newMember: CouncilMember = {
      id: crypto.randomUUID(),
      userId: member.userId!,
      role: member.role!,
      email: member.email!,
      name: member.name!,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    console.log('📦 Created new member object:', newMember);

    // Store council member in legacy location
    await putObject(`council_member/${newMember.id}`, newMember, env, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { memberId: newMember.id }
    });

    // Also store in role-based location used by the approval system
    const existingRoleMembers = await getObject<CouncilMember[]>(`council_members:role:${newMember.role}`, env) || [];
    const isAlreadyInRole = existingRoleMembers.some(m => m.email === newMember.email);
    if (!isAlreadyInRole) {
      await putObject(`council_members:role:${newMember.role}`, [...existingRoleMembers, newMember], env);
    }

    // Store user-specific entry for the council manager service
    await putObject(`council_members:${newMember.userId}:${newMember.role}`, newMember, env);

    console.log('✅ Council member stored in all locations');

    // Update user type to CouncilManager
    const targetUser = await getUser(newMember.email, env);
    if (!targetUser) {
      throw new Error('User not found');
    }

    // Update user with CouncilManager role
    if (!targetUser.roles) {
      targetUser.roles = [];
    }
    if (!targetUser.roles.includes('CouncilManager')) {
      targetUser.roles.push('CouncilManager');
    }
    targetUser.userType = UserType.CouncilManager;

    await putObject(`user/${newMember.email}`, targetUser, env, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { userId: targetUser.id }
    });
    console.log('✅ User type updated successfully');

    return new Response(JSON.stringify(newMember), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('❌ Error adding council member:', error);
    return new Response(JSON.stringify({ error: 'Failed to add council member', details: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Update a council member
router.put('/members/:id', withAuth, async (request: Request, env: Env) => {
  const authUser = (request as any).user as User;
  if (!authUser || (authUser.userType !== UserType.Admin && !authUser.isAdmin)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id } = (request as any).params;
  const updates: Partial<CouncilMember> = await request.json();

  const member = await getObject<CouncilMember>(`council_member/${id}`, env);
  if (!member) {
    return new Response('Council member not found', { status: 404 });
  }

  const updatedMember: CouncilMember = {
    ...member,
    ...updates,
    updatedAt: new Date().toISOString()
  };

  // Update in legacy location
  await putObject(`council_member/${id}`, updatedMember, env, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { memberId: id }
  });

  // Also update in role-based storage
  const roleMembers = await getObject<CouncilMember[]>(`council_members:role:${updatedMember.role}`, env) || [];
  const updatedRoleMembers = roleMembers.map(m => m.email === updatedMember.email ? updatedMember : m);
  await putObject(`council_members:role:${updatedMember.role}`, updatedRoleMembers, env);

  return new Response(JSON.stringify(updatedMember), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Deactivate a council member
router.delete('/members/:id', withAuth, async (request: Request, env: Env) => {
  const authUser = (request as any).user as User;
  if (!authUser || (authUser.userType !== UserType.Admin && !authUser.isAdmin)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id } = (request as any).params;
  const member = await getObject<CouncilMember>(`council_member/${id}`, env);

  if (!member) {
    return new Response('Council member not found', { status: 404 });
  }

  // Update member to inactive in legacy location
  member.active = false;
  member.updatedAt = new Date().toISOString();
  await putObject(`council_member/${id}`, member, env, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { memberId: id }
  });

  // Also remove from role-based storage
  const roleMembers = await getObject<CouncilMember[]>(`council_members:role:${member.role}`, env) || [];
  const updatedRoleMembers = roleMembers.filter(m => m.email !== member.email);
  await putObject(`council_members:role:${member.role}`, updatedRoleMembers, env);

  // Remove user-specific entry
  await removeFromCache(`council_members:${member.userId}:${member.role}`, env);

  // Check if user has any other active council roles
  let hasActiveRoles = false;

  // Check legacy storage
  const objects = await listObjects('council_member/', env);
  for (const object of objects.objects) {
    const otherMember = await getObject<CouncilMember>(object.key, env);
    if (otherMember && otherMember.userId === member.userId && otherMember.active) {
      hasActiveRoles = true;
      break;
    }
  }

  // Also check role-based storage
  if (!hasActiveRoles) {
    for (const role of Object.values(CouncilRole)) {
      const members = await getObject<CouncilMember[]>(`council_members:role:${role}`, env) || [];
      if (members.some(m => m.userId === member.userId && m.active)) {
        hasActiveRoles = true;
        break;
      }
    }
  }

  // If no active roles, revert user type
  if (!hasActiveRoles) {
    await changeUserType(member.userId, UserType.Member, env);
  }

  return new Response(null, { status: 204 });
});
