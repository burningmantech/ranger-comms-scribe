jest.mock('../../src/utils/turnstile', () => ({ verifyTurnstileToken: jest.fn(async () => true) }));
jest.mock('../../src/utils/googleToken', () => ({ verifyGoogleIdToken: jest.fn() }));

import { router as authRouter } from '../../src/handlers/auth';
import { getOrCreateUser, getUser, getUserStrict, saveUser, getAllGroups } from '../../src/services/userService';
import { clearMemoryCache, getObject, getObjectStrict, putObject } from '../../src/services/cacheService';
import { Env } from '../../src/utils/sessionManager';
import { verifyGoogleIdToken } from '../../src/utils/googleToken';
import { User, UserType } from '../../src/types';
import { createMockObjectStore, MockObjectStore } from '../helpers/mockObjectStore';

/**
 * A transient store error (S3 throttling, network) must never look like "this user
 * doesn't exist" on paths that create a user when none is found: they would
 * overwrite the real record (admin, groups, password) with a fresh Public user.
 */

const STRONG_PASSWORD = 'Correct-Horse-Battery-9!';

const admin: User = {
  id: 'admin-id', email: 'admin@example.com', name: 'Admin', userType: UserType.Admin,
  approved: true, isAdmin: true, verified: true, groups: ['g1'], roles: ['Admin'], passwordHash: 'hash',
};

const post = (path: string, body: unknown) =>
  new Request(`http://localhost/api/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

function userWrites(store: MockObjectStore): string[] {
  return store.put.mock.calls
    .map(([key]) => key)
    .filter((key) => key.startsWith('user/') || key.startsWith('user-by-id/'));
}

describe('strict reads on user create paths', () => {
  let store: MockObjectStore;
  let env: Env;

  beforeEach(async () => {
    store = createMockObjectStore();
    env = {
      STORE: store,
      GOOGLE_CLIENT_ID: 'client',
      TURNSTILESECRET: 'secret',
      FRONTEND_URL: 'http://localhost:3000',
    };
    await saveUser(admin, env);
    // Start cold so reads reach the (failing) store rather than the memory cache.
    clearMemoryCache();
    store.put.mockClear();
    store.get.mockRejectedValue(new Error('SlowDown: please reduce your request rate'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('cacheService', () => {
    it('getObjectStrict rethrows store errors; getObject still reports null', async () => {
      await expect(getObjectStrict('user/admin@example.com', env)).rejects.toThrow('SlowDown');
      await expect(getObject('user/admin@example.com', env)).resolves.toBeNull();
    });

    it('getObjectStrict returns null only for a missing object', async () => {
      store.get.mockImplementation((key: string) => store.backing.get(key));
      await expect(getObjectStrict('user/nobody@example.com', env)).resolves.toBeNull();
      await expect(getObjectStrict<User>('user/admin@example.com', env)).resolves.toMatchObject({ id: 'admin-id' });
    });

    it('getObjectStrict rethrows corrupt JSON instead of reporting it missing', async () => {
      store.get.mockImplementation((key: string) => store.backing.get(key));
      await store.backing.put('user/broken@example.com', '{not json');
      await expect(getObjectStrict('user/broken@example.com', env)).rejects.toThrow();
    });
  });

  it('getOrCreateUser throws and writes nothing when the store read fails', async () => {
    await expect(getOrCreateUser({ name: 'Admin', email: admin.email }, env)).rejects.toThrow('SlowDown');
    await expect(getUserStrict(admin.email, env)).rejects.toThrow('SlowDown');
    expect(userWrites(store)).toEqual([]);

    // The lenient lookup used by read paths still answers null rather than throwing.
    await expect(getUser(admin.email, env)).resolves.toBeNull();

    // The stored record is intact.
    store.get.mockImplementation((key: string) => store.backing.get(key));
    expect(await getUser(admin.email, env)).toMatchObject({ isAdmin: true, groups: ['g1'], passwordHash: 'hash' });
  });

  it('/register answers 500 and writes nothing when the existence check fails', async () => {
    const res = await authRouter.fetch(post('/register', {
      name: 'Squatter', email: admin.email, password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    expect(res.status).toBe(500);
    expect(userWrites(store)).toEqual([]);
  });

  it('/loginGoogleToken answers 500 (not 401) and writes nothing when the store read fails', async () => {
    (verifyGoogleIdToken as jest.Mock).mockResolvedValue({ email: admin.email, name: 'Admin', sub: '1' });
    const res = await authRouter.fetch(post('/loginGoogleToken', { token: 'google-token' }), env);
    expect(res.status).toBe(500);
    expect(userWrites(store)).toEqual([]);
  });

  it('/loginGoogleToken still answers 401 for a bad token', async () => {
    (verifyGoogleIdToken as jest.Mock).mockRejectedValue(new Error('Token audience mismatch'));
    const res = await authRouter.fetch(post('/loginGoogleToken', { token: 'bad' }), env);
    expect(res.status).toBe(401);
  });

  it('/loginGoogleToken still signs in an existing user when the store is healthy', async () => {
    store.get.mockImplementation((key: string) => store.backing.get(key));
    (verifyGoogleIdToken as jest.Mock).mockResolvedValue({ email: admin.email, name: 'Admin', sub: '1' });
    const res = await authRouter.fetch(post('/loginGoogleToken', { token: 'google-token' }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ isAdmin: true, userId: admin.email });
  });

  it('getAllGroups throws instead of skipping a group it failed to read', async () => {
    store.get.mockImplementation((key: string) => store.backing.get(key));
    await putObject('group/g1', { id: 'g1', name: 'CommsCadre', members: [] }, env);
    clearMemoryCache();
    store.get.mockRejectedValue(new Error('SlowDown'));

    await expect(getAllGroups(env)).rejects.toThrow('SlowDown');
  });
});
