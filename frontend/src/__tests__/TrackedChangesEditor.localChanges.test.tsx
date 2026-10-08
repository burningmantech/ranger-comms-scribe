/**
 * F13: the author's own just-saved change must survive a refetch that started before the
 * server had it. Casey's change is saved (and shown from the local copy) while a refetch,
 * asked for when Morgan's change was announced, is in flight; that response lacks Casey's
 * change. It used to wipe the local copy, so her card and highlight were gone until a
 * reload. Now a local change saved after the refetch was asked for is kept until the server
 * lists it, and another refetch is asked for so the list converges.
 */
import React from 'react';
import { act, render } from '@testing-library/react';
import { TrackedChangesEditor } from '../components/TrackedChangesEditor';
import { TransactionManager } from '../services/transactionManager';
import { ContentSubmission, User } from '../types/content';

const mockWsHandlers = new Map<string, (message: any) => void>();

jest.mock('../components/CollaborativeEditor', () => {
  const mockReact = require('react');
  const MockCollaborativeEditor = ({ onWebSocketClientReady }: any) => {
    mockReact.useEffect(() => {
      onWebSocketClientReady?.({
        on: (type: string, handler: (message: any) => void) => mockWsHandlers.set(type, handler),
        off: () => {},
        send: () => {},
        sendTransactionSettled: () => {},
        sendChangeStatusUpdate: () => {},
        applyRealTimeUpdate: () => {},
      });
    }, [onWebSocketClientReady]);
    return <div data-testid="collaborative-editor" />;
  };
  return { __esModule: true, CollaborativeEditor: MockCollaborativeEditor, default: MockCollaborativeEditor };
});

jest.mock('../components/editor/LexicalEditor', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../components/SaveIndicator', () => ({ __esModule: true, default: () => <span /> }));
jest.mock('../components/editor/plugins/TrackedChangesPlugin', () => ({
  __esModule: true,
  default: () => null,
  removeDecorationsForChange: jest.fn(),
  addDecorationsForChange: jest.fn(),
  getActiveTrackedChangesEditor: jest.fn(),
  dryRunRejects: jest.fn(),
  reapplyRejectedChanges: jest.fn(),
  snapshotDocument: jest.fn(),
  revertResolve: jest.fn(),
}));

const lexical = (text: string) =>
  JSON.stringify({ root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text }] }] } });

const change = (id: string, changedBy: string, oldValue: string, newValue: string) => ({
  id, field: 'content', oldValue, newValue, changedBy, timestamp: new Date(), isIncremental: true, status: 'pending' as const,
  richTextOldValue: lexical(oldValue), richTextNewValue: lexical(newValue),
});

const submissionWith = (changes: any[], text: string): ContentSubmission => ({
  id: 'sub-1',
  title: 'Gate hours',
  content: 'Gate opens at noon.',
  richTextContent: lexical('Gate opens at noon.'),
  submittedBy: 'sam-id',
  submittedAt: new Date(),
  status: 'in_review',
  formFields: [],
  approvals: [],
  changes,
  comments: [],
  assignedReviewers: [],
  assignedCouncilManagers: [],
  suggestedEdits: [],
  requiredApprovers: [],
  proposedVersions: { richTextContent: lexical(text), content: text },
} as unknown as ContentSubmission);

const casey = {
  id: 'casey-id', email: 'casey@example.com', name: 'Casey Cadre', isAdmin: false, commsCadre: true, councilRole: null, roles: [],
} as unknown as User;

/** The TransactionManager the editor created (its events are how a save reaches the editor). */
let manager: TransactionManager | null = null;
const emit = (event: string, ...args: any[]) => (manager as any).emit(event, ...args);

/** What the manager emits when Casey's "Note: " is saved as change c1. */
const caseySaved = () => ({
  id: 'tx-1', remoteChangeId: 'c1', field: 'content', status: 'saved',
  beforeSnapshot: { text: 'Gate opens at noon.', lexicalState: lexical('Gate opens at noon.') },
  afterSnapshot: { text: 'Note: Gate opens at noon.', lexicalState: lexical('Note: Gate opens at noon.') },
});

