import { describe, it, expect } from '@jest/globals';
import {
  createTrackedChangeHandler,
  updateChangeStatusHandler,
  getTrackedChangesHandler,
  batchCreateHandler,
  batchUpdateStatusHandler,
  undoChangeHandler,
} from '../../src/handlers/trackedChanges';
import { CustomRequest } from '../../src/types';
import { clearMemoryCache, getObject, putObject } from '../../src/services/cacheService';
import { createMockObjectStore } from '../helpers/mockObjectStore';

// The proposed_versions/<id> cache must never hide edits made after it was written:
// when the Yjs room is dropped, the editor reseeds from what GET returns.

const lexical = (text: string) => JSON.stringify({
  root: {
    type: 'root', version: 1, direction: null, format: '', indent: 0,
    children: [{
      type: 'paragraph', version: 1, direction: null, format: '', indent: 0,
      children: [{ type: 'text', version: 1, detail: 0, format: 0, mode: 'normal', style: '', text }],
    }],
  },
});

const admin = { id: 'admin-user-id', name: 'Admin User', userType: 'Admin' };
const member = { id: 'member-user-id', name: 'Member User', userType: 'Member' };

function request(params: Record<string, string>, user: any, body?: any): CustomRequest {
  return { params, user, json: jest.fn().mockResolvedValue(body || {}) } as unknown as CustomRequest;
}

// Timestamps order the changes, so keep each step in its own millisecond.
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

let counter = 0;

async function setup(original = 'Hello world') {
  const env: any = { STORE: createMockObjectStore() };
  const submissionId = `pv-sub-${++counter}`;
  await putObject(`content_submissions/${submissionId}`, {
    id: submissionId, submittedBy: 'author', content: original, richTextContent: lexical(original),
  }, env);
  return { env, submissionId };
}

/** A collaborative-mode save: old/new are the whole document just before and after the edit. */
async function createChange(env: any, submissionId: string, oldText: string, newText: string): Promise<string> {
  await tick();
  const response = await createTrackedChangeHandler(request({ submissionId }, member, {
    field: 'content',
    oldValue: oldText,
    newValue: newText,
    richTextOldValue: lexical(oldText),
    richTextNewValue: lexical(newText),
    diffAgainstOldValue: true,
  }), env);
  expect(response.status).toBe(200);
  return (await response.json()).id;
}

async function resolve(env: any, submissionId: string, changeId: string, status: 'approved' | 'rejected', revertedText?: string) {
  await tick();
  const response = await updateChangeStatusHandler(request({ changeId }, admin, {
    status, submissionId, ...(revertedText !== undefined ? { revertedRichText: lexical(revertedText) } : {}),
  }), env);
  expect(response.status).toBe(200);
  return response.json();
}

async function getProposed(env: any, submissionId: string) {
  // Read through the store, as a fresh process would after a restart
  clearMemoryCache();
  const response = await getTrackedChangesHandler(request({ submissionId }, member), env);
  expect(response.status).toBe(200);
  const body = await response.json();
  return {
    content: body.proposedVersions?.content as string | undefined,
    richText: body.proposedVersionsRichText?.content as string | undefined,
  };
}

/** Undo a decision, sending the editor's document after it (as the review sidebar does). */
async function undo(env: any, submissionId: string, changeId: string, docText?: string) {
  await tick();
  const response = await undoChangeHandler(request({ changeId }, admin, {
    submissionId, ...(docText !== undefined ? { proposedVersionsRichText: lexical(docText) } : {}),
  }), env);
  expect(response.status).toBe(200);
}

