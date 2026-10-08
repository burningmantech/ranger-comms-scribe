import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  updateChangeStatusHandler,
  createTrackedChangeHandler,
  getTrackedChangesHandler,
  batchCreateHandler,
} from '../../src/handlers/trackedChanges';
import {
  compareChangeOrder,
  createTrackedChange,
  getCascadeDependencies,
  getLatestProposedVersion,
  TrackedChange,
} from '../../src/services/trackedChangesService';
import { CustomRequest } from '../../src/types';
import { clearMemoryCache, putObject } from '../../src/services/cacheService';
import { createMockObjectStore } from '../helpers/mockObjectStore';

/**
 * Tracked changes made in the same millisecond have the same `timestamp`. Which one is newer
 * must not depend on the store's listing order (keys are `.../<uuid>`, so it's random): the
 * change created later wins. The clock is frozen so every change gets the same timestamp,
 * and each case runs with ids that list oldest-first and newest-first.
 */

let mockIdCounter = 0;
let mockIdsDescending = false;
jest.mock('uuid', () => ({
  ...jest.requireActual('uuid'),
  v4: () => {
    mockIdCounter += 1;
    const n = mockIdsDescending ? 999999 - mockIdCounter : mockIdCounter;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  },
}));

const lexical = (text: string) => JSON.stringify({
  root: {
    type: 'root', version: 1, direction: null, format: '', indent: 0,
    children: [{
      type: 'paragraph', version: 1, direction: null, format: '', indent: 0,
      children: [{ type: 'text', version: 1, detail: 0, format: 0, mode: 'normal', style: '', text }],
    }],
  },
});

const admin = { id: 'dev-admin', email: 'dev@localhost', name: 'Dev Admin', userType: 'Admin' };

function handlerRequest(params: Record<string, string>, body: any): CustomRequest {
  return { params, user: admin, json: async () => body } as unknown as CustomRequest;
}

const listingOrders: Array<[string, boolean]> = [
  ['oldest listed first', false],
  ['newest listed first', true],
];

describe.each(listingOrders)('same-millisecond tracked changes (%s)', (_label, descending) => {
  let env: any;

  beforeEach(async () => {
    mockIdCounter = 0;
    mockIdsDescending = descending;
    // Freeze the clock (Date only; promises, ticks and timers stay real)
    jest.useFakeTimers({
      now: new Date('2026-10-07T12:00:00.000Z'),
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate',
        'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    clearMemoryCache();
    env = { STORE: createMockObjectStore(), DEV_BYPASS_AUTH: 'true' };
    const original = lexical('Original body');
    await putObject('content_submissions/sub-1', {
      id: 'sub-1', status: 'in_review', title: 'Old subject', content: original, richTextContent: original,
      submittedBy: 'someone-else', formFields: [], comments: [], approvals: [],
    }, env);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function create(body: Record<string, unknown>): Promise<TrackedChange> {
    const response = await createTrackedChangeHandler(handlerRequest({ submissionId: 'sub-1' }, body), env);
    expect(response.status).toBe(200);
    return (await response.json()) as TrackedChange;
  }

  async function proposed(): Promise<any> {
    clearMemoryCache();
    const response = await getTrackedChangesHandler(handlerRequest({ submissionId: 'sub-1' }, {}), env);
    return ((await response.json()) as any).proposedVersions;
  }

  it('gives the changes the same timestamp (the setup this suite relies on)', async () => {
    const a = await create({ field: 'title', oldValue: 'Old subject', newValue: 'A' });
    const b = await create({ field: 'title', oldValue: 'Old subject', newValue: 'B' });
    expect(a.timestamp).toBe(b.timestamp);
  });

  it('the proposed Subject is the later change, before and after a reject', async () => {
    const accepted = await create({ field: 'title', oldValue: 'Old subject', newValue: 'New subject' });
    await updateChangeStatusHandler(handlerRequest({ changeId: accepted.id }, { status: 'approved', submissionId: 'sub-1' }), env);
    const rejected = await create({ field: 'title', oldValue: 'Old subject', newValue: 'Rejected subject' });
    expect((await proposed()).title).toBe('Rejected subject');

    await updateChangeStatusHandler(handlerRequest({ changeId: rejected.id }, { status: 'rejected', submissionId: 'sub-1' }), env);
    expect((await proposed()).title).toBe('New subject');
  });

  it('a batch keeps its order: the last change to a field is the proposed value', async () => {
    const response = await batchCreateHandler(handlerRequest({ submissionId: 'sub-1' }, {
      changes: [
        { field: 'title', oldValue: 'Old subject', newValue: 'First' },
        { field: 'title', oldValue: 'First', newValue: 'Second' },
      ],
    }), env);
    expect(response.status).toBe(200);
    expect((await proposed()).title).toBe('Second');
  });

  it('the proposed document is the later change\'s snapshot', async () => {
    await create({
      field: 'content', oldValue: 'Original body', newValue: 'First edit',
      richTextOldValue: lexical('Original body'), richTextNewValue: lexical('First edit'),
    });
    await create({
      field: 'content', oldValue: 'First edit', newValue: 'Second edit',
      richTextOldValue: lexical('First edit'), richTextNewValue: lexical('Second edit'),
    });
    expect((await proposed()).content).toBe('Second edit');
    clearMemoryCache();
    expect(await getLatestProposedVersion('sub-1', 'content', env)).toBe('Second edit');
  });

  it('a later change that builds on another is in its reject cascade', async () => {
    const first = await createTrackedChange('sub-1', 'content', 'alpha beta', 'alpha gamma', 'u', 'U', env, undefined, undefined,
      { field: 'content', ranges: [{ start: 6, end: 11 }] });
    const second = await createTrackedChange('sub-1', 'content', 'alpha gamma', 'alpha gamma delta', 'u', 'U', env, undefined, undefined,
      { field: 'content', ranges: [{ start: 6, end: 17 }] });
    expect(first.timestamp).toBe(second.timestamp);
    clearMemoryCache();
    expect(await getCascadeDependencies('sub-1', first.id, env)).toEqual([second.id]);
    expect(await getCascadeDependencies('sub-1', second.id, env)).toEqual([]);
  });
});

describe('compareChangeOrder', () => {
  const change = (id: string, timestamp: string, seq?: number) => ({ id, timestamp, seq } as TrackedChange);

  it('orders by timestamp, then by creation sequence', () => {
    const changes = [
      change('c', '2026-10-07T12:00:00.001Z', 3),
      change('b', '2026-10-07T12:00:00.000Z', 2),
      change('a', '2026-10-07T12:00:00.000Z', 1),
    ];
    expect([...changes].sort(compareChangeOrder).map(c => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps working for records saved before the sequence (no seq)', () => {
    const changes = [
      change('new', '2026-10-07T12:00:00.000Z', 1),
      change('old2', '2026-10-06T12:00:00.000Z'),
      change('old1', '2026-10-05T12:00:00.000Z'),
    ];
    expect([...changes].sort(compareChangeOrder).map(c => c.id)).toEqual(['old1', 'old2', 'new']);
    // Same millisecond: a record without a sequence counts as the older one
    expect(compareChangeOrder(change('x', '2026-10-07T12:00:00.000Z'), change('y', '2026-10-07T12:00:00.000Z', 5))).toBeLessThan(0);
    expect(compareChangeOrder(change('x', '2026-10-07T12:00:00.000Z'), change('y', '2026-10-07T12:00:00.000Z'))).toBe(0);
  });
});
