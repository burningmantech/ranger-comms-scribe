import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  createTrackedChange,
  updateChangeStatus,
  undoChange,
  getTrackedChanges,
} from '../../src/services/trackedChangesService';
import { updateChangeStatusHandler, undoChangeHandler } from '../../src/handlers/trackedChanges';
import { clearMemoryCache, getObject, listObjects, putObject } from '../../src/services/cacheService';
import { CustomRequest } from '../../src/types';
import { createMockObjectStore, MockObjectStore } from '../helpers/mockObjectStore';

// The dev-site bug: a Moved card (deletion D + insertion I) rejected, undone, and rejected
// again ended with D rejected and I pending on the server. Both PUTs run at once; D's
// handler reads every change (cascade check, recompute) while I's handler writes I. With
// S3 latency, D's read of I (still pending) landed after I's write, and the copy it cached
// (in memory and, as a `change:` shadow, in the store) hid I's reject from then on.
// The first reject didn't hit it: the shadow from creation was a cache hit, with no write
// back; the undo deleted it.

const lexical = (text: string) => JSON.stringify({
  root: {
    type: 'root', version: 1, direction: null, format: '', indent: 0,
    children: [{
      type: 'paragraph', version: 1, direction: null, format: '', indent: 0,
      children: [{ type: 'text', version: 1, detail: 0, format: 0, mode: 'normal', style: '', text }],
    }],
  },
});

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

/**
 * Hold back the first store read of `key`: its value is read at call time (the state
 * before a concurrent write) but returned only when the test releases it, as a slow S3
 * GET would.
 */
function holdFirstRead(store: MockObjectStore, ...keys: string[]) {
  const gate = deferred();
  const held = new Set<string>();
  store.get.mockImplementation((k: string) => {
    const read = store.backing.get(k);
    if (keys.includes(k) && !held.has(k)) {
      held.add(k);
      return gate.promise.then(() => read);
    }
    return read;
  });
  return { release: gate.resolve, wasHit: (k = keys[0]) => held.has(k) };
}

let counter = 0;

async function setupMove() {
  const env: any = { STORE: createMockObjectStore() };
  const submissionId = `race-sub-${++counter}`;
  const original = 'Head. Moved text. Tail.';
  await putObject(`content_submissions/${submissionId}`, {
    id: submissionId, submittedBy: 'author', content: original, richTextContent: lexical(original),
  }, env);
  const cut = 'Head. Tail.';
  const pasted = 'Head. Tail. Moved text.';
  const d = await createTrackedChange(submissionId, 'content', original, cut, 'author', 'Author', env,
    lexical(original), lexical(cut), undefined, { diffAgainstOldValue: true });
  await tick();
  const i = await createTrackedChange(submissionId, 'content', cut, pasted, 'author', 'Author', env,
    lexical(cut), lexical(pasted), undefined, { diffAgainstOldValue: true });
  // Reject both, then undo both (the first two steps on the dev site).
  for (const id of [d.id, i.id]) await updateChangeStatus(submissionId, id, 'rejected', env, undefined, undefined, 'rev', 'Reviewer');
  await tick();
  for (const id of [d.id, i.id]) expect(await undoChange(submissionId, id, env)).not.toBeNull();
  return { env, submissionId, d: d.id, i: i.id };
}

const statusOf = async (env: any, submissionId: string, id: string) =>
  (await getTrackedChanges(submissionId, env)).find(c => c.id === id)?.status;