const morganAnnounced = () => mockWsHandlers.get('transaction_settled')!({
  type: 'transaction_settled', userId: 'morgan@example.com', data: { changeId: 'm1' },
});

const cardIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.rp-body .rp-card')).map((c) => c.getAttribute('data-change-ids'));

const morgan = change('m1', 'morgan@example.com', 'Note: Gate opens at noon.', 'Note: Gate opens at noon. Ask at HQ.');
const caseyOnServer = change('c1', 'casey@example.com', 'Gate opens at noon.', 'Note: Gate opens at noon.');

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1400 });
});

beforeEach(() => {
  mockWsHandlers.clear();
  manager = null;
  const originalOn = TransactionManager.prototype.on;
  jest.spyOn(TransactionManager.prototype, 'on').mockImplementation(function (this: TransactionManager, ...args: any[]) {
    manager = this;
    return (originalOn as any).apply(this, args);
  });
  localStorage.setItem('sessionId', 'session-1');
  (global as any).fetch = jest.fn(() => Promise.resolve(new Response('', { status: 404 })));
});

afterEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
});

const props = (submission: ContentSubmission, onRefreshNeeded: jest.Mock) => ({
  submission,
  currentUser: casey,
  onSave: jest.fn(),
  onComment: jest.fn(),
  onApprove: jest.fn(),
  onReject: jest.fn(),
  onSuggestion: jest.fn(),
  onRefreshNeeded,
  collabMode: 'yjs' as const,
});

describe('F13: a refetch that started before the author\'s save', () => {
  it("keeps the author's just-saved change, and refetches until the server lists it", async () => {
    const onRefreshNeeded = jest.fn();
    const { container, rerender } = render(<TrackedChangesEditor {...props(submissionWith([], 'Gate opens at noon.'), onRefreshNeeded)} />);
    expect(manager).not.toBeNull();

    // Morgan's change is announced: the page refetches (the request goes out now)
    act(() => morganAnnounced());
    expect(onRefreshNeeded).toHaveBeenCalledTimes(1);
    // Casey's save lands while that refetch is in flight
    act(() => emit('transaction-saved', caseySaved()));
    expect(cardIds(container)).toEqual(['c1']);

    // The refetch answers with what the server had when it read: Morgan's change, not Casey's
    rerender(<TrackedChangesEditor {...props(submissionWith([morgan], 'Note: Gate opens at noon. Ask at HQ.'), onRefreshNeeded)} />);
    expect(cardIds(container).sort()).toEqual(['c1', 'm1']);

    // ... and another refetch is asked for, which has both: no duplicate
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(onRefreshNeeded).toHaveBeenCalledTimes(2);
    rerender(<TrackedChangesEditor {...props(submissionWith([caseyOnServer, morgan], 'Note: Gate opens at noon. Ask at HQ. '), onRefreshNeeded)} />);
    expect(cardIds(container).sort()).toEqual(['c1', 'm1']);
  });

  it('drops a local change the server no longer has when it was saved before the refetch was asked for', async () => {
    const onRefreshNeeded = jest.fn();
    const { container, rerender } = render(<TrackedChangesEditor {...props(submissionWith([], 'Gate opens at noon.'), onRefreshNeeded)} />);
    act(() => emit('transaction-saved', caseySaved()));
    expect(cardIds(container)).toEqual(['c1']);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

    act(() => morganAnnounced());
    rerender(<TrackedChangesEditor {...props(submissionWith([morgan], 'Gate opens at noon. Ask at HQ.'), onRefreshNeeded)} />);
    expect(cardIds(container)).toEqual(['m1']);
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(onRefreshNeeded).toHaveBeenCalledTimes(1);
  });
});
