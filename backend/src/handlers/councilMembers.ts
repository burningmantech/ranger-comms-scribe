import { AutoRouter } from 'itty-router';
import { CouncilMember, CouncilRole, UserType, User } from '../types';
import { withAuth } from '../authWrappers';
import { Env } from '../utils/sessionManager';
import { getObject, putObject, listObjects } from '../services/cacheService';
import { changeUserType } from '../services/userService';

export const router = AutoRouter({ base: '/api/council' });

// Get all council members
router.get('/members', withAuth, async (request: Request, env: Env) => {
  console.log('GET /council/members called');
  const objects = await listObjects('council_member/', env);
  const members: CouncilMember[] = [];
  
  for (const object of objects.objects) {
    const member = await getObject<CouncilMember>(object.key, env);
    if (member && member.active) {
      members.push(member);
    }
  }

  return new Response(JSON.stringify(members), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Add a new council member
router.post('/members', withAuth, async (request: Request, env: Env) => {
  console.log('🔍 Received request to add council member');
  const user = (request as any).user as User;
  console.log('👤 Authenticated user:', { id: user.id, email: user.email, userType: user.userType });
  
  if (!user || user.userType !== UserType.Admin) {
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

    // Store council member
    console.log('💾 Storing council member in cache');
    await putObject(`council_member/${newMember.id}`, newMember, env, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { memberId: newMember.id }
    });
    console.log('✅ Council member stored successfully');

    // Update user type to CouncilManager and add to group
    console.log('🔄 Updating user type to CouncilManager');
    const user = await getObject<User>(`user/${newMember.email}`, env);
    if (!user) {
      throw new Error('User not found');
    }
    
    // Update user with CouncilManager role
    await putObject(`user/${newMember.email}`, {
      ...user,
      userType: UserType.CouncilManager,
      roles: ['CouncilManager']
    }, env);
    console.log('✅ User type updated successfully');

    console.log('✅ Successfully added council member');
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
  const user = (request as any).user as User;
  if (!user || user.userType !== UserType.Admin) {
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

  await putObject(`council_member/${id}`, updatedMember, env, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { memberId: id }
  });

  return new Response(JSON.stringify(updatedMember), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Deactivate a council member
router.delete('/members/:id', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user as User;
  if (!user || user.userType !== UserType.Admin) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id } = (request as any).params;
  const member = await getObject<CouncilMember>(`council_member/${id}`, env);
  
  if (!member) {
    return new Response('Council member not found', { status: 404 });
  }

  // Update member to inactive
  member.active = false;
  member.updatedAt = new Date().toISOString();
  await putObject(`council_member/${id}`, member, env, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { memberId: id }
  });

  // Check if user has any other active council roles
  const objects = await listObjects('council_member/', env);
  let hasActiveRoles = false;
  
  for (const object of objects.objects) {
    const otherMember = await getObject<CouncilMember>(object.key, env);
    if (otherMember && otherMember.userId === member.userId && otherMember.active) {
      hasActiveRoles = true;
      break;
    }
  }

  // If no active roles, revert user type and remove from group
  if (!hasActiveRoles) {
    await changeUserType(member.userId, UserType.Member, env);
  }

  return new Response(null, { status: 204 });
});

// // Add a catch-all route for debugging
// router.all('*', async (request: Request, env: Env) => {
//   console.log('Catch-all route hit:', request.url);
//   console.log('Request method:', request.method);
//   const headers: Record<string, string> = {};
//   request.headers.forEach((value, key) => {
//     headers[key] = value;
//   });
//   console.log('Request headers:', headers);
//   console.log('ENV object:', env);
//   console.log('ENV KEYS:', Object.keys(env));
//   return new Response('Route not found', { status: 404 });
// }); 