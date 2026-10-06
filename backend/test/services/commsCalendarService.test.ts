import { describe, it, expect } from '@jest/globals';
import { CommsCalendarEntry } from '../../src/types';
import {
  addYearsClamped, cycleStartYear, nextAnniversary, computeUpcoming, mapAudienceToMethod,
  validateEntryInput, applyPatch, buildNudgeEmail, duplicateKey, pacificDate, isValidYmd,
  NEWSLETTER_AUDIENCE_LABEL, SINGULAR_AUDIENCE_LABEL,
} from '../../src/services/commsCalendarService';

function entry(overrides: Partial<CommsCalendarEntry> = {}): CommsCalendarEntry {
  return {
    id: 'e1', subject: 'Ranger Satisfaction Survey', method: 'Announce', team: 'Council',
    contactEmails: ['council@example.org'], comments: '', nudges: [], source: 'manual',
    createdBy: 'comms@example.org', createdAt: '2025-09-01T00:00:00Z', updatedAt: '2025-09-01T00:00:00Z',
    ...overrides,
  };
}

describe('dates', () => {
  it('moves Feb 29 to Feb 28 in a non-leap year', () => {
    expect(addYearsClamped('2024-02-29', 1)).toBe('2025-02-28');
    expect(addYearsClamped('2024-02-29', 4)).toBe('2028-02-29');
    expect(addYearsClamped('2025-09-14', 1)).toBe('2026-09-14');
  });

  it('starts a cycle on September 1', () => {
    expect(cycleStartYear('2026-08-31')).toBe(2025);
    expect(cycleStartYear('2026-09-01')).toBe(2026);
    expect(cycleStartYear('2026-01-05')).toBe(2025);
  });

  it('checks real calendar dates', () => {
    expect(isValidYmd('2025-02-28')).toBe(true);
    expect(isValidYmd('2025-02-30')).toBe(false);
    expect(isValidYmd('9/14/2025')).toBe(false);
  });

  it('gives the Pacific date of a sent time', () => {
    // 03:00 UTC on Oct 5 is still the evening of Oct 4 in California
    expect(pacificDate('2026-10-05T03:00:00Z')).toBe('2026-10-04');
  });
});

describe('nextAnniversary', () => {
  it('crosses from December into January', () => {
    expect(nextAnniversary(entry({ targetDate: '2026-01-05' }), '2026-12-10')).toBe('2027-01-05');
  });

  it('falls back to the sent date', () => {
    expect(nextAnniversary(entry({ dateSent: '2025-10-04' }), '2026-09-20')).toBe('2026-10-04');
  });

  it('skips years already past, keeping the lookback', () => {
    expect(nextAnniversary(entry({ targetDate: '2023-10-01' }), '2026-10-06', 14)).toBe('2026-10-01');
    expect(nextAnniversary(entry({ targetDate: '2023-10-01' }), '2026-10-06', 0)).toBe('2027-10-01');
  });

  it('is null without a date', () => {
    expect(nextAnniversary(entry(), '2026-10-06')).toBeNull();
  });
});

describe('computeUpcoming', () => {
  const today = '2026-09-10';

  it('lists anniversaries in the window, soonest first', () => {
    const items = computeUpcoming([
      entry({ id: 'late', subject: 'Later', targetDate: '2025-10-16' }),
      entry({ id: 'soon', subject: 'Sooner', targetDate: '2025-09-15' }),
      entry({ id: 'far', subject: 'Far', targetDate: '2026-01-13' }),
    ], today, 42, 14);
    expect(items.map((i) => i.entry.id)).toEqual(['soon', 'late']);
    expect(items[0]).toMatchObject({ anniversary: '2026-09-15', daysUntil: 5, overdue: false });
  });

  it('includes a recently passed anniversary as overdue, but not one outside the lookback', () => {
    const items = computeUpcoming([
      entry({ id: 'recent', targetDate: '2025-09-01' }),
      entry({ id: 'old', targetDate: '2025-08-01' }),
    ], today, 42, 14);
    expect(items.map((i) => i.entry.id)).toEqual(['recent']);
    expect(items[0]).toMatchObject({ daysUntil: -9, overdue: true });
  });

  it('leaves out entries already continued or not repeating, but keeps nudged ones', () => {
    const items = computeUpcoming([
      entry({ id: 'continued', targetDate: '2025-09-20' }),
      entry({ id: 'this-year', targetDate: '2026-09-20', carriedFromId: 'continued' }),
      entry({ id: 'stopped', targetDate: '2025-09-20', notRepeating: true }),
      entry({ id: 'nudged', targetDate: '2025-09-20', nudges: [{ at: '2026-09-01T00:00:00Z', by: 'a@b.org', byName: 'A', to: ['x@y.org'] }] }),
      entry({ id: 'undated' }),
    ], today, 42, 14);
    expect(items.map((i) => i.entry.id)).toEqual(['nudged']);
  });
});

