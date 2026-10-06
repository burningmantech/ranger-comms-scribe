import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { router as councilRouter } from '../../src/handlers/councilMembers';
import { router as cadreRouter } from '../../src/handlers/commsCadre';
import { router as adminRouter } from '../../src/handlers/admin';
import { clearMemoryCache, getObject } from '../../src/services/cacheService';
import { saveUser } from '../../src/services/userService';
import { withDerivedAccess } from '../../src/services/access';
import { CreateSession } from '../../src/utils/sessionManager';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';

/**
 * People and their access: one record per person (services/access.ts). The People page changes
 * it (PUT /admin/people/:id/access); the council and Comms Cadre lists are read from it.
 */

let env: any;
let adminSession = '';

async function person(email: string, access: Record<string, unknown> = {}) {
  await saveUser(withDerivedAccess({
    id: `id-${email.split('@')[0]}`, email, name: email.split('@')[0], verified: true, groups: [],
    roles: [], userType: 'Member', isAdmin: false, commsCadre: false, councilRole: null, ...access,
  } as any) as any, env);
}

async function call(router: any, method: string, path: string, session: string, body?: unknown) {
  const res: Response = await router.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env);
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  clearMemoryCache();
  env = { STORE: new MemoryObjectStore() };
  await person('boss@x.org', { isAdmin: true });
  await person('cm@x.org', { commsCadre: true, councilRole: 'CommunicationsManager' });
  await person('ranger@x.org');
  adminSession = await CreateSession('boss@x.org', { email: 'boss@x.org' }, env);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('people and access', () => {
  it('adds people (Add people), then gives them a role by the id it returned', async () => {
    const added = await call(adminRouter, 'POST', '/api/admin/bulk-create-users', adminSession, {
      users: [{ name: ' Casey Ranger ', email: ' Casey@Example.org ' }, { name: 'Dana', email: 'dana@example.org' }],
    });
    expect(added.status).toBe(200);
    expect(added.body.users).toHaveLength(2);
    const [casey, dana] = added.body.users;
    expect(casey).toMatchObject({ email: 'casey@example.org', name: 'Casey Ranger', userType: 'Member', commsCadre: false, councilRole: null });
    expect(casey.passwordHash).toBeUndefined();
    expect(dana).toMatchObject({ email: 'dana@example.org', userType: 'Member' });

    const res = await call(adminRouter, 'PUT', `/api/admin/people/${encodeURIComponent(casey.id)}/access`, adminSession, { commsCadre: true });
    expect(res.status).toBe(200);
    const stored = await getObject<any>('user/casey@example.org', env);
    expect(stored).toMatchObject({ commsCadre: true, userType: 'CommsCadre' });
  });

  it('lists the council and the Comms Cadre from people', async () => {
    const council = await call(councilRouter, 'GET', '/api/council/members', adminSession);
    expect(council.body).toEqual([expect.objectContaining({ email: 'cm@x.org', role: 'CommunicationsManager', active: true })]);
    const cadre = await call(cadreRouter, 'GET', '/api/comms-cadre', adminSession);
    expect(cadre.body).toEqual([expect.objectContaining({ email: 'cm@x.org', active: true })]);
  });

  it('gives one person one council role, alongside Comms Cadre and Admin, which are independent', async () => {
    let res = await call(adminRouter, 'PUT', '/api/admin/people/ranger@x.org/access', adminSession, { commsCadre: true, councilRole: 'IntakeManager' });
    expect(res.status).toBe(200);
    expect(res.body.person).toMatchObject({ email: 'ranger@x.org', commsCadre: true, councilRole: 'IntakeManager', isAdmin: false });
    let stored = await getObject<any>('user/ranger@x.org', env);
    expect(stored.userType).toBe('CouncilManager');
    expect(stored.roles).toEqual(['CommsCadre', 'CouncilManager']);

    // A new council role replaces the old one
    res = await call(adminRouter, 'PUT', '/api/admin/people/ranger@x.org/access', adminSession, { councilRole: 'CommunicationsManager' });
    expect(res.body.person).toMatchObject({ commsCadre: true, councilRole: 'CommunicationsManager' });
    // Taking away Comms Cadre leaves the council role alone
    res = await call(adminRouter, 'PUT', '/api/admin/people/ranger@x.org/access', adminSession, { commsCadre: false });
    expect(res.body.person).toMatchObject({ commsCadre: false, councilRole: 'CommunicationsManager' });
    // Making them Admin keeps it
    res = await call(adminRouter, 'PUT', '/api/admin/people/ranger@x.org/access', adminSession, { isAdmin: true, commsCadre: true });
    expect(res.body.person).toMatchObject({ isAdmin: true, commsCadre: true, councilRole: 'CommunicationsManager' });
    stored = await getObject<any>('user/ranger@x.org', env);
    expect(stored.roles).toEqual(['Admin', 'CommsCadre', 'CouncilManager']);
    expect(stored.councilRoles).toBeUndefined();
    // null takes the council role away
    res = await call(adminRouter, 'PUT', '/api/admin/people/ranger@x.org/access', adminSession, { councilRole: null });
    expect(res.body.person).toMatchObject({ councilRole: null });
    expect((await getObject<any>('user/ranger@x.org', env)).roles).toEqual(['Admin', 'CommsCadre']);
  });

  it('refuses unknown council roles, the older fields, and non-boolean flags', async () => {
    expect((await call(adminRouter, 'PUT', '/api/admin/people/ranger@x.org/access', adminSession, { councilRole: 'Mayor' })).status).toBe(400);
    // The older shapes are refused outright, not ignored
    const old = await call(adminRouter, 'PUT', '/api/admin/people/ranger@x.org/access', adminSession, { councilRoles: ['IntakeManager'] });
    expect(old.status).toBe(400);
    expect(old.body.error).toMatch(/councilRole/);
    expect((await call(adminRouter, 'PUT', '/api/admin/people/ranger@x.org/access', adminSession, { approved: true })).status).toBe(400);
    expect((await call(adminRouter, 'PUT', '/api/admin/people/ranger@x.org/access', adminSession, { isAdmin: 'yes' })).status).toBe(400);
    expect((await call(adminRouter, 'PUT', '/api/admin/people/nobody@x.org/access', adminSession, { isAdmin: true })).status).toBe(404);
  });

  it("won't remove your own Admin, or the last Admin", async () => {
    let res = await call(adminRouter, 'PUT', '/api/admin/people/boss@x.org/access', adminSession, { isAdmin: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/your own Admin/);
    // With a second Admin, one can remove the other
    await call(adminRouter, 'PUT', '/api/admin/people/ranger@x.org/access', adminSession, { isAdmin: true });
    const other = await CreateSession('ranger@x.org', { email: 'ranger@x.org' }, env);
    res = await call(adminRouter, 'PUT', '/api/admin/people/boss@x.org/access', other, { isAdmin: false });
    expect(res.status).toBe(200);
    // Now ranger is the only Admin: a non-admin can't call this at all, and ranger can't remove themselves
    expect((await call(adminRouter, 'PUT', '/api/admin/people/ranger@x.org/access', other, { isAdmin: false })).status).toBe(409);
  });

  it('is for Admins only, and never returns password hashes', async () => {
    const ranger = await CreateSession('ranger@x.org', { email: 'ranger@x.org' }, env);
    expect((await call(adminRouter, 'PUT', '/api/admin/people/ranger@x.org/access', ranger, { isAdmin: true })).status).toBe(403);
    await saveUser({ ...(await getObject<any>('user/ranger@x.org', env)), passwordHash: 'secret-hash' }, env);
    const users = await call(adminRouter, 'GET', '/api/admin/users', adminSession);
    expect(JSON.stringify(users.body)).not.toContain('secret-hash');
    const people = await call(adminRouter, 'GET', '/api/admin/people', adminSession);
    expect(people.body.people.map((p: any) => p.email)).toEqual(['boss@x.org', 'cm@x.org', 'ranger@x.org']);
    expect(JSON.stringify(people.body)).not.toContain('secret-hash');
  });
});
