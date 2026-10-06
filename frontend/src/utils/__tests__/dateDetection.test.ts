import { detectDates, rewriteDate, suggestDateName } from '../dateDetection';

const REF = '2026-10-06';
const one = (text: string, ref = REF) => {
  const found = detectDates(text, ref);
  expect(found).toHaveLength(1);
  return found[0];
};

describe('detectDates', () => {
  it('finds dates in many formats', () => {
    expect(one('due 8/16/2023.')).toMatchObject({ text: '8/16/2023', date: '2023-08-16', yearCertain: true });
    expect(one('September 1, 2026')).toMatchObject({ date: '2026-09-01' });
    expect(one('on 2026-09-01')).toMatchObject({ text: '2026-09-01', date: '2026-09-01' });
    expect(one('1 September 2026')).toMatchObject({ date: '2026-09-01' });
  });

  it('reads times and ranges', () => {
    expect(one('Join us 6pm - 10pm on Sept. 1 2026 at HQ')).toEqual({
      text: '6pm - 10pm on Sept. 1 2026', index: 8, date: '2026-09-01', startTime: '18:00', endTime: '22:00', yearCertain: true,
    });
    expect(one('Aug 26 - Sept 1, 2026')).toMatchObject({ date: '2026-08-26', endDate: '2026-09-01' });
  });

  it('places a date without a year near the reference date', () => {
    expect(one('Sept 1', '2027-06-01')).toMatchObject({ date: '2027-09-01', yearCertain: false });
  });

  it('ignores words that are not dates', () => {
    expect(detectDates('May we ask you on Friday, today or next week?', REF)).toEqual([]);
  });
});

describe('rewriteDate', () => {
  const next = { year: 2027, date: '2027-08-31', startTime: '18:00', endTime: '22:00' };

  it('keeps the style it was written in', () => {
    expect(rewriteDate(one('6pm - 10pm on Sept. 1 2026'), next)).toEqual({ text: '6pm - 10pm on Aug. 31 2027', timesDiffer: false });
    expect(rewriteDate(one('Tuesday, September 1, 2026'), next)?.text).toBe('Tuesday, August 31, 2027');
    expect(rewriteDate(one('Tue Sept 1st'), next)?.text).toBe('Tue Aug 31st');
    expect(rewriteDate(one('9/1/2026'), next)?.text).toBe('8/31/2027');
    expect(rewriteDate(one('09/01/26'), next)?.text).toBe('08/31/27');
    expect(rewriteDate(one('2026-09-01'), next)?.text).toBe('2027-08-31');
    expect(rewriteDate(one('1 September 2026'), next)?.text).toBe('31 August 2027');
    expect(rewriteDate(one('Sept. 1 2026'), { year: 2027, date: '2027-09-03' })?.text).toBe('Sept. 3 2027');
  });

  it('moves both ends of a range', () => {
    const found = one('Sun Aug 30 - Mon Sept 7, 2026');
    expect(rewriteDate(found, { year: 2027, date: '2027-08-29', endDate: '2027-09-06' })?.text).toBe('Sun Aug 29 - Mon Sept 6, 2027');
    // no end in the table: the written length is kept
    expect(rewriteDate(found, { year: 2027, date: '2027-08-29' })?.text).toBe('Sun Aug 29 - Mon Sept 6, 2027');
  });

  it('flags times that moved', () => {
    expect(rewriteDate(one('6pm - 10pm on Sept. 1 2026'), { ...next, endTime: '23:00' })?.timesDiffer).toBe(true);
  });
});

describe('suggestDateName', () => {
  const name = (text: string) => suggestDateName(text, detectDates(text, REF)[0]);

  it('uses the words before the date in its sentence', () => {
    expect(name('Hello Rangers! Claim your Ranger tickets by July 31st. See you soon.')).toBe('Claim your Ranger tickets');
    expect(name('Come to the Ranger Social, 6pm - 10pm on Sept. 1 2026 at HQ.')).toBe('Come to the Ranger Social');
    expect(name('The deadline is 8/16/2026')).toBe('The deadline');
  });

  it('uses the words after the date when there are none before it', () => {
    expect(name('July 31st: ticket deadline.')).toBe('Ticket deadline');
    expect(name('On Sept. 1 2026 the Ranger Social starts at 6pm')).toBe('The Ranger Social starts at 6pm');
  });

  it('is empty when the date stands alone', () => {
    expect(name('July 31st')).toBe('');
  });

  it('keeps each date to its own sentence', () => {
    const text = 'Tickets by July 12th. Vehicle passes by July 31st.';
    const second = detectDates(text, REF)[1];
    expect(suggestDateName(text, second)).toBe('Vehicle passes');
  });
});
