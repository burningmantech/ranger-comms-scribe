import {
  laborDay, burnDay, resolveAnnualDate, nextOccurrence, ruleFromDate, describeRule, formatOccurrence, formatTimes,
} from '../annualDates';

// The same cases as backend/test/utils/annualDates.test.ts
describe('annual dates', () => {
  it('finds Labor Day and the Burn', () => {
    expect(laborDay(2025)).toBe('2025-09-01');
    expect(laborDay(2026)).toBe('2026-09-07');
    expect(laborDay(2027)).toBe('2027-09-06');
    expect(laborDay(2030)).toBe('2030-09-02');
    expect(burnDay(2026)).toBe('2026-09-05');
  });

  it('moves 6pm–10pm Sept 1 2026 to Tue Aug 31 2027', () => {
    const rule = ruleFromDate('2026-09-01', 'laborDay');
    expect(rule).toEqual({ kind: 'laborDay', offsetDays: -6 });
    const entry = { rule, startTime: '18:00', endTime: '22:00' };
    const next = resolveAnnualDate(entry, 2027);
    expect(next).toEqual({ year: 2027, date: '2027-08-31', startTime: '18:00', endTime: '22:00' });
    expect(formatOccurrence(next)).toBe('Tue Aug 31, 2027, 6–10pm');
    expect(describeRule(rule)).toBe('6 days before Labor Day (4 days before the Burn)');
    expect(nextOccurrence(entry, '2026-09-02').date).toBe('2027-08-31');
  });

  it('uses an override for its year only', () => {
    const entry = { rule: { kind: 'fixed' as const, month: 8, day: 16 }, overrides: { '2027': { date: '2027-08-20' } } };
    expect(resolveAnnualDate(entry, 2027)).toMatchObject({ date: '2027-08-20', overridden: true });
    expect(resolveAnnualDate(entry, 2028).date).toBe('2028-08-16');
  });

  it('formats times and ranges', () => {
    expect(formatTimes('09:00', '13:30')).toBe('9am–1:30pm');
    expect(formatTimes('12:00')).toBe('noon');
    expect(formatOccurrence({ date: '2026-08-30', endDate: '2026-09-07' })).toBe('Sun Aug 30 – Mon Sep 7, 2026');
  });
});
