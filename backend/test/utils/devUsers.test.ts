import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { router } from '../../src/index';
import { withAuth } from '../../src/authWrappers';
import { authorizeRoomConnection } from '../../src/handlers/websocket';
import { loadConfig } from '../../src/config/env';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { clearMemoryCache } from '../../src/services/cacheService';
import { devUserKey, getDevUser } from '../../src/utils/devUsers';

/**
 * The local-only auth bypass (DEV_BYPASS_AUTH=true) has three fake users: dev-admin (the
 * default), dev-user2 (CommsCadre) and dev-member (Member). Every place that answers for
 * them must pick the same one.
 */

const BASE_ENV = {
  PUBLIC_URL: 'http://localhost/api',
  FRONTEND_URL: 'http://localhost:3000',
  GOOGLE_CLIENT_ID: 'c',
  TURNSTILESECRET: 's',
  STORE_DRIVER: 'memory',
};

const MEMBER = {
  id: 'dev-member', email: 'member@localhost', name: 'Test Member', userType: 'Member',
  isAdmin: false, roles: ['Member'], groups: [],
  commsCadre: false, councilRole: null, accessVersion: 1,
};

function makeEnv(bypass: boolean) {
  return loadConfig({ ...BASE_ENV, ...(bypass ? { DEV_BYPASS_AUTH: 'true' } : {}) }, { store: new MemoryObjectStore() }).env;
}

function get(path: string, env: any, headers: Record<string, string> = {}) {
  return router.fetch(new Request(`http://localhost${path}`, { headers }), env);
}

describe('dev bypass users', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    clearMemoryCache();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('selection', () => {
    it.each([
      ['dev-member-session', null, 'member'],
      ['dev-user2-session', null, 'user2'],
      ['dev-council-session', null, 'council'],
      ['x', 'council', 'council'],
      ['dev-admin-session', null, 'admin'],
      ['whatever', null, 'admin'],
      ['', null, 'admin'],
      [null, null, 'admin'],
      ['x', 'member', 'member'],
      ['x', 'user2', 'user2'],
      ['dev-user2-session', 'member', 'member'],
      ['x', 'someone-else', 'admin'],
    ])('session %p, hint %p -> %s', (sessionId, hint, key) => {
      expect(devUserKey(sessionId, hint)).toBe(key);
    });

    it('returns the member user', () => {
      expect(getDevUser('dev-member-session')).toEqual(MEMBER);
    });

    it('returns copies, so a caller cannot change the shared definition', () => {
      getDevUser('dev-member-session').roles.push('Admin');
      expect(getDevUser('dev-member-session').roles).toEqual(['Member']);
    });
  });

  describe('REST with DEV_BYPASS_AUTH=true', () => {
    const env = () => makeEnv(true);

    it('GET /api/auth/me returns the member for a dev-member session', async () => {
      const res = await get('/api/auth/me', env(), { Authorization: 'Bearer dev-member-session' });
      expect(res.status).toBe(200);
      expect((await res.json()).user).toEqual(MEMBER);
    });

    it('GET /api/auth/me returns the member for X-Dev-User: member', async () => {
      const res = await get('/api/auth/me', env(), { 'X-Dev-User': 'member' });
      expect((await res.json()).user).toEqual(MEMBER);
    });

    it('GET /api/auth/me still returns the other dev users', async () => {
      const e = env();
      const user2 = (await (await get('/api/auth/me', e, { Authorization: 'Bearer dev-user2-session' })).json()).user;
      expect(user2).toMatchObject({ id: 'dev-user2', email: 'user2@localhost', userType: 'CommsCadre', isAdmin: false });
      const admin = (await (await get('/api/auth/me', e, { Authorization: 'Bearer dev-admin-session' })).json()).user;
      expect(admin).toMatchObject({ id: 'dev-admin', email: 'dev@localhost', userType: 'Admin', isAdmin: true });
    });

    it('GET /api/auth/session returns the member session', async () => {
      const res = await get('/api/auth/session', env(), { Authorization: 'Bearer dev-member-session' });
      expect(res.status).toBe(200);
      expect((await res.json()).session).toEqual({ userId: 'dev-member', email: 'member@localhost', name: 'Test Member' });
    });

    it('GET /api/admin/user-roles gives the member no roles and no permissions', async () => {
      const res = await get('/api/admin/user-roles', env(), { Authorization: 'Bearer dev-member-session' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.roles).toEqual([]);
      expect(Object.values(body.permissions).every((v) => v === false)).toBe(true);
    });

    it('GET /api/admin/user-roles gives the admin Admin and user2 Comms Cadre, both with review rights', async () => {
      const e = env();
      for (const [session, roles] of [['dev-admin-session', ['Admin']], ['dev-user2-session', ['CommsCadre']]] as const) {
        const body = await (await get('/api/admin/user-roles', e, { Authorization: `Bearer ${session}` })).json();
        expect(body.roles).toEqual(roles);
        expect(body.permissions.canApprove).toBe(true);
      }
    });

    it('withAuth sets the member as the request user', async () => {
      const request = new Request('http://localhost/x', { headers: { Authorization: 'Bearer dev-member-session' } });
      expect(await withAuth(request, env())).toBeUndefined();
      expect((request as any).user).toEqual(MEMBER);
    });
  });

  describe('REST without DEV_BYPASS_AUTH', () => {
    it('a dev-member session is not signed in', async () => {
      const env = makeEnv(false);
      expect((await get('/api/auth/me', env, { Authorization: 'Bearer dev-member-session' })).status).toBe(401);
      expect((await get('/api/auth/me', env, { 'X-Dev-User': 'member' })).status).toBe(401);
      expect((await get('/api/auth/session', env, { Authorization: 'Bearer dev-member-session' })).status).toBe(404);
      expect((await get('/api/admin/user-roles', env, { Authorization: 'Bearer dev-member-session' })).status).toBe(403);
      const request = new Request('http://localhost/x', { headers: { Authorization: 'Bearer dev-member-session' } });
      const res = await withAuth(request, env);
      expect(res?.status).toBe(401);
      expect((request as any).user).toBeUndefined();
    });
  });

  describe('WebSocket rooms', () => {
    it.each([
      [{ sessionId: 'dev-member-session' }],
      [{ sessionId: 'x', testUser: 'member' }],
    ])('authorizes the member (%p) with DEV_BYPASS_AUTH=true', async (params) => {
      const result = await authorizeRoomConnection({ kind: 'submission', id: 'any' }, params, makeEnv(true));
      expect(result).toEqual({ ok: true, identity: { userId: 'dev-member', userName: 'Test Member', userEmail: 'member@localhost' } });
    });

    it('rejects a dev-member session without DEV_BYPASS_AUTH', async () => {
      const result = await authorizeRoomConnection({ kind: 'submission', id: 'any' }, { sessionId: 'dev-member-session' }, makeEnv(false));
      expect(result).toMatchObject({ ok: false, status: 403 });
    });
  });
});
