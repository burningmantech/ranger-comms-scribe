import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { clearMemoryCache, getObject } from '../../src/services/cacheService';
import { planPeopleAccess, migratePeopleAccess, MIGRATION_KEY } from '../../src/migrations/peopleAccess';
import { accessOf } from '../../src/services/access';

/** The one-time move of everyone's access onto their record, on the messy shapes real data has. */

let env: any;

async function put(key: string, value: unknown) {
  await env.STORE.put(key, JSON.stringify(value));
}

function user(email: string, extra: Record<string, unknown> = {}) {
  return { id: `id-${email.split('@')[0]}`, email, name: email.split('@')[0], approved: true, verified: true, groups: [], roles: [], userType: 'Member', isAdmin: false, ...extra };
}

const after = async (email: string) => accessOf(await getObject<any>(`user/${email}`, env));

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  clearMemoryCache();
  env = { STORE: new MemoryObjectStore() };
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('people access migration', () => {
  it('takes admin, cadre and council from every old place', async () => {
    await put('user/admin@x.org', user('admin@x.org', { userType: 'Admin', isAdmin: true, roles: ['Admin'] }));
    // isAdmin was cleared when a cadre role was added, but the type still says Admin
    await put('user/demoted@x.org', user('demoted@x.org', { userType: 'Admin', isAdmin: false }));
    await put('user/typecadre@x.org', user('typecadre@x.org', { userType: 'CommsCadre', roles: ['CommsCadre'] }));
    // Only on the cadre list (listed twice), by a differently-cased email
    await put('user/listcadre@x.org', user('listcadre@x.org'));
    await put('comms_cadre:active', [
      { id: 'c1', email: 'ListCadre@x.org', active: true },
      { id: 'c2', email: 'listcadre@x.org', active: true },
      { id: 'c3', email: 'gone@x.org', active: true },
      { id: 'c4', email: 'typecadre@x.org', active: false },
    ]);
    // Council by role list (no userId on the entry) and by a legacy record
    await put('user/cm@x.org', user('cm@x.org', { userType: 'CommsCadre', roles: ['CommsCadre', 'CouncilManager'] }));
    await put('council_members:role:CommunicationsManager', [{ id: 'm1', email: 'cm@x.org', role: 'CommunicationsManager', active: true }]);
    await put('user/intake@x.org', user('intake@x.org', { userType: 'CouncilManager', roles: ['CouncilManager'] }));
    await put('council_member/l1', { id: 'l1', email: 'intake@x.org', role: 'IntakeManager', active: true });
    await put('council_member/l2', { id: 'l2', email: 'intake@x.org', role: 'LogisticsManager', active: false });
    // Org chart: only a per-person record, still a council manager by type
    await put('user/orgchart@x.org', user('orgchart@x.org', { userType: 'CouncilManager', roles: ['CouncilManager'] }));
    await put('council_members:id-orgchart:OperationsManager', { userId: 'id-orgchart', role: 'OperationsManager', active: true });
    // A stale per-person record for someone who was removed (no longer council by type or role)
    await put('user/removed@x.org', user('removed@x.org', { userType: 'CommsCadre', roles: ['CommsCadre'] }));
    await put('council_members:id-removed:CommunicationsManager', { userId: 'id-removed', role: 'CommunicationsManager', active: true });
    // A council manager by type with no role recorded anywhere
    await put('user/lost@x.org', user('lost@x.org', { userType: 'CouncilManager', roles: ['CouncilManager'] }));
    // Lead and an unapproved Public user
    await put('user/lead@x.org', user('lead@x.org', { userType: 'Lead' }));
    await put('user/new@x.org', user('new@x.org', { userType: 'Public', approved: false, roles: ['Public'] }));

    const plan = await migratePeopleAccess(env);
    expect(plan).not.toBeNull();

    expect(await after('admin@x.org')).toMatchObject({ isAdmin: true, commsCadre: false, council: false });
    expect(await after('demoted@x.org')).toMatchObject({ isAdmin: true });
    expect(await after('typecadre@x.org')).toMatchObject({ commsCadre: true, council: false });
    expect(await after('listcadre@x.org')).toMatchObject({ commsCadre: true });
    expect(await after('cm@x.org')).toMatchObject({ commsCadre: true, councilRoles: ['CommunicationsManager'] });
    expect(await after('intake@x.org')).toMatchObject({ councilRoles: ['IntakeManager'] });
    expect(await after('orgchart@x.org')).toMatchObject({ councilRoles: ['OperationsManager'] });
    expect(await after('removed@x.org')).toMatchObject({ commsCadre: true, council: false, councilRoles: [] });
    expect(await after('lost@x.org')).toMatchObject({ council: false });
    expect(await after('lead@x.org')).toMatchObject({ approved: true, isAdmin: false, commsCadre: false, council: false });
    expect(await after('new@x.org')).toMatchObject({ approved: false });

    // The derived legacy fields
    const cm = await getObject<any>('user/cm@x.org', env);
    expect(cm.userType).toBe('CouncilManager');
    expect(cm.roles).toEqual(['CommsCadre', 'CouncilManager']);
    expect((await getObject<any>('user/lead@x.org', env)).userType).toBe('Member');
    expect((await getObject<any>('user/new@x.org', env)).userType).toBe('Public');

    expect(plan!.anomalies).toEqual(expect.arrayContaining([
      'Comms Cadre list names gone@x.org, who has no account: ignored',
      'removed@x.org: an old CommunicationsManager per-person record, but no longer a council manager by type, role or list: not given CommunicationsManager',
      'lost@x.org: a council manager by type or role, but no council role is recorded anywhere: not on Council now (give them a role on the People page)',
    ]));
    expect(await getObject(MIGRATION_KEY, env)).toMatchObject({ migrated: 11 });
  });

  it('runs once, and leaves records that already hold access alone', async () => {
    await put('user/a@x.org', user('a@x.org', { userType: 'CommsCadre', roles: ['CommsCadre'] }));
    await put('user/b@x.org', user('b@x.org', { accessVersion: 1, commsCadre: false, councilRoles: ['IntakeManager'], userType: 'CouncilManager' }));
    expect((await planPeopleAccess(env)).alreadyMigrated).toBe(1);
    await migratePeopleAccess(env);
    expect(await after('b@x.org')).toMatchObject({ commsCadre: false, councilRoles: ['IntakeManager'] });
    // A later change to the old list does nothing: it ran already
    await put('comms_cadre:active', [{ email: 'b@x.org', active: true }]);
    expect(await migratePeopleAccess(env)).toBeNull();
    expect(await after('b@x.org')).toMatchObject({ commsCadre: false });
  });

  it('reports people whose only Admin / Comms Cadre came from a role group', async () => {
    await put('user/grp@x.org', user('grp@x.org'));
    await put('user/fine@x.org', user('fine@x.org', { userType: 'CommsCadre' }));
    await put('group/g1', { id: 'g1', name: 'CommsCadre', members: ['id-grp', 'fine@x.org'] });
    await put('group/g2', { id: 'g2', name: 'Hiking', members: ['id-grp'] });
    const plan = await migratePeopleAccess(env);
    expect(plan!.anomalies).toEqual([
      'grp@x.org: in the "CommsCadre" group (which only the old role list read), but not CommsCadre now: give them the role on the People page if they should have it',
    ]);
  });
});
