import { Router } from 'itty-router';
import { CouncilMember, CouncilRole, UserType, User } from '../types';
import { withAuth } from '../authWrappers';

const router = Router();

// Get all council members
router.get('/council-members', withAuth, async (request: Request, env: any) => {
  const members = await env.DB.prepare('SELECT * FROM council_members WHERE active = true').all();
  return new Response(JSON.stringify(members.results), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Add a new council member
router.post('/council-members', withAuth, async (request: Request, env: any) => {
  const user = (request as any).user as User;
  if (!user || user.userType !== UserType.Admin) {
    return new Response('Unauthorized', { status: 401 });
  }

  const member: Partial<CouncilMember> = await request.json();
  
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

  // Update user type to CouncilManager
  await env.DB.prepare(
    'UPDATE users SET userType = ? WHERE id = ?'
  ).bind(UserType.CouncilManager, newMember.userId).run();

  return new Response(JSON.stringify(newMember), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Update a council member
router.put('/council-members/:id', withAuth, async (request: Request, env: any) => {
  const user = (request as any).user as User;
  if (!user || user.userType !== UserType.Admin) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id } = (request as any).params;
  const updates: Partial<CouncilMember> = await request.json();

  const member = await env.DB.prepare('SELECT * FROM council_members WHERE id = ?').bind(id).first();
  if (!member) {
    return new Response('Council member not found', { status: 404 });
  }

  const updatedMember: CouncilMember = {
    ...member,
    ...updates,
    updatedAt: new Date().toISOString()
  };

  await env.DB.prepare(
    'UPDATE council_members SET role = ?, email = ?, name = ?, active = ?, updatedAt = ? WHERE id = ?'
  ).bind(
    updatedMember.role,
    updatedMember.email,
    updatedMember.name,
    updatedMember.active,
    updatedMember.updatedAt,
    id
  ).run();

  return new Response(JSON.stringify(updatedMember), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Deactivate a council member
router.delete('/council-members/:id', withAuth, async (request: Request, env: any) => {
  const user = (request as any).user as User;
  if (!user || user.userType !== UserType.Admin) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id } = (request as any).params;
  const member = await env.DB.prepare('SELECT * FROM council_members WHERE id = ?').bind(id).first();
  
  if (!member) {
    return new Response('Council member not found', { status: 404 });
  }

  await env.DB.prepare(
    'UPDATE council_members SET active = false, updatedAt = ? WHERE id = ?'
  ).bind(new Date().toISOString(), id).run();

  // Revert user type if they are no longer a council member
  const activeRoles = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM council_members WHERE userId = ? AND active = true'
  ).bind(member.userId).first();

  if (activeRoles.count === 0) {
    await env.DB.prepare(
      'UPDATE users SET userType = ? WHERE id = ?'
    ).bind(UserType.Member, member.userId).run();
  }

  return new Response(null, { status: 204 });
});

export default router; 