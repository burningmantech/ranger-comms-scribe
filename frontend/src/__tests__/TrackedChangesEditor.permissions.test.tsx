/**
 * Who sees Accept / Reject on the review page, and what happens when the server refuses a
 * decision. The backend allows a status change (PUT .../status, .../batch-status, the undo)
 * only for a reviewer (Admin, Comms Cadre, Council) or the request's submitter, by user id;
 * the page offers the controls to exactly those people. When a decision's save fails anyway
 * (any non-2xx, or a network error), its optimistic local state is rolled back: the card is
 * back in Open, the Undo toast is gone, and in collaborative mode the document change is
 * undone through the shared doc.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TrackedChangesEditor } from '../components/TrackedChangesEditor';
import { ContentSubmission, User } from '../types/content';
import * as plugin from '../components/editor/plugins/TrackedChangesPlugin';

jest.mock('../components/CollaborativeEditor', () => {
  const MockCollaborativeEditor = () => <div data-testid="collaborative-editor" />;
  return { __esModule: true, CollaborativeEditor: MockCollaborativeEditor, default: MockCollaborativeEditor };
});

jest.mock('../components/editor/LexicalEditor', () => ({
  __esModule: true,
  default: () => <div data-testid="lexical-editor" />,
}));

jest.mock('../components/SaveIndicator', () => ({
  __esModule: true,
  default: () => <span data-testid="save-indicator">saved</span>,
}));

// The editor is mocked out, so the plugin's document functions are too (implementations
// set in beforeEach: CRA resets mocks before every test).
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

const mockPlugin = plugin as jest.Mocked<typeof plugin> & {
  snapshotDocument: jest.Mock;
  revertResolve: jest.Mock;
};

const lexical = (text: string) =>
  JSON.stringify({ root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text }] }] } });

const pendingChange = (id: string, oldValue: string, newValue: string) => ({
  id,
  field: 'content',
  oldValue,
  newValue,
  changedBy: 'casey@example.com',
  timestamp: new Date(),
  isIncremental: true,
  status: 'pending' as const,
  richTextOldValue: lexical(oldValue),
  richTextNewValue: lexical(newValue),
});

const baseSubmission: ContentSubmission = {
  id: 'sub-1',
  title: 'Gate hours',
  content: 'Gate opens at noon',
  richTextContent: lexical('Gate opens at noon'),
  submittedBy: 'sam-id',
  submittedAt: new Date(),
  status: 'in_review',
  formFields: [],
  approvals: [],
  changes: [pendingChange('change-1', 'Gate opens at noon', 'Gate opens at 10am')],
  comments: [],
  assignedReviewers: [],
  assignedCouncilManagers: [],
  suggestedEdits: [],
  requiredApprovers: ['olive@example.com'],
};

// Access fields set explicitly (as GET /auth/me returns them), so nothing is read from roles
const olive = {
  id: 'olive-id', email: 'olive@example.com', name: 'Olive Other',
  isAdmin: false, commsCadre: false, councilRole: null, roles: [],
} as unknown as User;
const casey = {
  id: 'casey-id', email: 'casey@example.com', name: 'Casey Cadre',
  isAdmin: false, commsCadre: true, councilRole: null, roles: [],
} as unknown as User;
const sam = {
  id: 'sam-id', email: 'sam@example.com', name: 'Sam Submitter',
  isAdmin: false, commsCadre: false, councilRole: null, roles: [],
} as unknown as User;

const props = (currentUser: User, submission: ContentSubmission = baseSubmission, extra: Record<string, unknown> = {}) => ({
  submission,
  currentUser,
  onSave: jest.fn(),
  onComment: jest.fn(),
  onApprove: jest.fn(),
  onReject: jest.fn(),
  onSuggestion: jest.fn(),
  onRefreshNeeded: jest.fn(),
  ...extra,
});

type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>;
let respond: Responder;
const fetchMock = jest.fn();
const ok = (body: unknown = { success: true }) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const forbidden = () => new Response('Forbidden', { status: 403 });
/** Status and batch-status PUTs and undo POSTs get `decide`; everything else (lookups on mount) a 404, so its fallback is used. */
const routeDecisions = (decide: Responder): Responder => (url, init) => {
  if (/\/tracked-changes\/(change\/[^/]+\/status|batch-status|[^/]+\/undo)$/.test(url)) return decide(url, init);
  return new Response('', { status: 404 });
};
const decisionCalls = () => fetchMock.mock.calls
  .map(([url, init]) => ({ url: String(url), method: init?.method }))
  .filter((c) => /\/tracked-changes\//.test(c.url));

// The decision's save runs 500 ms after the click
const SAVE_WAIT = { timeout: 4000 };

const openPanel = (container: HTMLElement) => container.querySelector('.rp-body') as HTMLElement;

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1400 });
});

