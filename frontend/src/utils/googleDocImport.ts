import { detectDates } from './dateDetection';

/**
 * A message's Google Doc (its "mobilebasic" HTML) reduced to what Scribe keeps: the subject, the
 * body (between "Body:" and "DO NOT EDIT BELOW HERE" in the Comms request form; the whole document
 * when it has no Body), and when it went out ("Date to publish:"). Google's redirect links are
 * unwrapped. Formatting is inline in this HTML, so a paste-style import keeps it.
 */

export interface ParsedGoogleDoc {
  /** The "Subject:" line, without the label (empty when there's none). */
  subject: string;
  /** HTML of the body */
  bodyHtml: string;
  /** YYYY-MM-DD */
  publishedOn?: string;
  images: number;
  /** No "Body:" section: the whole document was kept */
  whole: boolean;
}

const text = (el: Element) => (el.textContent || '').replace(/\s+/g, ' ').trim();

function unwrapGoogleRedirect(href: string): string {
  try {
    const url = new URL(href);
    if (/(^|\.)google\.com$/.test(url.hostname) && url.pathname === '/url') return url.searchParams.get('q') || href;
  } catch {
    // keep it as it is
  }
  return href;
}

export function parseGoogleDoc(html: string, today: string): ParsedGoogleDoc {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach((el) => el.remove());
  doc.querySelectorAll('a[href]').forEach((a) => a.setAttribute('href', unwrapGoogleRedirect(a.getAttribute('href') || '')));
  const content = doc.querySelector('.doc-content') || doc.body;
  const blocks = Array.from(content.children);

  const bodyAt = blocks.findIndex((el) => /^body:?$/i.test(text(el)));
  let endAt = blocks.findIndex((el, i) => i > bodyAt && /DO NOT EDIT BELOW HERE/i.test(text(el)));
  if (endAt === -1) endAt = blocks.length;
  const subjectBlock = blocks.slice(0, bodyAt === -1 ? blocks.length : bodyAt).reverse().find((el) => /^subject:/i.test(text(el)));
  const subject = subjectBlock ? text(subjectBlock).replace(/^subject:\s*/i, '') : '';

  // "Date to publish:" is a label in the request form; the date follows it
  const paragraphs = Array.from(content.querySelectorAll('p')).map(text);
  const labelAt = paragraphs.findIndex((p) => /^date to publish:?/i.test(p));
  let publishedOn: string | undefined;
  if (labelAt !== -1) {
    const candidates = [paragraphs[labelAt].replace(/^date to publish:?/i, ''), ...paragraphs.slice(labelAt + 1, labelAt + 3)];
    for (const candidate of candidates) {
      const found = detectDates(candidate, today)[0];
      if (found?.yearCertain) {
        publishedOn = found.date;
        break;
      }
    }
  }

  const kept = bodyAt === -1 ? blocks : blocks.slice(bodyAt + 1, endAt);
  const wrapper = doc.createElement('div');
  kept.forEach((el) => wrapper.appendChild(el.cloneNode(true)));
  return {
    subject,
    bodyHtml: wrapper.innerHTML,
    ...(publishedOn ? { publishedOn } : {}),
    images: wrapper.querySelectorAll('img').length,
    whole: bodyAt === -1,
  };
}

/**
 * The script run in the sheet's tab (Google Sheets "htmlview", opened from Scribe): reads each row's
 * linked document as HTML, with its images inlined (they need the Google sign-in, so Scribe's server
 * can't fetch them), and posts them to the Scribe tab that opened it. Same-origin requests in
 * Google's tab, so they use that browser's Google sign-in; nothing goes through anyone else.
 */
/** `scribeOrigin`: the only page the documents are posted to. */
export const sheetHelperScript = (scribeOrigin: string) => `(async () => {
  const frame = document.querySelector('iframe');
  const sheet = frame ? frame.contentDocument : document;
  const unwrap = (h) => { try { const u = new URL(h); if (u.pathname === '/url') return u.searchParams.get('q') || h; } catch (e) {} return h; };
  const rows = [...sheet.querySelectorAll('tbody tr')].map((r) => { const td = r.querySelector('td'); const a = td && td.querySelector('a[href]'); return a ? { subject: td.innerText.trim(), link: unwrap(a.href) } : null; }).filter(Boolean);
  const docs = [];
  for (const row of rows) {
    const id = (row.link.match(/\\/document\\/(?:u\\/\\d+\\/)?d\\/([\\w-]+)/) || [])[1];
    if (!id) continue;
    const res = await fetch('https://docs.google.com/document/d/' + id + '/mobilebasic', { credentials: 'include' });
    if (!res.ok) continue;
    let html = await res.text();
    // Images need this browser's Google sign-in: bring each one along as a data: URL
    for (const src of new Set([...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]))) {
      try {
        const image = await fetch(src.replace(/&amp;/g, '&'), { credentials: 'include' });
        if (!image.ok) continue;
        const blob = await image.blob();
        const dataUrl = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
        html = html.split('src="' + src + '"').join('src="' + dataUrl + '"');
      } catch (e) {}
    }
    docs.push({ ...row, html });
  }
  window.opener.postMessage({ kind: 'scribe-docs-html', docs }, ${JSON.stringify(scribeOrigin)});
  document.title = 'Sent ' + docs.length + ' documents to Scribe';
})();`;
