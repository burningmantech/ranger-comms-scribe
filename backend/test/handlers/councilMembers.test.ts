import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { router } from '../../src/handlers/councilMembers';
import { clearMemoryCache, getObject, putObject } from '../../src/services/cacheService';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';

/**
 * Removing someone's council role (Admin → Council) takes them off the role list and deletes
 * their per-user record from the store; it used to clear only the memory cache, so the stored
 * record stayed "active" and read as a council role after a restart.
 */
describe('council members: remove', () => {
  let env: any;
  const store = () => env.STORE as MemoryObjectStore;

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    clearMemoryCache();
    env = { STORE: new MemoryObjectStore(), DEV_BYPASS_AUTH: 'true' };
    const member = { id: 'm1', userId: 'u1', role: 'CommunicationsManager', email: 'cm@example.com', name: 'CM', active: true, createdAt: '', updatedAt: '' };
    await putObject('user/cm@example.com', { id: 'u1', email: 'cm@example.com', name: 'CM', userType: 'CouncilManager', roles: ['CommsCadre', 'CouncilManager'], groups: [], approved: true, isAdmin: false }, env);
    await putObject('council_member/m1', member, env);
    await putObject('council_members:role:CommunicationsManager', [member], env);
    await putObject('council_members:u1:CommunicationsManager', member, env);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deletes the stored per-user record and empties the role list', async () => {
    const res = await router.fetch(new Request('http://localhost/api/council/members/m1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer dev-admin-session' },
    }), env);
    expect(res.status).toBe(204);
    expect(await getObject('council_members:role:CommunicationsManager', env)).toEqual([]);
    clearMemoryCache();
    expect(await store().get('council_members:u1:CommunicationsManager')).toBeNull();
  });
});
