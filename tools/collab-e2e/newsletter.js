// The newsletter end to end on a local stack (dev bypass): a Member asks for a newsletter
// item in the request form; a second request asks Comms to write the blurb; both are approved;
// the Comms Cadre build edition #N from the tray, write the missing blurb, add their own photo
// section and a calendar row, get it approved, send a test and send it; the public archive,
// edition and Read more pages work signed out; the request's review page shows where it went.
//
// Run the backend with ANNOUNCE_EMAIL_TO set and SES pointed at a fake (nothing is sent), e.g.
//   AWS_ENDPOINT_URL_SESV2=http://localhost:4599 AWS_ACCESS_KEY_ID=fake AWS_SECRET_ACCESS_KEY=fake
// Screenshots go to E2E_SHOTS (default ./shots-newsletter). PHOTO: a JPEG to upload.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const API = process.env.E2E_API_URL || 'http://localhost:8080/api';
const APP = process.env.E2E_APP_URL || 'http://localhost:3000';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.E2E_SHOTS || path.join(__dirname, 'shots-newsletter');
const PHOTO = process.env.PHOTO;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

async function api(p, { method = 'GET', body, session = 'dev-admin-session' } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${text}`);
  return data;
}

const lexical = (text) => JSON.stringify({ root: { type: 'root', version: 1, format: '', indent: 0, direction: 'ltr', children: [
  { type: 'paragraph', version: 1, format: '', indent: 0, direction: 'ltr', children: [{ type: 'text', version: 1, text, format: 0, style: '', mode: 'normal', detail: 0 }] },
] } });

async function shot(page, name, options = {}) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, ...options });
}

async function signIn(context, session) {
  const page = await context.newPage();
  page.on('pageerror', (err) => console.log(`  pageerror: ${err.message}`));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const me = await api('/auth/me', { session });
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s, u) => {
    localStorage.setItem('sessionId', s);
    localStorage.setItem('user', JSON.stringify(u));
  }, session, me.user);
  return page;
}

/** Click the first `selector` whose text includes `text`. */
async function clickText(page, selector, text) {
  await page.waitForFunction((sel, t) => [...document.querySelectorAll(sel)].some((el) => el.textContent.includes(t) && !el.disabled), { timeout: 15000 }, selector, text);
  await page.evaluate((sel, t) => [...document.querySelectorAll(sel)].find((el) => el.textContent.includes(t) && !el.disabled).click(), selector, text);
}

/** Set an input's value the way React sees it (date inputs can't be typed into reliably). */
async function setValue(page, selector, value) {
  await page.waitForSelector(selector);
  await page.evaluate((sel, v) => {
    const el = document.querySelector(sel);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
}

async function typeInEditor(page, selector, text) {
  await page.waitForSelector(selector);
  await page.click(selector);
  await page.keyboard.type(text, { delay: 2 });
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1440,1000'],
    defaultViewport: { width: 1440, height: 1000 },
  });
  try {
    // ---- 1. A Member asks for a newsletter item -------------------------------------
    const memberContext = await browser.createBrowserContext();
    const member = await signIn(memberContext, 'dev-member-session');
    await member.goto(`${APP}/comms-request`, { waitUntil: 'networkidle0' });
    const subject = `Register to Camp by July 12th (${Date.now() % 10000})`;
    await member.type('[name=suggestedSubjectLine]', subject);
    await member.type('[name=description]', 'Camping registration deadline');
    await typeInEditor(member, '.wizard-main .editor-input', 'Everyone who is planning to camp with Rangers needs to fill out a registration form by July 12th.');
    await member.type('[name=signatureText]', 'Thanks, Ranger Logistics');
    await clickText(member, 'button', 'Next');
    await member.waitForSelector('.audience-card');
    await clickText(member, '.audience-card', 'Newsletter');
    await clickText(member, '.audience-card', 'Singular');
    await member.waitForSelector('#nl-headline');
    await member.type('#nl-headline', 'Important: Register to Camp by July 12th');
    await typeInEditor(member, '.nl-panel .nl-blurb-editor .editor-input', 'Everyone camping with Rangers needs to register by July 12th, including pre and post event at Tokyo.');
    if (PHOTO) {
      const input = await member.$('.nl-panel [data-testid=photo-input]');
      await input.uploadFile(PHOTO);
      await member.waitForSelector('.nl-panel .nl-photo-row', { timeout: 30000 });
      await member.type('.nl-panel .nl-photo-row input[placeholder^="e.g. A purple"]', 'A blue gradient');
      await member.type('.nl-panel .nl-photo-row input[placeholder="e.g. Vader"]', 'Vader');
    }
    await clickText(member, '.nl-panel button', '+ Add a link');
    await member.type('[aria-label="Link 1 text"]', 'Ranger Camping Registration');
    await member.type('[aria-label="Link 1 address"]', 'https://example.org/camping');
    await member.click('input[name=nl-read-more]:nth-of-type(1)');
    await member.evaluate(() => [...document.querySelectorAll('input[name=nl-read-more]')][1].click());
    await member.type('[name=owner]', 'Logistics');
    await member.type('[name=replyToAddress]', 'logistics@example.org');
    await clickText(member, 'button', '+ Add a date');
    await setValue(member, '[aria-label="Key date 1"]', '2027-07-12');
    await member.type('[aria-label="Key date 1 description"]', 'Deadline to register to camp');
    await shot(member, '01-request-form-newsletter');
    await clickText(member, 'button', 'Next');
    await member.waitForFunction(() => document.querySelector('.step-circle.active')?.textContent === '3', { timeout: 10000 });
    await clickText(member, 'label', "I don't know who should approve this");
    await clickText(member, 'button', 'Submit Request');
    await member.waitForFunction(() => document.body.innerText.includes('Request Submitted!'), { timeout: 15000 });
    check(true, 'the member submitted a request with a newsletter item');

    // ---- 2. A second request asks Comms to write the blurb; approve both ------------------
    const all = await api('/content/submissions');
    const first = all.find((s) => s.title === subject);
    check(!!first && (first.newsletter?.blurb || '').includes('"Everyone camping with Rangers needs to register by July 12th'),
      'the blurb arrived as typed (the editor kept the caret)');
    check(!!first && first.newsletter?.readMore?.kind === 'document' && first.keyDates?.length === 1 && (first.newsletter.photos.length === (PHOTO ? 1 : 0)),
      'the request stored the newsletter item, its photo and key date');
    const second = await api('/content/submissions', {
      method: 'POST',
      session: 'dev-member-session',
      body: {
        title: 'Field Support Needs You', content: lexical('Come see the far reaches of BRC in our pickup trucks.'), status: 'in_review',
        audiences: ['newsletter'], writingHelp: { blurb: true },
        newsletter: { photos: [], links: [{ label: 'Sign up in the Clubhouse', url: 'https://example.org/clubhouse' }], readMore: { kind: 'none' } },
        keyDates: [{ date: '2027-08-15', label: 'Field Support training' }],
      },
    });
    for (const id of [first.id, second.id]) {
      await api(`/content/submissions/${id}/override-approve`, { method: 'POST', body: { confirm: true, reason: 'e2e' } });
    }

    // ---- 3. The Comms Cadre build the edition ----------------------------------------
    const cadreContext = await browser.createBrowserContext();
    const cadre = await signIn(cadreContext, 'dev-user2-session');
    await cadre.goto(`${APP}/newsletter/editions`, { waitUntil: 'networkidle0' });
    const nextNumber = Number((await cadre.$eval('.nle-new-label', (el) => el.textContent)).match(/#(\d+)/)[1]);
    await cadre.type('#nle-new-subject', 'Camping, Field Support and the Aurora');
    await clickText(cadre, 'button', 'New edition');
    await cadre.waitForFunction(() => /\/newsletter\/editions\/[0-9a-f-]+$/.test(location.pathname), { timeout: 15000 });
    const editionId = cadre.url().split('/').pop();
    await cadre.waitForSelector('.nle-topbar h1');

    await clickText(cadre, '.nle-tabs button', 'Add from requests');
    await cadre.waitForSelector('.nle-tray-item');
    check(await cadre.evaluate(() => document.body.innerText.includes('Needs a blurb written')), 'the tray flags the request that needs a blurb');
    await shot(cadre, '02-editor-tray');
    for (let i = 1; i <= 2; i++) {
      await clickText(cadre, '.nle-tray-item button', 'Add');
      await cadre.waitForFunction((n) => document.querySelectorAll('.nle-section').length === n, { timeout: 15000 }, i);
    }
    // Write the blurb Comms was asked for (section 2 starts from the request's full text)
    await typeInEditor(cadre, '.nle-section:nth-of-type(2) .nl-blurb-editor .editor-input', ' Any Ranger can sign up: no prerequisites.');
    // Their own photo section
    await clickText(cadre, 'button', '+ Add your own section');
    await cadre.waitForFunction(() => document.querySelectorAll('.nle-section').length === 3);
    await cadre.type('.nle-section:nth-of-type(3) .nle-section-body input.form-control', '4th of Juplaya');
    await typeInEditor(cadre, '.nle-section:nth-of-type(3) .nl-blurb-editor .editor-input', 'The Aurora Borealis gave us a show at Juplaya!');
    if (PHOTO) {
      const input = await cadre.$('.nle-section:nth-of-type(3) [data-testid=photo-input]');
      await input.uploadFile(PHOTO);
      await cadre.waitForSelector('.nle-section:nth-of-type(3) .nl-photo-row', { timeout: 30000 });
      await cadre.type('.nle-section:nth-of-type(3) .nl-photo-row input[placeholder="e.g. Vader"]', 'Vader');
    }
    // A standing calendar row (rows still ahead carry over from the last edition, so on a
    // stack that already sent one, "Burning Man!" may be here already)
    const carried = await cadre.$$eval('[aria-label^="Calendar event"]', (els) => els.map((el) => el.value));
    if (!carried.includes('Burning Man!')) {
      await clickText(cadre, '.nle-calendar button', '+ Add a date');
      const row = carried.length + 1;
      await setValue(cadre, `[aria-label="Calendar date ${row}"]`, '2027-08-30');
      await setValue(cadre, `[aria-label="Calendar date ${row} end"]`, '2027-09-07');
      await cadre.type(`[aria-label="Calendar event ${row}"]`, 'Burning Man!');
    } else {
      check(true, 'a standing calendar row carried over from the last edition');
    }
    await cadre.waitForFunction(() => document.querySelector('.nle-save')?.textContent === 'All changes saved', { timeout: 20000 });
    await sleep(1500); // the preview reloads after the save
    await clickText(cadre, '.nle-tabs button', 'Preview');
    await cadre.waitForSelector('.nle-preview-frame');
    await sleep(1500);
    await shot(cadre, '03-editor');

    let view = await api(`/newsletter/editions/${editionId}`, { session: 'dev-user2-session' });
    check(view.edition.sections.length === 3, 'the edition has three sections');
    check(view.calendar.map((r) => r.label).join('|') === 'Deadline to register to camp|Field Support training|Burning Man!',
      `the calendar merges the requests' dates and the manual row (${view.calendar.map((r) => r.label).join('|')})`);
    check(view.edition.sections[1].body.includes('no prerequisites'), 'the blurb written by the cadre was saved');

    // ---- 4. Approval ------------------------------------------------------------------
    await clickText(cadre, 'button', 'Ask for approval');
    await cadre.waitForFunction(() => document.body.innerText.includes('Approvers have been notified'));
    await clickText(cadre, '.nle-actions button', 'Approve');
    await cadre.waitForFunction(() => document.querySelector('.nle-gate.met')?.textContent.includes('Comms Cadre'), { timeout: 10000 });
    view = await api(`/newsletter/editions/${editionId}`, { session: 'dev-user2-session' });
    check(view.edition.status === 'in_review' && view.approval.commsCadre.met && !view.approval.commsManager.met,
      'a Comms Cadre approval alone leaves it in review');
    await api(`/newsletter/editions/${editionId}/override-approve`, { method: 'POST', body: { reason: 'e2e: no Communications Manager in the dev users', version: view.edition.version } });
    await cadre.reload({ waitUntil: 'networkidle0' });
    await cadre.waitForSelector('.nle-send');
    await sleep(2500); // longer than the autosave delay
    const afterReload = await api(`/newsletter/editions/${editionId}`, { session: 'dev-user2-session' });
    check(afterReload.edition.status === 'approved' && await cadre.$eval('.nle-save', (el) => el.textContent) === 'All changes saved',
      'opening the approved edition saves nothing and keeps it approved');
    await shot(cadre, '04-editor-approved', { fullPage: false });

    // ---- 5. Test send and send ----------------------------------------------------------
    await clickText(cadre, 'button', 'Send test to me');
    await cadre.waitForFunction(() => document.body.innerText.includes('Test sent to user2@localhost'), { timeout: 15000 });
    check(true, 'test send went to the signed-in cadre member');
    await cadre.click('.nle-send');
    await clickText(cadre, '.request-changes-dialog button', 'Send now');
    await cadre.waitForFunction(() => document.querySelector('.nl-badge-sent'), { timeout: 20000 });
    view = await api(`/newsletter/editions/${editionId}`, { session: 'dev-user2-session' });
    check(view.edition.status === 'sent', `edition #${view.edition.number} is sent`);
    check(view.edition.number === nextNumber, `it kept the number it started with (#${nextNumber})`);

    // ---- 6. Public pages, signed out -----------------------------------------------------
    const publicContext = await browser.createBrowserContext();
    const reader = await publicContext.newPage();
    await reader.goto(`${APP}/newsletter`, { waitUntil: 'networkidle0' });
    check(await reader.evaluate((n) => document.body.innerText.includes(`#${n}`), nextNumber), 'the public archive lists the edition');
    await shot(reader, '05-public-archive');
    await reader.goto(`${APP}/newsletter/${nextNumber}`, { waitUntil: 'networkidle0' });
    await reader.waitForSelector('iframe.public-news-frame');
    await sleep(1500);
    const frameText = await reader.$eval('iframe.public-news-frame', (f) => f.contentDocument.body.innerText);
    check(frameText.includes('Mark your calendar!') && frameText.includes('4th of Juplaya') && frameText.includes('Photo: Vader'), 'the public edition shows the sections, photo credit and calendar');
    await shot(reader, '06-public-edition');
    await reader.setViewport({ width: 390, height: 844, isMobile: true });
    await reader.reload({ waitUntil: 'networkidle0' });
    await sleep(1500);
    await shot(reader, '07-public-edition-mobile');
    const stored = await api(`/content/submissions/${first.id}`);
    await reader.setViewport({ width: 1440, height: 1000 });
    await reader.goto(`${APP}/news/${stored.publicSlug}`, { waitUntil: 'networkidle0' });
    await reader.waitForSelector('iframe.public-news-frame');
    const docText = await reader.$eval('iframe.public-news-frame', (f) => f.contentDocument.body.innerText);
    check(docText.includes('fill out a registration form'), 'the Read more page shows the full announcement');
    await shot(reader, '08-public-read-more');

    // ---- 7. The request knows where it went -----------------------------------------------
    check(stored.newsletterSentIn === nextNumber && stored.status === 'approved', 'the request records the issue and still awaits its singular send');
    const secondStored = await api(`/content/submissions/${second.id}`);
    check(secondStored.status === 'sent', 'the newsletter-only request is done');
    await member.goto(`${APP}/tracked-changes/${first.id}`, { waitUntil: 'networkidle0' });
    await member.waitForSelector('.nl-review-panel', { timeout: 20000 });
    check(await member.$eval('.nl-review-panel', (el, n) => el.innerText.includes(`Sent in Ranger News #${n}`), nextNumber), 'the review page shows the issue it went out in');
    const panel = await member.$('.nl-review-panel');
    await panel.screenshot({ path: path.join(SHOTS, '09-review-panel.png') });
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
