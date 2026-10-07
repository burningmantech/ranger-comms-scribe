import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from '@jest/globals';
import {
  buildNewsletterEmail,
  calendarEntries,
  calendarRowKey,
  editionSubject,
  formatCalendarDate,
  NewsletterEmailContext,
} from '../../src/services/newsletterEmail';
import { NewsletterEdition, NewsletterSection } from '../../src/types';

const FIXTURE = fs.readFileSync(path.join(__dirname, '../fixtures/announcementDocument.json'), 'utf8');
const PUBLIC_URL = 'https://dev.scrivenly.com/api';

const lexical = (text: string) => JSON.stringify({
  root: {
    type: 'root', version: 1, direction: null, format: '', indent: 0,
    children: [{
      type: 'paragraph', version: 1, direction: null, format: '', indent: 0,
      children: [{ type: 'text', version: 1, detail: 0, format: 0, mode: 'normal', style: '', text }],
    }],
  },
});

function section(overrides: Partial<NewsletterSection> = {}): NewsletterSection {
  return {
    id: 's1',
    kind: 'custom',
    heading: 'Join the Operators!',
    body: lexical('The Operator team is looking for a few good Rangers.'),
    photos: [],
    links: [],
    readMore: { kind: 'none' },
    keyDates: [],
    ...overrides,
  };
}

function edition(overrides: Partial<NewsletterEdition> = {}): NewsletterEdition {
  return {
    id: 'ed-1',
    number: 11,
    title: 'Black Rock Ranger News',
    tagline: 'All the Dust that Fits Under Your Hat',
    subject: 'Tickets & Stuff, Travel, and Opportunities!',
    sections: [section()],
    calendar: [],
    calendarHidden: [],
    status: 'draft',
    version: 1,
    approvals: [],
    comments: [],
    createdBy: 'x', createdAt: '', updatedBy: 'x', updatedAt: '',
    ...overrides,
  };
}

const ctx = (overrides: Partial<NewsletterEmailContext> = {}): NewsletterEmailContext => ({
  publicUrl: PUBLIC_URL,
  asOf: '2026-07-01',
  webUrl: 'https://dev.scrivenly.com/newsletter/11',
  archiveUrl: 'https://dev.scrivenly.com/newsletter',
  documentUrl: (id) => (id === 'doc-1' ? 'https://dev.scrivenly.com/news/claim-tickets-abc123' : null),
  ...overrides,
});

describe('newsletter email', () => {
  it('has the subject with the series and number, and the masthead and tagline', () => {
    const email = buildNewsletterEmail(edition(), ctx());
    expect(email.subject).toBe('Tickets & Stuff, Travel, and Opportunities! - Ranger News #11');
    expect(editionSubject({ subject: '  ', number: 12 })).toBe('Ranger News #12');
    expect(email.html).toContain('Black Rock<br>Ranger News');
    expect(email.html).toContain('All the Dust that Fits Under Your Hat • #11');
    expect(email.html).toContain('<title>Tickets &amp; Stuff, Travel, and Opportunities! - Ranger News #11</title>');
    expect(email.html).toContain('href="https://dev.scrivenly.com/newsletter/11"');
    expect(email.text.startsWith('BLACK ROCK RANGER NEWS\n\nAll the Dust that Fits Under Your Hat • #11')).toBe(true);
  });

  it('renders sections in order, with photos, credits, links and a Read more button', () => {
    const email = buildNewsletterEmail(edition({
      sections: [
        section({ id: 'a', heading: 'First' }),
        section({
          id: 'b',
          heading: 'Claim your tickets',
          important: true,
          body: FIXTURE,
          photos: [{ src: '/api/gallery/aurora.jpg', mediumSrc: '/api/gallery/aurora.jpg/medium', alt: 'Aurora over the playa', credit: 'Vader', caption: 'Juplaya' }],
          links: [{ label: 'Clubhouse', url: 'https://ranger-clubhouse.burningman.org' }],
          readMore: { kind: 'document', submissionId: 'doc-1' },
        }),
        section({ id: 'c', heading: 'Field Support', readMore: { kind: 'url', url: 'https://example.org/fs', label: 'Sign up' } }),
      ],
    }), ctx());

    const first = email.html.indexOf('>First</h2>');
    const second = email.html.indexOf('>Claim your tickets</h2>');
    const third = email.html.indexOf('>Field Support</h2>');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);

    // The medium image, absolute, no wider than the column, with its credit and caption
    expect(email.html).toContain('src="https://dev.scrivenly.com/api/gallery/aurora.jpg/medium"');
    expect(email.html).toMatch(/alt="Aurora over the playa" width="512"/); // inside the Important panel
    expect(email.html).toContain('Photo: Vader');
    expect(email.html).toContain('Juplaya');
    expect(email.html).toContain('href="https://ranger-clubhouse.burningman.org/"');
    expect(email.html).toContain('href="https://dev.scrivenly.com/news/claim-tickets-abc123"');
    expect(email.html).toContain('Read more &rarr;');
    expect(email.html).toContain('href="https://example.org/fs"');
    expect(email.html).toContain('Sign up &rarr;');
    // The Important panel
    expect(email.html).toContain('background-color:#fdf1e1');
    // The fixture's pending deletions are not sent
    expect(email.html).not.toContain('deleted-text');

    expect(email.text).toContain('CLAIM YOUR TICKETS');
    expect(email.text).toContain('[Juplaya — Photo: Vader]');
    expect(email.text).toContain('Read more: https://dev.scrivenly.com/news/claim-tickets-abc123');
    expect(email.text.indexOf('FIRST')).toBeLessThan(email.text.indexOf('FIELD SUPPORT'));
    expect(email.warnings).toEqual([]);
  });

  it('escapes text and drops unsafe URLs', () => {
    const email = buildNewsletterEmail(edition({
      subject: '<script>alert(1)</script>',
      tagline: '"quoted" & <b>',
      sections: [section({
        heading: '<img src=x onerror=alert(1)>',
        photos: [{ src: 'javascript:alert(1)', alt: '"><script>', credit: '<b>me</b>' }],
        links: [{ label: '<i>x</i>', url: 'javascript:alert(1)' }],
        readMore: { kind: 'url', url: 'data:text/html,hi' },
        keyDates: [{ date: '2026-07-12', label: '<script>', link: 'javascript:alert(1)' }],
      })],
    }), ctx());
    expect(email.html).not.toMatch(/<script/i);
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).not.toMatch(/javascript:/i);
    expect(email.html).not.toContain('data:text/html');
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(email.html).toContain('&quot;quoted&quot; &amp; &lt;b&gt;');
  });

  it('warns about a missing Read more page, an empty edition and a large email', () => {
    const missing = buildNewsletterEmail(edition({ sections: [section({ readMore: { kind: 'document', submissionId: 'nope' } })] }), ctx());
    expect(missing.warnings.join(' ')).toMatch(/no public page/);
    expect(missing.html).not.toContain('Read more &rarr;');

    expect(buildNewsletterEmail(edition({ sections: [], subject: '' }), ctx()).warnings)
      .toEqual(expect.arrayContaining(['The edition has no sections', 'The edition has no subject']));

    const long = 'x'.repeat(2000);
    const big = buildNewsletterEmail(edition({
      sections: Array.from({ length: 60 }, (_, i) => section({ id: `s${i}`, body: lexical(long) })),
    }), ctx());
    expect(big.sizeBytes).toBeGreaterThan(95 * 1024);
    expect(big.warnings.join(' ')).toMatch(/Gmail clips/);
  });

  it('lists the sections under "In this issue" from four sections', () => {
    const three = buildNewsletterEmail(edition({ sections: [1, 2, 3].map((i) => section({ id: `s${i}`, heading: `H${i}` })) }), ctx());
    expect(three.html).not.toContain('In this issue');
    const four = buildNewsletterEmail(edition({ sections: [1, 2, 3, 4].map((i) => section({ id: `s${i}`, heading: `H${i}` })) }), ctx());
    expect(four.html).toContain('In this issue');
    expect(four.html).toContain('<li style="margin:0 0 2px 0;">H4</li>');
  });
});