const fakeEditor = { fake: 'editor' };

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('sessionId', 'session-1');
  respond = routeDecisions(() => ok());
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve().then(() => respond(String(input), init)));
  (global as any).fetch = fetchMock;
  // A snapshot is a counter (the one taken before a resolve differs from the one after);
  // the revert reports success.
  let snapshots = 0;
  // No editor (selecting a card scrolls the editor); the collaborative test sets one
  (mockPlugin.getActiveTrackedChangesEditor as jest.Mock).mockImplementation(() => null);
  (mockPlugin.dryRunRejects as jest.Mock).mockImplementation(() => new Map());
  (mockPlugin.reapplyRejectedChanges as jest.Mock).mockImplementation(() => ({ ok: true }));
  mockPlugin.snapshotDocument.mockImplementation(() => [{ snapshot: ++snapshots }]);
  mockPlugin.revertResolve.mockImplementation(() => ({ ok: true }));
});

afterEach(() => {
  localStorage.clear();
});

describe('who sees Accept and Reject (the backend rule: reviewer, or the submitter by id)', () => {
  it('hides them from an approver listed on the request who is not a reviewer or the submitter', () => {
    render(<TrackedChangesEditor {...props(olive)} />);

    expect(screen.getByText('Replaced')).toBeInTheDocument(); // the card is there
    expect(screen.queryByTitle('Accept')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Reject')).not.toBeInTheDocument();
    expect(screen.getByTitle('Add comment')).toBeInTheDocument(); // commenting still works

    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.queryByText('Accept all')).not.toBeInTheDocument();
    expect(screen.queryByText('Reject all')).not.toBeInTheDocument();
  });

  it('hides them from a listed approver who has already approved the request', () => {
    const submission = {
      ...baseSubmission,
      approvals: [{ id: 'a1', approverId: 'olive-id', approverEmail: 'olive@example.com', status: 'APPROVED', timestamp: new Date() }],
    } as unknown as ContentSubmission;
    render(<TrackedChangesEditor {...props(olive, submission)} />);
    expect(screen.queryByTitle('Accept')).not.toBeInTheDocument();
  });

  it('ignores the keyboard shortcut for someone who cannot decide', async () => {
    const { container } = render(<TrackedChangesEditor {...props(olive)} />);
    fireEvent.click(within(openPanel(container)).getByText('Replaced'));
    fireEvent.keyDown(window, { key: 'a' });
    await new Promise((r) => setTimeout(r, 700));
    expect(decisionCalls()).toEqual([]);
    expect(screen.queryByText('Accepted')).not.toBeInTheDocument();
  });

  it('hides them from a submitter matched only by email (the backend compares user ids)', () => {
    render(<TrackedChangesEditor {...props(sam, { ...baseSubmission, submittedBy: 'sam@example.com' })} />);
    expect(screen.queryByTitle('Accept')).not.toBeInTheDocument();
  });

  it('shows them to the submitter (by user id)', () => {
    render(<TrackedChangesEditor {...props(sam)} />);
    expect(screen.getByTitle('Accept')).toBeInTheDocument();
    expect(screen.getByTitle('Reject')).toBeInTheDocument();
  });

  it('shows them, and Accept all / Reject all, to a reviewer', () => {
    render(<TrackedChangesEditor {...props(casey)} />);
    expect(screen.getByTitle('Accept')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.getByText('Accept all')).toBeInTheDocument();
    expect(screen.getByText('Reject all')).toBeInTheDocument();
  });
});