describe('proposed_versions cache', () => {
  it('includes a change made after a reject', async () => {
    const { env, submissionId } = await setup();
    const c1 = await createChange(env, submissionId, 'Hello world', 'Hello big world');
    await resolve(env, submissionId, c1, 'rejected', 'Hello world');
    expect(await env.STORE.backing.get(`proposed_versions/${submissionId}`)).not.toBeNull();
    await createChange(env, submissionId, 'Hello world', 'Hello world again');
    // Creating a change drops the cached copy
    expect(await env.STORE.backing.get(`proposed_versions/${submissionId}`)).toBeNull();

    const proposed = await getProposed(env, submissionId);

    expect(proposed.content).toBe('Hello world again');
    expect(proposed.richText).toBe(lexical('Hello world again'));
  });

  it('includes a change made after an accept', async () => {
    const { env, submissionId } = await setup();
    const c1 = await createChange(env, submissionId, 'Hello world', 'Hello big world');
    await resolve(env, submissionId, c1, 'approved', 'Hello big world');
    await createChange(env, submissionId, 'Hello big world', 'Hello big world again');

    const proposed = await getProposed(env, submissionId);

    expect(proposed.content).toBe('Hello big world again');
    expect(proposed.richText).toBe(lexical('Hello big world again'));
  });

  it('includes a change made after a batch accept', async () => {
    const { env, submissionId } = await setup();
    const c1 = await createChange(env, submissionId, 'Hello world', 'Hello big world');
    await tick();
    const batch = await batchUpdateStatusHandler(request({}, admin, {
      changeIds: [c1], status: 'approved', submissionId,
    }), env);
    expect(batch.status).toBe(200);
    await createChange(env, submissionId, 'Hello big world', 'Hello big world again');

    const proposed = await getProposed(env, submissionId);

    expect(proposed.richText).toBe(lexical('Hello big world again'));
  });

  it('includes changes recovered by a batch create', async () => {
    const { env, submissionId } = await setup();
    const c1 = await createChange(env, submissionId, 'Hello world', 'Hello big world');
    await resolve(env, submissionId, c1, 'approved', 'Hello big world');
    await tick();
    // Orphaned transactions (SaveIndicator): plain text only, whole document
    const response = await batchCreateHandler(request({ submissionId }, member, {
      changes: [{ field: 'content', oldValue: 'Hello big world', newValue: 'Hello big world again' }],
    }), env);
    expect(response.status).toBe(200);
    expect(await env.STORE.backing.get(`proposed_versions/${submissionId}`)).toBeNull();

    const proposed = await getProposed(env, submissionId);

    expect(proposed.content).toBe('Hello big world again');
    // No rich text in the change: the text is merged into the submission's Lexical structure
    expect(proposed.richText).toBe(lexical('Hello big world again'));
  });

  it('keeps a newer pending change when an older one is accepted', async () => {
    const { env, submissionId } = await setup();
    const c1 = await createChange(env, submissionId, 'Hello world', 'Hello big world');
    await createChange(env, submissionId, 'Hello big world', 'Hello big world again');
    // No editor state sent (an older client): the server must not fall back to c1's snapshot
    await resolve(env, submissionId, c1, 'approved');

    const proposed = await getProposed(env, submissionId);

    expect(proposed.content).toBe('Hello big world again');
    expect(proposed.richText).toBe(lexical('Hello big world again'));
  });

  it('keeps an older pending change when a newer one is accepted', async () => {
    const { env, submissionId } = await setup();
    await createChange(env, submissionId, 'Hello world', 'Hello big world');
    const c2 = await createChange(env, submissionId, 'Hello big world', 'Hello big world again');
    await resolve(env, submissionId, c2, 'approved');

    const proposed = await getProposed(env, submissionId);

    expect(proposed.content).toBe('Hello big world again');
    expect(proposed.richText).toBe(lexical('Hello big world again'));
  });

  it('does not apply a pending change twice after a reject and a later change', async () => {
    const { env, submissionId } = await setup();
    const c1 = await createChange(env, submissionId, 'Hello world', 'Hello big world');
    await createChange(env, submissionId, 'Hello big world', 'Hello big world again');
    await resolve(env, submissionId, c1, 'rejected', 'Hello world again');
    await createChange(env, submissionId, 'Hello world again', 'Hello world again now');

    const proposed = await getProposed(env, submissionId);

    expect(proposed.content).toBe('Hello world again now');
    expect(proposed.richText).toBe(lexical('Hello world again now'));
  });

  it('ignores a cached copy older than the newest change', async () => {
    const { env, submissionId } = await setup();
    await createChange(env, submissionId, 'Hello world', 'Hello big world');
    // A copy written before that change (e.g. by an older server that didn't invalidate)
    await putObject(`proposed_versions/${submissionId}`, {
      proposedVersionsContent: 'Hello world',
      proposedVersionsRichText: lexical('Hello world'),
      lastUpdatedAt: '2000-01-01T00:00:00.000Z',
    }, env);

    const proposed = await getProposed(env, submissionId);

    expect(proposed.richText).toBe(lexical('Hello big world'));
  });

  it('still serves a cached copy newer than every change', async () => {
    const { env, submissionId } = await setup();
    const c1 = await createChange(env, submissionId, 'Hello world', 'Hello big world');
    await resolve(env, submissionId, c1, 'rejected', 'Hello world');

    const proposed = await getProposed(env, submissionId);

    expect(proposed.richText).toBe(lexical('Hello world'));
  });

  it('recomputes the submission without changes rejected by cascade', async () => {
    const { env, submissionId } = await setup();
    await putObject(`original_content/${submissionId}`, { content: 'Hello world', richTextContent: lexical('Hello world') }, env);
    const change = (id: string, oldValue: string, newValue: string, at: string) => ({
      id, submissionId, field: 'content', oldValue, newValue, completeProposedVersion: newValue,
      isIncremental: true, richTextOldValue: lexical(oldValue), richTextNewValue: lexical(newValue),
      changedBy: 'author', changedByName: 'Author', timestamp: at, status: 'pending',
    });
    // c2 edits c1's text, so rejecting c1 cascades to c2
    await putObject(`tracked-changes/submission/${submissionId}/c1`,
      change('c1', 'Hello world', 'Hello big world', '2026-10-05T10:00:00Z'), env);
    await putObject(`tracked-changes/submission/${submissionId}/c2`,
      change('c2', 'Hello big world', 'Hello big bright world', '2026-10-05T10:00:05Z'), env);

    // The editor state sent with the reject predates the cascade (it still has c2's text)
    const result = await resolve(env, submissionId, 'c1', 'rejected', 'Hello bright world');

    expect(result.cascadeRejectedIds).toEqual(['c2']);
    clearMemoryCache();
    const submission = await getObject<any>(`content_submissions/${submissionId}`, env);
    expect(submission.content).toBe('Hello world');
    expect(submission.richTextContent).toBe(lexical('Hello world'));
    const proposed = await getObject<any>(`proposed_versions/${submissionId}`, env);
    expect(proposed.proposedVersionsRichText).toBe(lexical('Hello world'));
  });
  describe('after an undone reject', () => {
    it('keeps the re-applied text when a change is made after the undo', async () => {
      const { env, submissionId } = await setup();
      const c1 = await createChange(env, submissionId, 'Hello world', 'Hello big world');
      await resolve(env, submissionId, c1, 'rejected', 'Hello world');
      // The editor re-applies "big" and sends its document with the undo
      await undo(env, submissionId, c1, 'Hello big world');
      expect((await getProposed(env, submissionId)).richText).toBe(lexical('Hello big world'));

      await createChange(env, submissionId, 'Hello big world', 'Hello big world again');
      // The new change dropped the stored copy; GET recomputes from the changes
      expect(await env.STORE.backing.get(`proposed_versions/${submissionId}`)).toBeNull();

      const proposed = await getProposed(env, submissionId);
      expect(proposed.richText).toBe(lexical('Hello big world again'));
      expect(proposed.content).toBe('Hello big world again');
    });

    it('stores the document sent with the undo, dated so a later change wins', async () => {
      const { env, submissionId } = await setup();
      const c1 = await createChange(env, submissionId, 'Hello world', 'Hello big world');
      await resolve(env, submissionId, c1, 'rejected', 'Hello world');
      await undo(env, submissionId, c1, 'Hello big world');

      clearMemoryCache();
      const stored = await getObject<any>(`proposed_versions/${submissionId}`, env);
      expect(stored.proposedVersionsRichText).toBe(lexical('Hello big world'));
      expect(stored.proposedVersionsContent).toBe('Hello big world');
      const change = await getObject<any>(`tracked-changes/submission/${submissionId}/${c1}`, env);
      expect(change.status).toBe('pending');
      expect(change.reappliedAt).toBeDefined();
      expect(new Date(stored.lastUpdatedAt).getTime()).toBeLessThanOrEqual(new Date(change.reappliedAt).getTime());
    });

    it("doesn't let an accept store a snapshot made while the change was rejected", async () => {
      const { env, submissionId } = await setup();
      const c1 = await createChange(env, submissionId, 'Hello world', 'Hello big world');
      await resolve(env, submissionId, c1, 'rejected', 'Hello world');
      // c2 is made while c1 is rejected: its snapshot has no "big"
      const c2 = await createChange(env, submissionId, 'Hello world', 'Hello world again');
      await undo(env, submissionId, c1, 'Hello big world again');
      expect((await getProposed(env, submissionId)).richText).toBe(lexical('Hello big world again'));

      // Accepting c2 (the newest change) sends the editor's state, which has "big" again
      await resolve(env, submissionId, c2, 'approved', 'Hello big world again');

      const proposed = await getProposed(env, submissionId);
      expect(proposed.richText).toBe(lexical('Hello big world again'));
      clearMemoryCache();
      const submission = await getObject<any>(`content_submissions/${submissionId}`, env);
      expect(submission.richTextContent).toBe(lexical('Hello big world again'));
    });
  });
});
