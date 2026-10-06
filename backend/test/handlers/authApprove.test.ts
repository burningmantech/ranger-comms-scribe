import { router } from '../../src/handlers/auth';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { Env, CreateSession } from '../../src/utils/sessionManager';
import { saveUser, getUser } from '../../src/services/userService';
import { clearMemoryCache } from '../../src/services/cacheService';
import { User, UserType } from '../../src/types';

const admin: User = {
  id: 'admin-id', email: 'admin@example.com', name: 'Admin', userType: UserType.Admin,
  approved: true, isAdmin: true, groups: [], roles: ['Admin'],
};
const member: User = {
  id: 'member-id', email: 'member@example.com', name: 'Member', userType: UserType.Member,
  approved: true, isAdmin: false, groups: [], roles: [],
};
const pending: User = {
  id: 'pending-id', email: 'pending@example.com', name: 'Pending', userType: UserType.Public,
  approved: false, isAdmin: false, groups: [], roles: [],
};

describe('POST /api/auth/approve', () => {
  let env: Env;

  beforeEach(async () => {
    clearMemoryCache();
    env = { STORE: new MemoryObjectStore() } as unknown as Env;
    for (const user of [admin, member, pending]) await saveUser(user, env);
  });

  const approve = (session?: string) =>
    router.fetch(
      new Request('http://localhost/api/auth/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session}` } : {}) },
        body: JSON.stringify({ userId: pending.email }),
      }),
      env
    );

  it('rejects a request with no session and leaves the user unapproved', async () => {
    const response = await approve();
    expect(response.status).toBe(400);
    expect((await getUser(pending.email, env))?.approved).toBe(false);
  });

  it('rejects a non-admin session', async () => {
    const session = await CreateSession(member.email, { email: member.email, name: member.name }, env);
    const response = await approve(session);
    expect(response.status).toBe(403);
    expect((await getUser(pending.email, env))?.approved).toBe(false);
  });

  it('lets an admin approve a user', async () => {
    const session = await CreateSession(admin.email, { email: admin.email, name: admin.name }, env);
    const response = await approve(session);
    expect(response.status).toBe(200);
    expect((await getUser(pending.email, env))?.approved).toBe(true);
  });
});
