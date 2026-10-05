import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import DocumentViewBar, { canOpenSend } from '../DocumentViewBar';
import { buildGateRows } from '../ConditionsPopover';

describe('DocumentViewBar', () => {
  it('offers Proposed | Compare | Original with Proposed selected', () => {
    const onViewChange = jest.fn();
    render(<DocumentViewBar view="proposed" onViewChange={onViewChange} submissionStatus="submitted" />);
    expect(screen.getByRole('button', { name: 'Proposed' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(onViewChange).toHaveBeenCalledWith('comparison');
    fireEvent.click(screen.getByRole('button', { name: 'Original' }));
    expect(onViewChange).toHaveBeenCalledWith('original');
  });

  it.each(['draft', 'submitted', 'in_review', 'rejected'])('hides Send while the request is %s', (status) => {
    render(<DocumentViewBar view="proposed" onViewChange={jest.fn()} submissionStatus={status} />);
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
  });

  it.each(['approved', 'comms_approved', 'sent'])('shows Send when the request is %s (as the Send tab was enabled)', (status) => {
    const onViewChange = jest.fn();
    render(<DocumentViewBar view="proposed" onViewChange={onViewChange} submissionStatus={status} />);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onViewChange).toHaveBeenCalledWith('send');
  });

  it('canOpenSend matches the old tab condition', () => {
    expect(['approved', 'comms_approved', 'sent', 'submitted', undefined].map(canOpenSend)).toEqual([true, true, true, false, false]);
  });
});

describe('buildGateRows', () => {
  it('marks all four gates done when met', () => {
    const rows = buildGateRows({
      councilManager: { met: true, approverName: 'Casey' },
      commsCadre: { met: true, approver: 'cc@x' },
      requiredApprovers: { met: true, approved: 2, total: 2, details: [] },
      trackedChanges: { met: true, pending: 0, total: 3 },
    });
    expect(rows.map((r) => r.met)).toEqual([true, true, true, true]);
    expect(rows[1].detail).toBe('Approved by cc@x');
    expect(rows[2].detail).toBe('All 2 approved');
  });

  it('says when no approvers are assigned', () => {
    const rows = buildGateRows({
      councilManager: { met: false },
      commsCadre: { met: false },
      requiredApprovers: { met: false, approved: 0, total: 0, details: [] },
      trackedChanges: { met: false, pending: 0, total: 0 },
    });
    expect(rows[2].detail).toBe('No approvers assigned yet');
    expect(rows[3].detail).toBe('No edits yet');
  });
});
