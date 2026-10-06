import { currentFormFieldValue } from '../formFieldValue';
import type { Change } from '../../types/content';

const change = (newValue: string, status: Change['status'], timestamp: string, extra: Partial<Change> = {}): Change => ({
  id: timestamp, field: 'title', oldValue: 'Old', newValue, changedBy: 'u', timestamp: new Date(timestamp), status, ...extra,
});

describe('currentFormFieldValue', () => {
  it('is null without a change to the field', () => {
    expect(currentFormFieldValue([], 'title')).toBeNull();
    expect(currentFormFieldValue([{ ...change('x', 'pending', '2026-01-01'), field: 'audience' }], 'title')).toBeNull();
  });

  it('keeps an accepted value (the Proposed view used to drop it)', () => {
    expect(currentFormFieldValue([change('New', 'approved', '2026-01-01')], 'title')).toBe('New');
  });

  it('takes the newest change that is not rejected', () => {
    expect(currentFormFieldValue([
      change('Accepted', 'approved', '2026-01-01'),
      change('Pending', 'pending', '2026-01-02'),
    ], 'title')).toBe('Pending');
    expect(currentFormFieldValue([
      change('Accepted', 'approved', '2026-01-01'),
      change('Rejected', 'rejected', '2026-01-02'),
    ], 'title')).toBe('Accepted');
    expect(currentFormFieldValue([change('Rejected', 'rejected', '2026-01-02')], 'title')).toBeNull();
  });

  it('uses the whole value when the server kept only the changed words', () => {
    expect(currentFormFieldValue([
      change('subject', 'approved', '2026-01-01', { completeProposedVersion: 'New subject' }),
    ], 'title')).toBe('New subject');
  });
});