describe('newsletter calendar', () => {
  const base = edition({
    sections: [
      section({ id: 'a', keyDates: [
        { date: '2026-07-12', label: 'Claim your Ranger tickets and stuff', link: 'https://clubhouse.example', linkLabel: 'Clubhouse' },
        { date: '2026-06-01', label: 'Already past' },
      ] }),
      section({ id: 'b', keyDates: [{ date: '2026-07-12', label: 'Handle change deadline' }] }),
    ],
    calendar: [
      { id: 'm1', date: '2026-08-30', endDate: '2026-09-07', label: 'Burning Man!' },
      // The same row as a section's: one row, the manual one
      { id: 'm2', date: '2026-07-12', label: 'claim your ranger tickets and stuff' },
    ],
  });

  it('merges, de-duplicates, sorts and drops past rows', () => {
    const rows = calendarEntries(base, '2026-07-01');
    expect(rows.map((r) => r.label)).toEqual([
      'claim your ranger tickets and stuff',
      'Handle change deadline',
      'Burning Man!',
    ]);
    expect(rows[0].source).toBe('manual');
    expect(calendarEntries(base, '2026-07-01', { includePast: true }).map((r) => r.label)).toContain('Already past');
  });

  it('leaves out hidden section rows', () => {
    const hidden = { ...base, calendarHidden: [calendarRowKey({ date: '2026-07-12', label: 'Handle change deadline' })] };
    expect(calendarEntries(hidden, '2026-07-01').map((r) => r.label)).not.toContain('Handle change deadline');
  });

  it('formats dates in house style', () => {
    expect(formatCalendarDate('2026-07-12', undefined, '2026-07-01')).toBe('July 12th');
    expect(formatCalendarDate('2026-07-01', undefined, '2026-07-01')).toBe('July 1st');
    expect(formatCalendarDate('2026-07-22', undefined, '2026-07-01')).toBe('July 22nd');
    expect(formatCalendarDate('2026-07-13', undefined, '2026-07-01')).toBe('July 13th');
    expect(formatCalendarDate('2026-08-30', '2026-09-07', '2026-07-01')).toBe('August 30 – September 7');
    expect(formatCalendarDate('2026-07-12', '2026-07-14', '2026-07-01')).toBe('July 12–14');
    expect(formatCalendarDate('2027-01-03', undefined, '2026-07-01')).toBe('January 3rd, 2027');
    expect(formatCalendarDate('2026-12-30', '2027-01-02', '2026-07-01')).toBe('December 30 – January 2, 2027');
  });

  it('renders the "Mark your calendar!" table and its text', () => {
    const email = buildNewsletterEmail(base, ctx());
    expect(email.html).toContain('Mark your calendar!');
    expect(email.html).toContain('August 30 – September 7');
    expect(email.html).toContain('href="https://clubhouse.example/"');
    expect(email.html).not.toContain('Already past');
    expect(email.text).toContain('MARK YOUR CALENDAR!\n- July 12th: claim your ranger tickets and stuff');
    expect(buildNewsletterEmail(edition(), ctx()).html).not.toContain('Mark your calendar!');
  });
});