describe('tracked changes: a read racing a status write never caches the old status', () => {
  beforeEach(() => clearMemoryCache());

  it('a listing read before an insertion is rejected (after an undo) does not hide the reject', async () => {
    const { env, submissionId, i } = await setupMove();
    const iKey = `tracked-changes/submission/${submissionId}/${i}`;
    const store = env.STORE as MockObjectStore;

    // Warm process: the in-memory cache holds the undone change.
    const hold = holdFirstRead(store, iKey);
    const listing = getTrackedChanges(submissionId, env); // D's handler: cascade check
    await tick();
    await updateChangeStatus(submissionId, i, 'rejected', env, undefined, undefined, 'rev', 'Reviewer');
    hold.release();
    await listing;

    expect(await statusOf(env, submissionId, i)).toBe('rejected');
    clearMemoryCache(); // a restart, or the 1 h TTL running out: read from the store
    expect(await statusOf(env, submissionId, i)).toBe('rejected');
  });

  it('a cold read-through of the change itself does not cache the old status', async () => {
    const { env, submissionId, i } = await setupMove();
    const iKey = `tracked-changes/submission/${submissionId}/${i}`;
    const store = env.STORE as MockObjectStore;

    clearMemoryCache(); // a fresh process: every read goes to the store
    const hold = holdFirstRead(store, iKey);
    const listing = getTrackedChanges(submissionId, env);
    await tick();
    expect(hold.wasHit()).toBe(true);
    await updateChangeStatus(submissionId, i, 'rejected', env, undefined, undefined, 'rev', 'Reviewer');
    hold.release();
    await listing;

    expect(await statusOf(env, submissionId, i)).toBe('rejected');
    expect((await getObject<any>(iKey, env))?.status).toBe('rejected');
  });

  it('the move\'s two PUTs at once, after an undo: both end rejected', async () => {
    const { env, submissionId, d, i } = await setupMove();
    const iKey = `tracked-changes/submission/${submissionId}/${i}`;
    const store = env.STORE as MockObjectStore;
    const admin = { id: 'admin-user-id', name: 'Admin User', userType: 'Admin' };
    const req = (changeId: string): CustomRequest => ({
      params: { changeId }, user: admin, json: jest.fn().mockResolvedValue({ status: 'rejected', submissionId }),
    } as unknown as CustomRequest);

    // D's handler reads I slowly (S3); I's handler writes I meanwhile.
    clearMemoryCache();
    const hold = holdFirstRead(store, iKey);
    const putD = updateChangeStatusHandler(req(d), env);
    // Wait for D's handler to read I (cascade check), then run I's PUT to the end.
    for (let t = 0; t < 100 && !hold.wasHit(); t++) await tick(2);
    expect(hold.wasHit()).toBe(true);
    const putI = await updateChangeStatusHandler(req(i), env);
    expect(putI.status).toBe(200);
    hold.release();
    expect((await putD).status).toBe(200);

    const changes = await getTrackedChanges(submissionId, env);
    expect(changes.filter(c => c.id === d || c.id === i).map(c => c.status)).toEqual(['rejected', 'rejected']);
    clearMemoryCache();
    const fresh = await getTrackedChanges(submissionId, env);
    expect(fresh.filter(c => c.id === d || c.id === i).map(c => c.status)).toEqual(['rejected', 'rejected']);
  });

  it('a listing read racing a new change does not cache a listing without it', async () => {
    const env: any = { STORE: createMockObjectStore() };
    const store = env.STORE as MockObjectStore;
    const prefix = 'race-list/';
    await putObject(`${prefix}a`, { id: 'a' }, env);
    const gate = deferred();
    let held = false;
    store.list.mockImplementation((p: string) => {
      const listed = store.backing.list(p);
      if (!held) { held = true; return gate.promise.then(() => listed); }
      return listed;
    });
    const first = listObjects(prefix, env);
    await tick();
    await putObject(`${prefix}b`, { id: 'b' }, env);
    gate.resolve();
    await first;
    const keys = (await listObjects(prefix, env)).objects.map((o: any) => o.key);
    expect(keys).toEqual([`${prefix}a`, `${prefix}b`]);
  });

  it('undo through the handler, then reject: the server reports the reject', async () => {
    const { env, submissionId, i } = await setupMove();
    const admin = { id: 'admin-user-id', name: 'Admin User', userType: 'Admin' };
    await updateChangeStatus(submissionId, i, 'rejected', env, undefined, undefined, 'rev', 'Reviewer');
    const undo = await undoChangeHandler({
      params: { changeId: i }, user: admin, json: jest.fn().mockResolvedValue({ submissionId }),
    } as unknown as CustomRequest, env);
    expect(undo.status).toBe(200);
    expect(await statusOf(env, submissionId, i)).toBe('pending');
    await updateChangeStatus(submissionId, i, 'rejected', env, undefined, undefined, 'rev', 'Reviewer');
    expect(await statusOf(env, submissionId, i)).toBe('rejected');
  });
});