describe('mapAudienceToMethod', () => {
  it('tells the two Announce labels apart', () => {
    expect(mapAudienceToMethod(SINGULAR_AUDIENCE_LABEL)).toBe('Announce');
    expect(mapAudienceToMethod(NEWSLETTER_AUDIENCE_LABEL)).toBe('Newsletter');
    expect(mapAudienceToMethod(`${NEWSLETTER_AUDIENCE_LABEL}, ${SINGULAR_AUDIENCE_LABEL}, Allcom`)).toBe('Both');
  });

  it('uses the fallback for anything else', () => {
    expect(mapAudienceToMethod('Other: newsletter, announce')).toBe('N/A');
    expect(mapAudienceToMethod('Allcom', 'Announce')).toBe('Announce');
    expect(mapAudienceToMethod(undefined)).toBe('N/A');
  });
});

describe('validateEntryInput', () => {
  it('cleans a full entry', () => {
    const result = validateEntryInput({
      subject: '  Thank you Rangers ', link: 'https://example.org/msg', targetDate: '2025-09-15',
      method: 'Both', team: 'Council', contactEmails: 'A@Example.org, b@example.org; a@example.org', comments: 'HB',
    }, { partial: false });
    expect(result.error).toBeUndefined();
    expect(result.patch).toMatchObject({
      subject: 'Thank you Rangers', link: 'https://example.org/msg', targetDate: '2025-09-15', method: 'Both',
      contactEmails: ['a@example.org', 'b@example.org'],
    });
  });

  it('rejects bad input', () => {
    expect(validateEntryInput({ subject: '' }, { partial: false }).error).toMatch(/Subject/);
    expect(validateEntryInput({ subject: 'x', link: 'javascript:alert(1)' }, { partial: false }).error).toMatch(/link/);
    expect(validateEntryInput({ subject: 'x', targetDate: '2025-02-30' }, { partial: false }).error).toMatch(/targetDate/);
    expect(validateEntryInput({ subject: 'x', method: 'Fax' }, { partial: false }).error).toMatch(/method/);
    expect(validateEntryInput({ subject: 'x', cycleYear: '2025' }, { partial: false }).error).toMatch(/cycleYear/);
    expect(validateEntryInput({ subject: 'x', contactEmails: ['not-an-email'] }, { partial: false }).error).toMatch(/not-an-email/);
  });

  it('only touches the fields sent on update, and null clears one', () => {
    const result = validateEntryInput({ link: null, notRepeating: true }, { partial: true });
    expect(result.patch).toEqual({ link: null, notRepeating: true });
    const updated = applyPatch(entry({ link: 'https://example.org' }), result.patch!);
    expect(updated.link).toBeUndefined();
    expect(updated.notRepeating).toBe(true);
    expect(updated.subject).toBe('Ranger Satisfaction Survey');
  });
});

describe('duplicateKey', () => {
  it('matches the same subject in the same cycle, ignoring case', () => {
    expect(duplicateKey(entry({ subject: 'Thank You', targetDate: '2025-09-15' })))
      .toBe(duplicateKey(entry({ subject: ' thank you ', targetDate: '2026-02-01' })));
    expect(duplicateKey(entry({ subject: 'Thank You', targetDate: '2025-09-15' })))
      .not.toBe(duplicateKey(entry({ subject: 'Thank You', targetDate: '2026-09-15' })));
  });

  it('places an undated entry by its cycleYear, else by when it was added', () => {
    expect(duplicateKey(entry({ subject: '2026 Ranger Manual', cycleYear: 2025, createdAt: '2026-10-06T00:00:00Z' })))
      .toBe('2026 ranger manual|2025');
    expect(duplicateKey(entry({ subject: '2026 Ranger Manual', createdAt: '2026-10-06T00:00:00Z' })))
      .toBe('2026 ranger manual|2026');
  });
});

describe('buildNudgeEmail', () => {
  it('names last year\'s message and links to the request form', () => {
    const email = buildNudgeEmail(
      entry({ subject: 'Thank you Rangers', dateSent: '2025-09-17', targetDate: '2025-09-15', link: 'https://example.org/m' }),
      { name: 'Hazel', email: 'hb@example.org' },
      { frontendUrl: 'https://scrivenly.com/', today: '2026-09-01', note: 'Same as last year?' },
    );
    expect(email.subject).toBe('Planning ahead: "Thank you Rangers" for this year?');
    expect(email.text).toContain('Around this time last year (September 17, 2025), Council sent "Thank you Rangers" via Ranger Announce.');
    expect(email.text).toContain('around September 15, 2026');
    expect(email.text).toContain('https://scrivenly.com/comms-request');
    expect(email.text).toContain('Note from Hazel: Same as last year?');
    expect(email.html).toContain('<a href="https://scrivenly.com/comms-request">');
  });

  it('escapes what people typed', () => {
    const email = buildNudgeEmail(
      entry({ subject: '<script>alert(1)</script>', team: 'A & B' }),
      { name: '<b>x</b>', email: 'x@example.org' },
      { frontendUrl: 'https://scrivenly.com', today: '2026-09-01' },
    );
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('A &amp; B');
    expect(email.html).not.toContain('<b>x</b>');
  });
});
