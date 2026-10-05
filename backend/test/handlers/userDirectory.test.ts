import { router } from '../../src/handlers/user';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { Env, CreateSession } from '../../src/utils/sessionManager';
import { saveUser } from '../../src/services/userService';
import { clearMemoryCache } from '../../src/services/cacheService';
import { User, UserType } from '../../src/types';

const alice: User = {
  id: 'alice-id', email: 'alice@example.com', name: 'Alice', userType: UserType.Admin,
  approved: true, isAdmin: true, groups: [], roles: ['Admin'],
};
const pending: User = {
  id: 'pending-id', email: 'pending@example.com', name: 'Pending Person', userType: UserType.Public,
  approved: false, isAdmin: false, groups: [], roles: [],
  passwordHash: 'secret-hash',
} as User & { passwordHash: string };

describe('GET /api/user/directory', () => {
  let env: Env;
  let session: string;

  beforeEach(async () => {
    clearMemoryCache();
    env = { STORE: new MemoryObjectStore() } as unknown as Env;
    for (const user of [alice, pending]) await saveUser(user, env);
    session = await CreateSession(alice.email, { email: alice.email, name: alice.name }, env);
  });

  it('lists every user (including unapproved) as id, name and email only', async () => {
    const response = await router.fetch(
      new Request('http://localhost/api/user/directory', { headers: { Authorization: `Bearer ${session}` } }),
      env
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: Array<Record<string, unknown>> };
    const byId = Object.fromEntries(body.users.map((u) => [u.id, u]));
    expect(byId['alice-id']).toEqual({ id: 'alice-id', name: 'Alice', email: 'alice@example.com' });
    expect(byId['pending-id']).toEqual({ id: 'pending-id', name: 'Pending Person', email: 'pending@example.com' });
    expect(JSON.stringify(body)).not.toContain('secret-hash');
  });

  it('requires a session', async () => {
    const response = await router.fetch(new Request('http://localhost/api/user/directory'), env);
    expect(response.status).toBe(401);
  });
});
