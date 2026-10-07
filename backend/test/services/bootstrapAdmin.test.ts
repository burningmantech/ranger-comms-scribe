jest.mock('../../src/utils/turnstile', () => ({ verifyTurnstileToken: jest.fn(async () => true) }));
jest.mock('../../src/utils/googleToken', () => ({ verifyGoogleIdToken: jest.fn() }));

import { router as authRouter } from '../../src/handlers/auth';
import {
  applyBootstrapAdmin,
  getOrCreateUser,
  getUser,
  initializeFirstAdmin,
  isBootstrapAdminEmail,
  markUserAsVerified,
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
  expect(user).toMatchObject({ userType: UserType.Admin, isAdmin: true, verified: true });
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

  it('promotes and persists a listed, verified user, leaves others alone', async () => {
    const boss = { ...(await getOrCreateUser({ name: 'Boss', email: 'boss@example.com' }, env)), verified: true };
    expect(boss.userType).toBe(UserType.Member);

    const promoted = await applyBootstrapAdmin(boss, env);
    expectAdmin(promoted);
    expect(promoted.roles).toEqual(['Admin']);

    clearMemoryCache();
    expectAdmin(await getUser('boss@example.com', env));

    const other = await getOrCreateUser({ name: 'Other', email: 'other@example.com' }, env);
    expect(await applyBootstrapAdmin(other, env)).toBe(other);
    expect((await getUser('other@example.com', env))!.isAdmin).toBe(false);
  });

  it('does not promote a listed user who has not proven the address', async () => {
    const boss = await getOrCreateUser({ name: 'Boss', email: 'boss@example.com' }, env);
    expect(await applyBootstrapAdmin(boss, env)).toBe(boss);
    expect((await getUser('boss@example.com', env))!.isAdmin).toBe(false);
  });

  it('does not rewrite an already-promoted user', async () => {
    const created = await getOrCreateUser({ name: 'Boss', email: 'boss@example.com' }, env);
    const boss = await applyBootstrapAdmin({ ...created, verified: true }, env);
    const putSpy = jest.spyOn(env.STORE, 'put');
    expect(await applyBootstrapAdmin(boss, env)).toBe(boss);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('promotes existing verified listed users at boot without creating missing ones', async () => {
    await saveUser({
      id: 'u1', email: 'boss@example.com', name: 'Boss', userType: UserType.Public,
      approved: false, isAdmin: false, verified: true, groups: [], roles: ['Public'],
    }, { ...env });
    await saveUser({
      id: 'u2', email: 'squatter@example.com', name: 'Squatter', userType: UserType.Public,
      approved: false, isAdmin: false, groups: [], roles: ['Public'], passwordHash: 'x',
    }, { ...env });
    env.BOOTSTRAP_ADMIN_EMAILS = ['boss@example.com', 'ghost@example.com', 'squatter@example.com'];

    await initializeFirstAdmin(env);

    expectAdmin(await getUser('boss@example.com', env));
    expect(await getUser('ghost@example.com', env)).toBeNull();
    // An unverified record (e.g. someone registered the address first) is not promoted
    expect((await getUser('squatter@example.com', env))!.isAdmin).toBe(false);
  });

  it('does not promote on register (address unproven); promotes once the email is verified', async () => {
    const res = await authRouter.fetch(post('/register', {
      name: 'Boss', email: 'boss@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ isAdmin: false, verified: false });
    const session = await GetSession(body.sessionId, env);
    expect(session!.data).toMatchObject({ isAdmin: false, userType: UserType.Member });

    // A password login before verification doesn't promote either
    const early = await authRouter.fetch(post('/login', {
      email: 'boss@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    expect((await early.json() as any).isAdmin).toBe(false);

    // Verify with the token that was emailed (read it from the store)
    const tokens = await env.STORE.list('verification-token/');
    expect(tokens.objects).toHaveLength(1);
    const token = tokens.objects[0].key.slice('verification-token/'.length);
    const verify = await authRouter.fetch(post('/verify-email', { token }), env);
    expect(verify.status).toBe(200);
    expectAdmin(await getUser('boss@example.com', env));

    // The link proved the mailbox, not who chose the password (the registrant may not
    // be the owner): the password and the registrant's session are gone.
    expect((await getUser('boss@example.com', env))!.passwordHash).toBeUndefined();
    expect(await GetSession(body.sessionId, env)).toBeNull();
    const after = await authRouter.fetch(post('/login', {
      email: 'boss@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    expect(after.status).toBe(401);
  });

  it('does not promote a mixed-case registration of a listed address', async () => {
    const res = await authRouter.fetch(post('/register', {
      name: 'Attacker', email: 'BOSS@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ isAdmin: false, verified: false });
    expect((await getUser('BOSS@example.com', env))!.isAdmin).toBe(false);
  });

  it('Google sign-in over a squatted registration drops the unproven password', async () => {
    // Attacker registers the owner's address with their own password (unverified)
    const reg = await authRouter.fetch(post('/register', {
      name: 'Attacker', email: 'boss@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    const attackerSession = (await reg.json() as any).sessionId;
    expect(await GetSession(attackerSession, env)).not.toBeNull();

    // The real owner signs in with Google: verified and promoted
    (verifyGoogleIdToken as jest.Mock).mockResolvedValue({ email: 'boss@example.com', name: 'Boss', sub: '1' });
    const google = await authRouter.fetch(post('/loginGoogleToken', { token: 'google-token' }), env);
    const googleBody = await google.json() as any;
    expect(googleBody).toMatchObject({ isAdmin: true });
    expectAdmin(await getUser('boss@example.com', env));
    expect((await getUser('boss@example.com', env))!.passwordHash).toBeUndefined();
    // The attacker's session (which would resolve to the promoted record) is gone
    expect(await GetSession(attackerSession, env)).toBeNull();
    // The owner's new Google session works
    expect(await GetSession(googleBody.sessionId, env)).not.toBeNull();

    // The attacker's password no longer works
    const login = await authRouter.fetch(post('/login', {
      email: 'boss@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    expect(login.status).toBe(401);
  });

  it('does not promote an unlisted user on register', async () => {
    const res = await authRouter.fetch(post('/register', {
      name: 'Pat', email: 'pat@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    const body = await res.json() as any;
    expect(body).toMatchObject({ isAdmin: false, verified: false });
  });

  it('refuses to register over an existing account (no session for password-less users)', async () => {
    await getOrCreateUser({ name: 'Google User', email: 'g@example.com' }, env);
    const res = await authRouter.fetch(post('/register', {
      name: 'Attacker', email: 'g@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    expect(res.status).toBe(409);
    expect((await res.json() as any).sessionId).toBeUndefined();
  });

  it('promotes a verified user on password login (user added to the list after registering)', async () => {
    env.BOOTSTRAP_ADMIN_EMAILS = [];
    await authRouter.fetch(post('/register', {
      name: 'Boss', email: 'boss@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    expect((await getUser('boss@example.com', env))!.isAdmin).toBe(false);
    await markUserAsVerified('boss@example.com', env);

    env.BOOTSTRAP_ADMIN_EMAILS = ['BOSS@example.com'.toLowerCase()];
    const res = await authRouter.fetch(post('/login', {
      email: 'boss@example.com', password: STRONG_PASSWORD, turnstileToken: 't',
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ isAdmin: true });
    expectAdmin(await getUser('boss@example.com', env));
  });

  it('promotes on Google token login', async () => {
    (verifyGoogleIdToken as jest.Mock).mockResolvedValue({ email: 'boss@example.com', name: 'Boss', sub: '1' });
    const res = await authRouter.fetch(post('/loginGoogleToken', { token: 'google-token' }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ isAdmin: true });
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
