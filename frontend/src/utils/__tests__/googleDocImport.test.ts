import { parseGoogleDoc, sheetHelperScript } from '../googleDocImport';

const doc = (content: string) => `<html><head><style>.c1{font-weight:700}</style></head><body><div class="doc-content">${content}</div></body></html>`;

describe('parseGoogleDoc', () => {
  const form = doc(`
    <p><span>Requested by:</span></p>
    <table><tr><td><p><span>Date to publish:</span></p></td><td><p><span>2026-08-12</span></p></td></tr></table>
    <p><span>Subject: Reminder about Ranger Social</span></p>
    <p><span>Body:</span><span> </span></p>
    <p><span style="font-weight:700">Save the date:</span><span> the Tuesday Ranger Social, on September 1, at 5 pm.</span></p>
    <p><a href="https://www.google.com/url?q=https://rangers.burningman.org/social&amp;sa=D">More</a><img src="https://lh7-rt.googleusercontent.com/docsz/abc" style="width: 300px"></p>
    <p><span>DO NOT EDIT BELOW HERE</span></p>
    <p><span>Internal notes</span></p>
  `);

  it('keeps the subject, the body (formatted) and when it went out', () => {
    const parsed = parseGoogleDoc(form, '2026-10-06');
    expect(parsed.subject).toBe('Reminder about Ranger Social');
    expect(parsed.publishedOn).toBe('2026-08-12');
    expect(parsed.whole).toBe(false);
    expect(parsed.images).toBe(1);
    expect(parsed.bodyHtml).toContain('font-weight:700');
    expect(parsed.bodyHtml).toContain('Ranger Social, on September 1');
    expect(parsed.bodyHtml).toContain('href="https://rangers.burningman.org/social"');
    expect(parsed.bodyHtml).not.toContain('Requested by');
    expect(parsed.bodyHtml).not.toContain('Internal notes');
  });

  it('keeps the whole document when there is no Body section', () => {
    const parsed = parseGoogleDoc(doc('<h1>2026 Ranger Manual</h1><p>Chapter one</p>'), '2026-10-06');
    expect(parsed).toMatchObject({ subject: '', whole: true, images: 0 });
    expect(parsed.publishedOn).toBeUndefined();
    expect(parsed.bodyHtml).toContain('Chapter one');
  });

  it('posts the documents, images inlined, only to the Scribe page that opened the sheet', () => {
    const script = sheetHelperScript('https://app.scrivenly.com');
    expect(script).toContain(`postMessage({ kind: 'scribe-docs-html', docs }, "https://app.scrivenly.com")`);
    expect(script).toContain('readAsDataURL');
    expect(() => new Function(script)).not.toThrow(); // it parses
  });
});
