jest.mock('../../src/utils/turnstile', () => ({ verifyTurnstileToken: jest.fn(async () => true) }));
jest.mock('../../src/utils/googleToken', () => ({ verifyGoogleIdToken: jest.fn() }));

import { router as authRouter } from '../../src/handlers/auth';
import {
  applyBootstrapAdmin,
  getOrCreateUser,
  getUser,
  initializeFirstAdmin,
  isBootstrapAdminEmail,
  saveUser,
} from '../../src/services/userService';
import { clearMemoryCache } from '../../src/services/cacheService';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { Env, GetSession } from '../../src/utils/sessionManager';
import { verifyGoogleIdToken } from '../../src/utils/googleToken';
import { User, UserType } from '../../src/types';

const STRONG_PASSWORD = 'Correct-Horse-Battery-9!';

function makeEnv(bootstrap: string[] = ['boss@example.com']): Env {
  return {
    STORE: new MemoryObjectStore(),
    BOOTSTRAP_ADMIN_EMAILS: bootstrap,
    GOOGLE_CLIENT_ID: 'client',
    TURNSTILESECRET: 'secret',
    FRONTEND_URL: 'http://localhost:3000',
  };
}

const post = (path: string, body: unknown) =>
  new Request(`http://localhost/api/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

function expectAdmin(user: User | null) {
  expect(user).toMatchObject({ userType: UserType.Admin, isAdmin: true, approved: true, verified: true });
  expect(user!.roles).toContain('Admin');
}

describe('first-admin bootstrap (BOOTSTRAP_ADMIN_EMAILS)', () => {
  let env: Env;

  beforeEach(() => {
    clearMemoryCache();
    env = makeEnv();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('matches emails case-insensitively', () => {
    expect(isBootstrapAdminEmail('Boss@Example.COM', env)).toBe(true);
    expect(isBootstrapAdminEmail(' boss@example.com ', env)).toBe(true);
    expect(isBootstrapAdminEmail('other@example.com', env)).toBe(false);
    expect(isBootstrapAdminEmail(undefined, env)).toBe(false);
    expect(isBootstrapAdminEmail('boss@example.com', { ...env, BOOTSTRAP_ADMIN_EMAILS: undefined })).toBe(false);
  });

  it('promotes and persists a listed user, leaves others alone', async () => {
    const boss = await getOrCreateUser({ name: 'Boss', email: 'boss@example.com' }, env);
    expect(boss.userType).toBe(UserType.Public);

    const promoted = await applyBootstrapAdmin(boss, env);
    expectAdmin(promoted);
    expect(promoted.roles).not.toContain('Public');

    clearMemoryCache();
    expectAdmin(await getUser('boss@example.com', env));

    const other = await getOrCreateUser({ name: 'Other', email: 'other@example.com' }, env);
    expect(await applyBootstrapAdmin(other, env)).toBe(other);
    expect((await getUser('other@example.com', env))!.isAdmin).toBe(false);
  });

  it('does not rewrite an already-promoted user', async () => {
    const boss = await applyBootstrapAdmin(await getOrCreateUser({ name: 'Boss', email: 'boss@example.com' }, env), env);
    const putSpy = jest.spyOn(env.STORE, 'put');
    expect(await applyBootstrapAdmin(boss, env)).toBe(boss);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('promotes existing listed users at boot without creating missing ones', async () => {
    await saveUser({
      id: 'u1', email: 'boss@example.com', name: 'Boss', userType: UserType.Public,
      approved: false, isAdmin: false, groups: [], roles: ['Public'],
    }, { ...env });
    env.BOOTSTRAP_ADMIN_EMAILS = ['boss@example.com', 'ghost@example.com'];

    await initializeFirstAdmin(env);

    expectAdmin(await getUser('boss@example.com', env));
    expect(await getUser('ghost@example.com', env)).toBeNull();
  });

  it('promotes on register, before the session is created', async () => {
    const res = await authRouter.fetch(post('/register', {
      name: 'Boss', email: 'boss@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ isAdmin: true, approved: true, verified: true });

    const session = await GetSession(body.sessionId, env);
    expect(session!.data).toMatchObject({ isAdmin: true, userType: UserType.Admin, approved: true, verified: true });
    expectAdmin(await getUser('boss@example.com', env));
  });

  it('does not promote an unlisted user on register', async () => {
    const res = await authRouter.fetch(post('/register', {
      name: 'Pat', email: 'pat@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    const body = await res.json() as any;
    expect(body).toMatchObject({ isAdmin: false, approved: false, verified: false });
  });

  it('refuses to register over an existing account (no session for password-less users)', async () => {
    await getOrCreateUser({ name: 'Google User', email: 'g@example.com' }, env);
    const res = await authRouter.fetch(post('/register', {
      name: 'Attacker', email: 'g@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    expect(res.status).toBe(409);
    expect((await res.json() as any).sessionId).toBeUndefined();
  });

  it('promotes on password login (user added to the list after registering)', async () => {
    env.BOOTSTRAP_ADMIN_EMAILS = [];
    await authRouter.fetch(post('/register', {
      name: 'Boss', email: 'boss@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    expect((await getUser('boss@example.com', env))!.isAdmin).toBe(false);

    env.BOOTSTRAP_ADMIN_EMAILS = ['BOSS@example.com'.toLowerCase()];
    const res = await authRouter.fetch(post('/login', {
      email: 'boss@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ isAdmin: true, approved: true });
    expectAdmin(await getUser('boss@example.com', env));
  });

  it('promotes on Google token login', async () => {
    (verifyGoogleIdToken as jest.Mock).mockResolvedValue({ email: 'boss@example.com', name: 'Boss', sub: '1' });
    const res = await authRouter.fetch(post('/loginGoogleToken', { token: 'google-token' }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ isAdmin: true, approved: true });
    const session = await GetSession(body.sessionId, env);
    expect(session!.data).toMatchObject({ isAdmin: true, userType: UserType.Admin });
    expectAdmin(await getUser('boss@example.com', env));
  });
});

describe('email failure does not leak tokens', () => {
  it('omits the debug token from forgot-password when SES fails outside dev mode', async () => {
    clearMemoryCache();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { SESv2Client } = await import('@aws-sdk/client-sesv2');
    jest.spyOn(SESv2Client.prototype, 'send').mockImplementation(async () => { throw new Error('sandbox'); });

    const env = makeEnv([]);
    await getOrCreateUser({ name: 'Pat', email: 'pat@example.com' }, env);

    const res = await authRouter.fetch(post('/forgot-password', { email: 'pat@example.com', turnstileToken: 't' }), env);
    const body = await res.json() as any;
    expect(body.debug).toBeUndefined();

    const devRes = await authRouter.fetch(
      post('/forgot-password', { email: 'pat@example.com', turnstileToken: 't' }),
      { ...env, DEV_BYPASS_AUTH: 'true' }
    );
    expect((await devRes.json() as any).debug).toMatch(/token/);
    jest.restoreAllMocks();
  });
});
