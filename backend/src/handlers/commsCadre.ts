import { Router } from 'itty-router';
import { UserType, User } from '../types';
import { withAuth } from '../authWrappers';
import { Env } from '../utils/sessionManager';

const router = Router();

interface CommsCadreMember {
  id: string;
  userId: string;
  email: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface D1Result<T> {
  results: T[];
  success: boolean;
  error?: string;
}

// Get all Comms Cadre members
router.get('/comms-cadre', withAuth, async (request: Request, env: Env) => {
  const members = (await env.DB.prepare('SELECT * FROM comms_cadre WHERE active = true').all()) as unknown as D1Result<CommsCadreMember>;
  return new Response(JSON.stringify(members.results || []), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Add a new Comms Cadre member
router.post('/comms-cadre', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user as User;
  if (!user || user.userType !== UserType.Admin) {
    return new Response('Unauthorized', { status: 401 });
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

  await env.DB.prepare(
    'INSERT INTO comms_cadre (id, userId, email, name, active, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    newMember.id,
    newMember.userId,
    newMember.email,
    newMember.name,
    newMember.active,
    newMember.createdAt,
    newMember.updatedAt
  ).run();

  // Update user type to CommsCadre
  await env.DB.prepare(
    'UPDATE users SET userType = ? WHERE id = ?'
  ).bind(UserType.CommsCadre, newMember.userId).run();

  return new Response(JSON.stringify(newMember), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Update a Comms Cadre member
router.put('/comms-cadre/:id', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user as User;
  if (!user || user.userType !== UserType.Admin) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id } = (request as any).params;
  const updates: Partial<CommsCadreMember> = await request.json();

  const member = await env.DB.prepare('SELECT * FROM comms_cadre WHERE id = ?').bind(id).first<CommsCadreMember>();
  if (!member) {
    return new Response('Comms Cadre member not found', { status: 404 });
  }

  const updatedMember: CommsCadreMember = {
    ...member,
    ...updates,
    updatedAt: new Date().toISOString()
  };

  await env.DB.prepare(
    'UPDATE comms_cadre SET email = ?, name = ?, active = ?, updatedAt = ? WHERE id = ?'
  ).bind(
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

// Deactivate a Comms Cadre member
router.delete('/comms-cadre/:id', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user as User;
  if (!user || user.userType !== UserType.Admin) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id } = (request as any).params;
  const member = await env.DB.prepare('SELECT * FROM comms_cadre WHERE id = ?').bind(id).first<CommsCadreMember>();
  
  if (!member) {
    return new Response('Comms Cadre member not found', { status: 404 });
  }

  await env.DB.prepare(
    'UPDATE comms_cadre SET active = false, updatedAt = ? WHERE id = ?'
  ).bind(new Date().toISOString(), id).run();

  // Revert user type if they are no longer a Comms Cadre member
  const activeRoles = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM comms_cadre WHERE userId = ? AND active = true'
  ).bind(member.userId).first<{ count: number }>();

  if (activeRoles?.count === 0) {
    await env.DB.prepare(
      'UPDATE users SET userType = ? WHERE id = ?'
    ).bind(UserType.Member, member.userId).run();
  }

  return new Response(null, { status: 204 });
});

export default router; 