import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { clearMemoryCache, getObject } from '../../src/services/cacheService';
import { migrateNotificationsByEmail, MIGRATION_KEY } from '../../src/migrations/notificationsByEmail';

/** The one-time move of notifications stored under a user id onto the person's email. */

let env: any;

async function put(key: string, value: unknown) {
  await env.STORE.put(key, JSON.stringify(value));
}

const notification = (id: string, userId: string) => ({ id, userId, type: 'submission_waiting', title: 'T', message: 'M', read: false, createdAt: '2026-10-06T00:00:00Z' });

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  clearMemoryCache();
  env = { STORE: new MemoryObjectStore() };
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('notifications by email migration', () => {
  it('moves notifications keyed by user id to the lowercased email', async () => {
    await put('user/sam@x.org', { id: 'id-sam', email: 'Sam@x.org', name: 'Sam' });
    await put('notifications/id-sam/n1', notification('n1', 'id-sam'));
    await put('notifications/id-sam/n2', notification('n2', 'id-sam'));

    const result = await migrateNotificationsByEmail(env);

    expect(result).toEqual({ moved: 2, unresolved: [] });
    expect(await getObject<any>('notifications/sam@x.org/n1', env)).toMatchObject({ id: 'n1', userId: 'sam@x.org', title: 'T' });
    expect(await getObject<any>('notifications/sam@x.org/n2', env)).toMatchObject({ userId: 'sam@x.org' });
    expect(await env.STORE.get('notifications/id-sam/n1')).toBeNull();
    expect(await env.STORE.get('notifications/id-sam/n2')).toBeNull();
  });

  it('leaves notifications already under an email alone', async () => {
    await put('user/sam@x.org', { id: 'id-sam', email: 'sam@x.org' });
    await put('notifications/sam@x.org/n1', notification('n1', 'sam@x.org'));

    expect(await migrateNotificationsByEmail(env)).toEqual({ moved: 0, unresolved: [] });
    expect(await getObject<any>('notifications/sam@x.org/n1', env)).toMatchObject({ userId: 'sam@x.org' });
  });

  it('moves a notification under a mixed-case email to the lowercased one', async () => {
    await put('notifications/Sam@X.org/n1', notification('n1', 'Sam@X.org'));

    await migrateNotificationsByEmail(env);

    expect(await getObject<any>('notifications/sam@x.org/n1', env)).toMatchObject({ userId: 'sam@x.org' });
    expect(await env.STORE.get('notifications/Sam@X.org/n1')).toBeNull();
  });

  it('leaves notifications of unknown users where they are, and says so', async () => {
    await put('notifications/gone-id/n1', notification('n1', 'gone-id'));

    const result = await migrateNotificationsByEmail(env);

    expect(result).toEqual({ moved: 0, unresolved: ['notifications/gone-id/n1'] });
    expect(await getObject<any>('notifications/gone-id/n1', env)).toMatchObject({ userId: 'gone-id' });
    expect(console.warn).toHaveBeenCalled();
  });

  it('runs once', async () => {
    await put('user/sam@x.org', { id: 'id-sam', email: 'sam@x.org' });
    await migrateNotificationsByEmail(env);
    expect(await env.STORE.get(MIGRATION_KEY)).not.toBeNull();

    await put('notifications/id-sam/late', notification('late', 'id-sam'));
    expect(await migrateNotificationsByEmail(env)).toBeNull();
    expect(await env.STORE.get('notifications/id-sam/late')).not.toBeNull();
  });
});
