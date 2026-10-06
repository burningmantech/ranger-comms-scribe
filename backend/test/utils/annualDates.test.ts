import { describe, it, expect } from '@jest/globals';
import {
  laborDay, burnDay, ruleDate, resolveAnnualDate, nextOccurrence, occurrenceOn, ruleFromDate, describeRule, describeDays,
} from '../../src/utils/annualDates';

describe('annual dates', () => {
  it('finds Labor Day (the first Monday of September) and the Burn', () => {
    expect(laborDay(2025)).toBe('2025-09-01');
    expect(laborDay(2026)).toBe('2026-09-07');
    expect(laborDay(2027)).toBe('2027-09-06');
    expect(laborDay(2030)).toBe('2030-09-02');
    expect(burnDay(2026)).toBe('2026-09-05');
  });

  it('moves a Labor Day–relative date to the same place next year (6pm–10pm Sept 1 2026 → Aug 31 2027)', () => {
    const rule = ruleFromDate('2026-09-01', 'laborDay');
    expect(rule).toEqual({ kind: 'laborDay', offsetDays: -6 });
    const entry = { rule, startTime: '18:00', endTime: '22:00' };
    expect(resolveAnnualDate(entry, 2027)).toEqual({ year: 2027, date: '2027-08-31', startTime: '18:00', endTime: '22:00' });
    expect(describeRule(rule)).toBe('6 days before Labor Day (4 days before the Burn)');
  });

  it('keeps a fixed date, with Feb 29 on Feb 28 in other years', () => {
    expect(ruleDate({ kind: 'fixed', month: 2, day: 29 }, 2027)).toBe('2027-02-28');
    expect(ruleDate({ kind: 'fixed', month: 2, day: 29 }, 2028)).toBe('2028-02-29');
    expect(describeRule({ kind: 'fixed', month: 8, day: 16 })).toBe('Every August 16');
  });

  it('adds the duration as an end date', () => {
    const entry = { rule: { kind: 'laborDay' as const, offsetDays: -8 }, durationDays: 8 };
    expect(resolveAnnualDate(entry, 2026)).toEqual({ year: 2026, date: '2026-08-30', endDate: '2026-09-07' });
  });

  it('uses an override for its year only', () => {
    const entry = {
      rule: { kind: 'laborDay' as const, offsetDays: -6 },
      startTime: '18:00',
      overrides: { '2027': { date: '2027-08-28', endTime: '23:00' } },
    };
    expect(resolveAnnualDate(entry, 2027)).toEqual({ year: 2027, date: '2027-08-28', startTime: '18:00', endTime: '23:00', overridden: true });
    expect(resolveAnnualDate(entry, 2028).date).toBe('2028-08-29'); // Labor Day 2028 is Sep 4
    expect(resolveAnnualDate(entry, 2028).overridden).toBeUndefined();
  });

  it('finds the next occurrence and the one on a date', () => {
    const entry = { rule: { kind: 'laborDay' as const, offsetDays: -6 } };
    expect(nextOccurrence(entry, '2026-09-01').date).toBe('2026-09-01');
    expect(nextOccurrence(entry, '2026-09-02').date).toBe('2027-08-31');
    expect(occurrenceOn(entry, '2026-09-01')?.year).toBe(2026);
    expect(occurrenceOn(entry, '2026-09-02')).toBeNull();
  });

  it('describes offsets in weeks and days', () => {
    expect(describeDays(1)).toBe('1 day');
    expect(describeDays(-14)).toBe('2 weeks');
    expect(describeDays(10)).toBe('1 week and 3 days');
    expect(describeRule({ kind: 'laborDay', offsetDays: -2 })).toBe('The Burn (2 days before Labor Day)');
    expect(describeRule({ kind: 'laborDay', offsetDays: 0 })).toBe('Labor Day (2 days after the Burn)');
  });
});