describe('a decision the server refuses is rolled back', () => {
  it('accept refused (403): the card is back in Open, the Undo toast is gone, the error is shown', async () => {
    respond = routeDecisions(() => forbidden());
    const p = props(casey);
    const { container } = render(<TrackedChangesEditor {...p} />);

    fireEvent.click(screen.getByTitle('Accept'));
    // Optimistic first
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('All caught up')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText(/Failed to accept change \(403\)/)).toBeInTheDocument(), SAVE_WAIT);
    await waitFor(() => expect(within(openPanel(container)).getByText('Replaced')).toBeInTheDocument());
    expect(screen.queryByText('All caught up')).not.toBeInTheDocument();
    expect(screen.queryByText('Accepted')).not.toBeInTheDocument();
    expect(screen.getByTitle('Accept')).toBeInTheDocument();
    // Not in History as accepted
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    expect(screen.queryByText(/Accepted by/)).not.toBeInTheDocument();
    expect(p.onRefreshNeeded).toHaveBeenCalled();
  });

  it('a network error rolls back the same way', async () => {
    respond = routeDecisions(() => { throw new TypeError('Failed to fetch'); });
    const { container } = render(<TrackedChangesEditor {...props(casey)} />);

    fireEvent.click(screen.getByTitle('Reject'));
    expect(screen.getByText('Rejected')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText(/network error/)).toBeInTheDocument(), SAVE_WAIT);
    await waitFor(() => expect(within(openPanel(container)).getByText('Replaced')).toBeInTheDocument());
    expect(screen.queryByText('Rejected')).not.toBeInTheDocument();
  });

  it('a successful save keeps the decision', async () => {
    render(<TrackedChangesEditor {...props(casey)} />);
    fireEvent.click(screen.getByTitle('Accept'));
    await waitFor(() => expect(decisionCalls().some((c) => c.url.endsWith('/change/change-1/status'))).toBe(true), SAVE_WAIT);
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText('All caught up')).toBeInTheDocument();
    expect(mockPlugin.revertResolve).not.toHaveBeenCalled();
  });

  it('collaborative mode: the document change is undone through the shared doc (the snapshots taken around the resolve)', async () => {
    respond = routeDecisions(() => forbidden());
    // The resolve handler (TrackedChangesPlugin, mocked out here) reports the reject reverted the document
    const onResolve = (e: Event) => {
      (e as CustomEvent).detail.result = { restored: true, method: 'context' };
    };
    window.addEventListener('resolve-tracked-change', onResolve);
    (mockPlugin.getActiveTrackedChangesEditor as jest.Mock).mockImplementation(() => fakeEditor);
    try {
      const { container } = render(<TrackedChangesEditor {...props(casey, baseSubmission, { collabMode: 'yjs' })} />);
      fireEvent.click(screen.getByTitle('Reject'));
      expect(screen.getByText('All caught up')).toBeInTheDocument();

      await waitFor(() => expect(mockPlugin.revertResolve).toHaveBeenCalledTimes(1), SAVE_WAIT);
      const [editor, before, after, changeId] = mockPlugin.revertResolve.mock.calls[0];
      expect(editor).toEqual({ fake: 'editor' });
      expect(changeId).toBe('change-1');
      // The snapshot from before the resolve and the one from right after it
      expect(before).not.toEqual(after);
      const snapshots = mockPlugin.snapshotDocument.mock.results.map((r) => r.value);
      expect(snapshots).toContainEqual(before);
      expect(snapshots).toContainEqual(after);
      await waitFor(() => expect(within(openPanel(container)).getByText('Replaced')).toBeInTheDocument());
    } finally {
      window.removeEventListener('resolve-tracked-change', onResolve);
    }
  });

  it('Accept all refused: every change is back in Open, with one error', async () => {
    respond = routeDecisions(() => forbidden());
    const submission = {
      ...baseSubmission,
      changes: [
        pendingChange('change-1', 'Gate opens at noon', 'Gate opens at 10am'),
        { ...pendingChange('change-2', 'Bring water', 'Bring lots of water'), timestamp: new Date(Date.now() + 1000) },
      ],
    };
    const { container } = render(<TrackedChangesEditor {...props(casey, submission)} />);
    expect(screen.getAllByTitle('Accept')).toHaveLength(2);

    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('Accept all'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Accept all'));
    expect(await screen.findByText('Accepted 2 changes')).toBeInTheDocument();

    await waitFor(() => expect(decisionCalls().some((c) => c.url.endsWith('/batch-status'))).toBe(true), SAVE_WAIT);
    await waitFor(() => expect(screen.getAllByTitle('Accept')).toHaveLength(2), SAVE_WAIT);
    expect(screen.queryByText('Accepted 2 changes')).not.toBeInTheDocument();
    expect(within(openPanel(container)).queryByText('All caught up')).not.toBeInTheDocument();
    expect(screen.getByText(/Couldn't save: 2 changes are pending again/)).toBeInTheDocument();
  });

  it('Accept all: a change whose own save failed is kept when the batch save succeeds', async () => {
    respond = routeDecisions((url) => (url.endsWith('/batch-status') ? ok({ success: true, results: [] }) : forbidden()));
    const { container } = render(<TrackedChangesEditor {...props(casey)} />);
    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('Accept all'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Accept all'));

    await waitFor(() => expect(decisionCalls().some((c) => c.url.endsWith('/batch-status'))).toBe(true), SAVE_WAIT);
    await new Promise((r) => setTimeout(r, 100));
    expect(within(openPanel(container)).getByText('All caught up')).toBeInTheDocument();
  });

  it('an undo the server refuses puts the decision back', async () => {
    respond = routeDecisions((url) => (url.endsWith('/undo') ? new Response('Internal server error', { status: 500 }) : ok()));
    const submission = {
      ...baseSubmission,
      changes: [{ ...pendingChange('change-1', 'Gate opens at noon', 'Gate opens at 10am'), status: 'approved' as const, approvedBy: 'casey@example.com', approvedByName: 'Casey Cadre', approvedAt: new Date() }],
    };
    const { container } = render(<TrackedChangesEditor {...props(casey, submission)} />);
    expect(screen.getByText('All caught up')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));

    await waitFor(() => expect(screen.getByText(/Couldn't save the undo/)).toBeInTheDocument(), SAVE_WAIT);
    // Still accepted: in History, not in Open
    expect(screen.getByText(/Accepted by/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Open/ }));
    expect(within(openPanel(container)).getByText('All caught up')).toBeInTheDocument();
  });

  it("collaborative mode: an undo of a reject the server refuses takes the re-applied change back out of the document", async () => {
    respond = routeDecisions((url) => (url.endsWith('/undo') ? forbidden() : ok()));
    (mockPlugin.getActiveTrackedChangesEditor as jest.Mock).mockImplementation(() => fakeEditor);
    const submission = {
      ...baseSubmission,
      changes: [{ ...pendingChange('change-1', 'Gate opens at noon', 'Gate opens at 10am'), status: 'rejected' as const, rejectedBy: 'casey@example.com', rejectedByName: 'Casey Cadre', rejectedAt: new Date() }],
    };
    const p = props(casey, submission, { collabMode: 'yjs' });
    render(<TrackedChangesEditor {...p} />);

    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));

    await waitFor(() => expect(mockPlugin.revertResolve).toHaveBeenCalledTimes(1), SAVE_WAIT);
    expect(mockPlugin.reapplyRejectedChanges).toHaveBeenCalledTimes(1);
    const [editor, before, after] = mockPlugin.revertResolve.mock.calls[0];
    expect(editor).toEqual({ fake: 'editor' });
    expect(before).not.toEqual(after);
    expect(await screen.findByText(/Couldn't save the undo on the server \(1 of 1\); the decision stands/)).toBeInTheDocument();
    expect(screen.getByText(/Rejected by/)).toBeInTheDocument();
    expect(p.onRefreshNeeded).toHaveBeenCalled();
  });
});
