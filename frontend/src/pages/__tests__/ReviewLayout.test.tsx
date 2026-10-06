import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ReviewLayout, reviewerDecision, DecisionResult } from '../TrackedChangesView';
import { ContentSubmission, User } from '../../types/content';

jest.mock('../../config', () => ({ API_URL: 'http://test-api' }));
// The editor isn't part of these tests (ReviewLayout only wraps it).
jest.mock('../../components/TrackedChangesEditor', () => ({ TrackedChangesEditor: () => null }));
jest.mock('../../contexts/ContentContext', () => ({ useContent: () => ({}) }));

const user: User = { id: 'u-rev', email: 'rev@example.com', name: 'Reviewer', roles: ['CommsCadre'] };

function submission(approvals: any[] = []): ContentSubmission {
  return {
    id: 's1',
    title: 'Spring newsletter',
    content: '',
    status: 'in_review',
    submittedBy: 'sam@example.com',
    submittedAt: new Date('2026-10-01T12:00:00Z'),
    formFields: [],
    comments: [],
    approvals,
    changes: [],
  } as unknown as ContentSubmission;
}

function setup(overrides: Partial<React.ComponentProps<typeof ReviewLayout>> = {}) {
  const ok = async (): Promise<DecisionResult> => ({ ok: true });
  const props = {
    submission: submission(),
    currentUser: user,
    canApprove: true,
    isReviewer: false,
    isUrgent: false,
    onBack: jest.fn(),
    onApprove: jest.fn(ok),
    onReject: jest.fn(ok),
    onRequestChanges: jest.fn(ok),
    onNavigate: jest.fn(),
    children: null,
    ...overrides,
  };
  const utils = render(<ReviewLayout {...props} />);
  return { props, ...utils };
}

const openMenu = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /finish review/i })); });
};
const choose = async (label: RegExp) => {
  await openMenu();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })); });
};

describe('ReviewLayout: Finish review decisions', () => {
  beforeEach(() => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }));
  });

  it('asks before declining; Cancel records nothing', async () => {
    const { props } = setup();
    await choose(/^decline/i);
    const dialog = screen.getByRole('dialog', { name: /decline this request\?/i });
    expect(dialog).toHaveTextContent('The submitter will be notified.');
    expect(props.onReject).not.toHaveBeenCalled();
    expect(document.activeElement).toHaveTextContent('Cancel');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: /decline this request\?/i })).not.toBeInTheDocument();
    expect(props.onReject).not.toHaveBeenCalled();
  });

  it('Escape closes the Decline confirmation without declining', async () => {
    const { props } = setup();
    await choose(/^decline/i);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /decline this request\?/i })).not.toBeInTheDocument();
    expect(props.onReject).not.toHaveBeenCalled();
  });

  it('confirming declines once, then shows a toast and "Declined" on the button', async () => {
    const { props } = setup();
    await choose(/^decline/i);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^decline$/i })); });
    expect(props.onReject).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('You declined this request');
    expect(screen.getByRole('button', { name: /finish review: declined/i })).toHaveTextContent('Declined');
  });

  it('approving shows a toast and "Approved ✓" on the button', async () => {
    const { props } = setup();
    await choose(/^approve/i);
    expect(props.onApprove).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('You approved this request');
    expect(screen.getByRole('button', { name: /finish review: approved/i })).toHaveTextContent('Approved ✓');
  });

  it('a decision that was not recorded says so and leaves the button as it was', async () => {
    setup({ onApprove: jest.fn(async () => ({ ok: false, error: 'You have already approved this submission' })) });
    await choose(/^approve/i);
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't record your decision: You have already approved this submission");
    expect(screen.getByRole('button', { name: /^finish review$/i })).toBeInTheDocument();
  });

  it('shows the decision stored in the approvals (e.g. after a reload)', () => {
    setup({ submission: submission([{ id: 'a1', approverId: 'u-rev', status: 'REJECTED' }]) });
    expect(screen.getByRole('button', { name: /finish review: declined/i })).toHaveTextContent('Declined');
  });

  it('the toast goes away by itself', async () => {
    jest.useFakeTimers();
    try {
      setup();
      await choose(/^approve/i);
      expect(screen.getByRole('status')).toBeInTheDocument();
      act(() => { jest.advanceTimersByTime(6000); });
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('reviewerDecision', () => {
  it('finds the reviewer by id or email', () => {
    expect(reviewerDecision([{ id: 'a', approverId: 'u-rev', approverEmail: '', status: 'APPROVED' } as any], user)).toBe('approved');
    expect(reviewerDecision([{ id: 'a', approverId: 'other', approverEmail: 'rev@example.com', status: 'REJECTED' } as any], user)).toBe('rejected');
    expect(reviewerDecision([{ id: 'a', approverId: 'other', approverEmail: 'x@example.com', status: 'APPROVED' } as any], user)).toBeNull();
    expect(reviewerDecision([{ id: 'a', approverId: 'u-rev', approverEmail: '', status: 'PENDING' } as any], user)).toBeNull();
    expect(reviewerDecision(undefined, user)).toBeNull();
  });
});
