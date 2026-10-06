import { parseCsv } from '../csv';
import { mapColumns, normalizeMethod, parseSheetDate, sheetToEntries } from '../commsCalendarImport';

describe('parseSheetDate', () => {
  it('puts Sep–Dec in the cycle start year and Jan–Aug in the next', () => {
    expect(parseSheetDate('Sep-14', 2025)).toEqual({ date: '2025-09-14' });
    expect(parseSheetDate('Jan-13', 2025)).toEqual({ date: '2026-01-13' });
    expect(parseSheetDate('Aug-17', 2025)).toEqual({ date: '2026-08-17' });
  });

  it('reads the other common formats', () => {
    expect(parseSheetDate('Sept 28', 2025).date).toBe('2025-09-28');
    expect(parseSheetDate('September 14, 2024', 2025).date).toBe('2024-09-14');
    expect(parseSheetDate('14-Sep', 2025).date).toBe('2025-09-14');
    expect(parseSheetDate('9/14', 2025).date).toBe('2025-09-14');
    expect(parseSheetDate('9/14/24', 2025).date).toBe('2024-09-14');
    expect(parseSheetDate('2026-03-04', 2025).date).toBe('2026-03-04');
  });

  it('treats blank and N/A as no date', () => {
    expect(parseSheetDate('', 2025)).toEqual({});
    expect(parseSheetDate('N/A', 2025)).toEqual({});
    expect(parseSheetDate('TBD', 2025)).toEqual({});
  });

  it('warns about anything that is not a date', () => {
    expect(parseSheetDate('Sent by VCs', 2025)).toEqual({ warning: '"Sent by VCs" is not a date' });
    expect(parseSheetDate('Feb-30', 2025).warning).toBeDefined();
  });

  it('moves Feb 29 to Feb 28 when the year has none', () => {
    expect(parseSheetDate('Feb-29', 2025)).toEqual({ date: '2026-02-28', warning: '2026 has no Feb 29; using Feb 28' });
    expect(parseSheetDate('Feb-29', 2027)).toEqual({ date: '2028-02-29' });
  });
});

describe('normalizeMethod', () => {
  it('reads the sheet values', () => {
    expect(normalizeMethod('Announce')).toEqual({ method: 'Announce' });
    expect(normalizeMethod(' newsletter ')).toEqual({ method: 'Newsletter' });
    expect(normalizeMethod('Both')).toEqual({ method: 'Both' });
    expect(normalizeMethod('N/A')).toEqual({ method: 'N/A' });
    expect(normalizeMethod('')).toEqual({ method: 'N/A' });
    expect(normalizeMethod('Carrier pigeon')).toEqual({ method: 'N/A', warning: 'Unknown method "Carrier pigeon"; using N/A' });
  });
});

describe('mapColumns', () => {
  it('matches the spreadsheet headers', () => {
    expect(mapColumns([
      'Email subject', 'Target send date', 'Method of Publishinig', 'Date sent', 'Responsible Team',
      'Related milestone/Comments', 'Link', 'Contact emails',
    ])).toEqual({
      subject: 0, targetDate: 1, method: 2, dateSent: 3, team: 4, comments: 5, link: 6, contactEmails: 7,
    });
  });
});

describe('sheetToEntries', () => {
  const csv = [
    'Email subject,Target send date,Method of Publishinig,Date sent,Responsible Team,Related milestone/Comments',
    'Ranger Satisfaction Survey,Sep-14,N/A,Sep-18,Council,',
    '"Join the Black Rock Rangers at San Francisco Decompression 2026!",Sep-15,Both,Oct-04,Council,"Ready for Newsletter. HB 10/4"',
    'Year- Round Ranger Communication Channels,Sep-30,N/A,Sent by VCs,Volunteer Coordinators,"Nudge sent Sep 15, HB"',
    '2026 Ranger Manual,,N/A,,,',
    'Ranger Appreciation Ticket is Now Available,Jan-13,Both,,Volunteer Coordinators,',
    ',,,,,',
    ',Mar-04,Both,,Intake Manager,',
  ].join('\n');

  it('turns spreadsheet rows into entries', () => {
    const sheet = sheetToEntries(parseCsv(csv), 2025);
    expect(sheet.error).toBeUndefined();
    expect(sheet.rows).toHaveLength(6);

    expect(sheet.rows[0]).toEqual({
      line: 2,
      input: {
        subject: 'Ranger Satisfaction Survey', targetDate: '2025-09-14', dateSent: '2025-09-18',
        method: 'N/A', team: 'Council', comments: '', contactEmails: [],
      },
      warnings: [],
    });
    expect(sheet.rows[1].input).toMatchObject({ method: 'Both', dateSent: '2025-10-04', comments: 'Ready for Newsletter. HB 10/4' });
    // No dates: it still belongs to the sheet's cycle
    expect(sheet.rows[3].input).toMatchObject({ subject: '2026 Ranger Manual', cycleYear: 2025 });
    expect(sheet.rows[3].input.targetDate).toBeUndefined();
    expect(sheet.rows[0].input.cycleYear).toBeUndefined();
    expect(sheet.rows[4].input.targetDate).toBe('2026-01-13');
  });

  it('keeps notes typed in a date column as comments', () => {
    const row = sheetToEntries(parseCsv(csv), 2025).rows[2];
    expect(row.input.dateSent).toBeUndefined();
    expect(row.input.comments).toBe('Nudge sent Sep 15, HB; Date sent: Sent by VCs');
    expect(row.warnings).toEqual(['Date sent: "Sent by VCs" is not a date']);
  });

  it('flags rows without a subject', () => {
    const row = sheetToEntries(parseCsv(csv), 2025).rows[5];
    expect(row.input.subject).toBe('');
    expect(row.warnings).toContain('No subject; this row will be skipped');
  });

  it('reads links and contacts when the sheet has them', () => {
    const sheet = sheetToEntries(parseCsv(
      'Subject,Link,Contacts\nA,https://example.org/a,"one@example.org, Two@Example.org"\nB,not a link,nobody\n',
    ), 2025);
    expect(sheet.rows[0].input).toMatchObject({ link: 'https://example.org/a', contactEmails: ['one@example.org', 'two@example.org'] });
    expect(sheet.rows[1].input.link).toBeUndefined();
    expect(sheet.rows[1].input.contactEmails).toEqual([]);
    expect(sheet.rows[1].warnings).toEqual(['Link "not a link" is not a web address', 'Not email addresses: nobody']);
  });

  it('needs a subject column', () => {
    expect(sheetToEntries(parseCsv('Date,Team\nSep-14,Council\n'), 2025).error).toMatch(/subject/i);
  });
});
