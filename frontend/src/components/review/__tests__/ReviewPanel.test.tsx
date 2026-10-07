import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Comment } from '../../../types/content';
import { ReviewPanel, ReviewPanelProps } from '../ReviewPanel';
import { buildOpenItems, buildResolvedThreads, ReviewChangeLike } from '../../../utils/reviewItems';

jest.mock('../../../services/userDirectory', () => ({
  useUserName: (value?: string | null) => value || '',
  useUserDirectory: () => (value?: string | null) => value || '',
  resolveUserEmail: (value?: string | null) => value || undefined,
}));

const at = (s: number) => new Date(Date.UTC(2026, 9, 5, 10, 0, s));
const comment = (id: string, content: string, extra: Partial<Comment> = {}): Comment => ({
  id, content, authorId: 'bob@x', createdAt: at(1), type: 'COMMENT', resolved: false, ...extra,
});
const resolvedBy = (c: Comment): Comment => ({ ...c, resolved: true, resolvedBy: 'rev@x', resolvedByName: 'Rev', resolvedAt: at(30).toISOString() });
const change = (id: string): ReviewChangeLike => ({ id, field: 'content', oldValue: 'a b', newValue: 'a x b', changedBy: 'alice@x', timestamp: at(2), status: 'pending' });

function renderPanel(changes: ReviewChangeLike[], comments: Comment[], extra: Partial<ReviewPanelProps<ReviewChangeLike>> = {}) {
  const onResolveThread = jest.fn();
  const props: ReviewPanelProps<ReviewChangeLike> = {
    tab: 'open',
    onTabChange: jest.fn(),
    openItems: buildOpenItems(changes, comments, new Map()),
    history: [],
    pendingCount: changes.length,
    canReview: true,
    fieldLabel: () => undefined,
    onSelect: jest.fn(),
    onAccept: jest.fn(),
    onReject: jest.fn(),
    onAcceptAll: jest.fn(),
    onRejectAll: jest.fn(),
    onComment: jest.fn(),
    onReply: jest.fn(),
    canUndo: () => false,
    onUndo: jest.fn(),
    resolvedThreads: buildResolvedThreads(comments),
    onResolveThread,
    ...extra,
  };
  const utils = render(<ReviewPanel {...props} />);
  return { ...utils, onResolveThread, props };
}

describe('ReviewPanel: resolving comment threads', () => {
  it('a comment thread in Open has Resolve, which resolves that thread', () => {
    const { onResolveThread } = renderPanel([], [comment('k1', 'Please check'), comment('r1', '@reply:k1 Done')]);
    expect(screen.getByText('All changes reviewed. Open comments:')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Resolve comment thread' });
    expect(buttons).toHaveLength(1); // the root only, not the reply
    fireEvent.click(buttons[0]);
    expect(onResolveThread).toHaveBeenCalledWith('k1', true);
  });

  it('a thread on a pending change can be resolved from its card', () => {
    const { onResolveThread } = renderPanel([change('c1')], [comment('k1', '@change:c1 Why?')]);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve comment thread' }));
    expect(onResolveThread).toHaveBeenCalledWith('k1', true);
  });

  it('shows "All caught up" when every comment is resolved and no change is pending', () => {
    renderPanel([], [resolvedBy(comment('k1', 'Please check')), resolvedBy(comment('k2', '@change:c9 On a resolved change'))]);
    expect(screen.getByText('All caught up')).toBeInTheDocument();
    expect(screen.queryByText('All changes reviewed. Open comments:')).not.toBeInTheDocument();
  });

  it('without onResolveThread there is no Resolve button', () => {
    renderPanel([], [comment('k1', 'Please check')], { onResolveThread: undefined });
    expect(screen.queryByRole('button', { name: 'Resolve comment thread' })).not.toBeInTheDocument();
  });
});

describe('ReviewPanel: History lists resolved threads', () => {
  it('"Resolved by" with the thread and Reopen, which reopens it', () => {
    const { onResolveThread } = renderPanel([], [resolvedBy(comment('k1', 'Please check')), comment('r1', '@reply:k1 Done')], { tab: 'history' });
    const item = document.querySelector('[data-resolved-thread-id="k1"]') as HTMLElement;
    expect(item).not.toBeNull();
    expect(within(item).getByText(/Resolved by/)).toBeInTheDocument();
    expect(within(item).getByText('Rev')).toBeInTheDocument();
    expect(within(item).getByText('Please check')).toBeInTheDocument();
    expect(within(item).getByText('Done')).toBeInTheDocument();
    // read-only: no reply or resolve in History
    expect(within(item).queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: 'Resolve comment thread' })).not.toBeInTheDocument();
    expect(screen.queryByText('No decisions yet')).not.toBeInTheDocument();
    fireEvent.click(within(item).getByRole('button', { name: /Reopen/ }));
    expect(onResolveThread).toHaveBeenCalledWith('k1', false);
  });

  it('shows the empty state only when there are no decisions and no resolved threads', () => {
    renderPanel([], [comment('k1', 'open one')], { tab: 'history' });
    expect(screen.getByText('No decisions yet')).toBeInTheDocument();
  });
});
