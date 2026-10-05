import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ReviewTopBar from '../ReviewTopBar';
import { ApprovalGates } from '../../types/content';

jest.mock('../../config', () => ({ API_URL: 'http://test-api' }));

const gates: ApprovalGates = {
  councilManager: { met: true, approver: 'cm@x', approverName: 'Casey Manager' },
  commsCadre: { met: false },
  requiredApprovers: {
    met: false, approved: 1, total: 3,
    details: [
      { email: 'a@x', name: 'Ann', status: 'approved' },
      { email: 'b@x', name: 'Bo', status: 'pending' },
      { email: 'c@x', status: 'rejected' },
    ],
  },
  trackedChanges: { met: false, pending: 2, total: 5 },
};

function setup(overrides: Partial<React.ComponentProps<typeof ReviewTopBar>> = {}) {
  const props = {
    submissionId: 's1',
    title: 'Spring newsletter',
    submitterName: 'Sam',
    submittedAt: new Date('2026-10-01T12:00:00Z'),
    isUrgent: false,
    approvalGates: gates,
    canApprove: true,
    isReviewer: false,
    onBack: jest.fn(),
    onApprove: jest.fn(),
    onRequestChanges: jest.fn(),
    onReject: jest.fn(),
    onNavigate: jest.fn(),
    ...overrides,
  };
  render(<ReviewTopBar {...props} />);
  return props;
}

// Popper positions the menu asynchronously; let it finish inside act.
const openMenu = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /finish review/i })); });
};

describe('ReviewTopBar: Finish review menu', () => {
  beforeEach(() => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }));
  });

  it('replaces the separate Approve / Request Changes / Reject / Reset buttons', () => {
    setup();
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /finish review/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('lists Approve, Request changes and Decline', async () => {
    setup();
    await openMenu();
    expect(screen.getByRole('button', { name: /finish review/i })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /^approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^request changes/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^decline/i })).toBeInTheDocument();
  });

  it.each([
    ['Approve', 'onApprove'],
    ['Request changes', 'onRequestChanges'],
    ['Decline', 'onReject'],
  ] as const)('%s calls %s and nothing else', async (label, handler) => {
    const props = setup();
    await openMenu();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}`, 'i') }));
    for (const h of ['onApprove', 'onRequestChanges', 'onReject'] as const) {
      expect(props[h]).toHaveBeenCalledTimes(h === handler ? 1 : 0);
    }
  });

  it('closes on Escape and returns focus to the button', async () => {
    setup();
    const toggle = screen.getByRole('button', { name: /finish review/i });
    toggle.focus();
    await act(async () => { fireEvent.click(toggle); });
    const approve = screen.getByRole('button', { name: /^approve/i });
    fireEvent.keyDown(approve, { key: 'Escape' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    expect(document.activeElement).toBe(toggle);
  });

  it('is hidden for users who cannot approve (e.g. the author)', () => {
    setup({ canApprove: false });
    expect(screen.queryByRole('button', { name: /finish review/i })).not.toBeInTheDocument();
    // The conditions are still shown to everyone
    expect(screen.getByRole('button', { name: /conditions met/i })).toBeInTheDocument();
  });
});

describe('ReviewTopBar: conditions popover', () => {
  beforeEach(() => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }));
  });

  it('shows the count once and opens a list of the gates on click', () => {
    setup();
    expect(screen.getAllByText(/conditions met/i)).toHaveLength(1);
    const trigger = screen.getByRole('button', { name: /1\/4 conditions met/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: /approval conditions/i });
    expect(dialog).toHaveTextContent('Council Manager');
    expect(dialog).toHaveTextContent('Approved by Casey Manager');
    expect(dialog).toHaveTextContent('Needs approval from a Comms Cadre member');
    expect(dialog).toHaveTextContent('1 of 3 approved. Still needed: Bo, c@x (declined)');
    expect(dialog).toHaveTextContent('2 edits still to accept or reject');
    expect(screen.getAllByText('Done')).toHaveLength(1);
    expect(screen.getAllByText('Not done')).toHaveLength(3);
  });

  it('closes on Escape (focus back on the trigger) and on an outside click', () => {
    setup();
    const trigger = screen.getByRole('button', { name: /conditions met/i });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is not rendered without gates', () => {
    setup({ approvalGates: undefined });
    expect(screen.queryByText(/conditions met/i)).not.toBeInTheDocument();
  });
});

describe('ReviewTopBar: queue pager', () => {
  const queueResponse = (ids: string[]) => ({
    ok: true,
    json: async () => ({ needsAction: ids.slice(0, 1).map((id) => ({ id, title: id })), inProgress: ids.slice(1).map((id) => ({ id, title: id })) }),
  });

  beforeEach(() => {
    localStorage.setItem('sessionId', 'sess');
  });

  it('shows "Request N of M" with previous/next request labels for a reviewer in the queue', async () => {
    (global as any).fetch = jest.fn(async () => queueResponse(['a', 's1', 'c']));
    const props = setup({ isReviewer: true });
    expect(await screen.findByText('Request 2 of 3')).toBeInTheDocument();
    const prev = screen.getByRole('button', { name: 'Previous request' });
    const next = screen.getByRole('button', { name: 'Next request' });
    expect(prev).toHaveAttribute('title', 'Previous request ([)');
    expect(next).toHaveAttribute('title', 'Next request (])');
    fireEvent.click(next);
    expect(props.onNavigate).toHaveBeenCalledWith('c');
    fireEvent.click(prev);
    expect(props.onNavigate).toHaveBeenCalledWith('a');
  });

  it('is hidden for a queue of one', async () => {
    (global as any).fetch = jest.fn(async () => queueResponse(['s1']));
    setup({ isReviewer: true });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/^Request \d+ of/)).not.toBeInTheDocument();
  });

  it('is hidden when this submission is not in the queue (opened from history or a notification)', async () => {
    (global as any).fetch = jest.fn(async () => queueResponse(['a', 'b', 'c']));
    setup({ isReviewer: true });
    await waitFor(() => expect((global as any).fetch).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/^Request \d+ of/)).not.toBeInTheDocument();
  });

  it('is hidden for non-reviewers (authors), who never work from the queue', async () => {
    (global as any).fetch = jest.fn(async () => queueResponse(['a', 's1', 'c']));
    setup({ isReviewer: false, canApprove: false });
    await act(async () => { await Promise.resolve(); });
    expect((global as any).fetch).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Request \d+ of/)).not.toBeInTheDocument();
  });
});
