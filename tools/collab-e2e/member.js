// A Member (userType 'Member', the Rangers who submit content) uses the app end to end, as
// the dev-bypass user dev-member (session 'dev-member-session'):
//
//   1. /requests loads without a redirect loop (a Member used to bounce between /requests
//      and / forever) and shows the submitter dashboard, not the reviewer queue.
//   2. The member creates a request through the New Request form (/comms-request).
//   3. On /tracked-changes/:id the editor loads, the member (the author) can type, and the
//      save status reaches "Saved". The member sees no "Finish review" menu.
//   4. dev-user2 (CommsCadre reviewer), in a second browser, sees the member's edit as a
//      card and rejects it; the member's card disappears live.
//
// Fails on any console error in either browser (they are all printed), and prints every
// failed (4xx/5xx) API response the pages got.
//
// Dev-fixture limit: the form checks the (read-only) Email field with zod's email(), which
// rejects 'member@localhost' (no TLD). The script puts 'member@example.com' in that one
// field so the form can go on; the field is not sent with the request.
const L = require('./lib');

const MEMBER_SESSION = 'dev-member-session';
const REVIEWER_SESSION = 'dev-user2-session';
const SIDEBAR = '.editor-sidebar';
const TOGGLE = '.finish-review__toggle';
const SUBJECT = `Member e2e ${new Date().toISOString()}`;
const DRAFT = 'Member draft paragraph for the e2e test.';
const TYPED = ' Member edit.';

const results = [];
const notes = []; // things worth knowing that don't fail the run
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  return !!ok;
}

/** Resolves with `promise`, or with `fallback` after `ms` (a looping page can hang evaluate). */
function within(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

/** Console errors, page errors and failed API responses of a page, kept on `user`. */
function watch(user) {
  const { page } = user;
  page.on('console', (msg) => { if (msg.type() === 'error') user.errors.push(msg.text()); });
  page.on('pageerror', (err) => user.errors.push(`pageerror: ${err.message}`));
  page.on('dialog', (d) => { if (d.type() === 'beforeunload') d.accept().catch(() => {}); });
  page.on('response', (res) => {
    if (res.status() >= 400 && res.url().includes('/api/')) {
      user.failed.push(`${res.status()} ${res.request().method()} ${res.url().replace(/^https?:\/\/[^/]+/, '')}`);
    }
  });
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/tracked-changes\/submission\/[^/]+$/.test(req.url())) user.changePosts.push(req.url());
  });
}

/** The member in its own browser context, signed in (localStorage) but not yet on a page. */
async function openMember(browser) {
  const me = await L.api('/auth/me', { session: MEMBER_SESSION });
  if (!me.user || me.user.id !== 'dev-member' || me.user.userType !== 'Member') {
    throw new Error(`/auth/me for ${MEMBER_SESSION} is not the dev member: ${JSON.stringify(me)} (is the backend new enough?)`);
  }
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const user = { name: 'member', page, context, errors: [], failed: [], changePosts: [], navs: 0 };
  watch(user);
  // Count client-side navigations (react-router's Navigate uses history.replaceState) and
  // main-frame navigations: a redirect loop shows up as a fast-growing count.
  await page.evaluateOnNewDocument(() => {
    window.__navs = [];
    for (const fn of ['pushState', 'replaceState']) {
      const native = history[fn].bind(history);
      history[fn] = (state, title, url) => { window.__navs.push(String(url)); return native(state, title, url); };
    }
  });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) user.navs++; });
  await page.goto(`${L.APP}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s, u) => {
    localStorage.setItem('sessionId', s);
    localStorage.setItem('user', JSON.stringify(u));
    localStorage.removeItem('commsRequestDraft');
  }, MEMBER_SESSION, me.user);
  return user;
}

/** Step 1: /requests loads once, no loop. Returns false when the page loops (the rest is moot). */
async function checkRequests(m) {
  m.navs = 0;
  await m.page.goto(`${L.APP}/requests`, { waitUntil: 'domcontentloaded' });
  await L.sleep(3000);
  const state = await within(m.page.evaluate(() => ({
    navs: window.__navs.length,
    sample: window.__navs.slice(0, 6),
    path: location.pathname,
    requestsUi: !!document.querySelector('.content-management'),
    submitter: !!document.querySelector('.submitter-dashboard'),
    reviewer: !!document.querySelector('.reviewer-dashboard, .queue-nav'),
  })), 5000, null);
  if (!state) {
    check('/requests: page responds (no redirect loop)', false, 'page.evaluate hung for 5 s: the renderer is stuck, most likely in a redirect loop');
    return false;
  }
  const noLoop = check('/requests: no redirect loop', state.navs <= 10 && m.navs <= 10,
    `${state.navs} history navigations, ${m.navs} frame navigations in 3 s; first: ${JSON.stringify(state.sample)}`);
  check('/requests: stays on /requests', state.path === '/requests', state.path);
  check('/requests: shows the requests UI', state.requestsUi);
  check('/requests: a Member gets the submitter dashboard, not the reviewer queue', state.submitter && !state.reviewer);
  return noLoop && state.path === '/requests' && state.requestsUi;
}

/** Sets an input's value the way React sees a user's typing (for the read-only Email field). */
async function setReactValue(page, selector, value) {
  await page.$eval(selector, (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

const activeStep = (page) => page.$eval('.step-circle.active', (e) => Number(e.textContent)).catch(() => null);

async function clickNext(page) {
  const from = await activeStep(page);
  await page.click('.wizard-nav .btn-next');
  await L.sleep(400);
  const to = await activeStep(page);
  const errors = await page.$$eval('.field-error', (els) => els.filter((e) => e.offsetParent).map((e) => e.textContent));
  if (to !== from + 1) throw new Error(`form did not advance from step ${from}: ${JSON.stringify(errors)}`);
  if (errors.length) notes.push(`form step ${to} opened showing ${JSON.stringify(errors)}`);
}

/** Step 2: the New Request form. Returns the new submission's id (from the server's reply). */
async function createRequest(m) {
  const { page } = m;
  await page.click('.floating-action-button');
  await page.waitForSelector('.comms-wizard', { timeout: 10000 });
  check('New Request: the form opens from /requests', page.url().endsWith('/comms-request'), page.url());

  // Step 1 of the form: content
  await page.type('input[name="suggestedSubjectLine"]', SUBJECT);
  await page.type('textarea[name="description"]', 'A request made by the member e2e test.');
  await page.click('.comms-wizard [contenteditable="true"]');
  await page.keyboard.type(DRAFT, { delay: 10 });
  await page.type('input[name="signatureText"]', 'Thanks, Test Member');
  await clickNext(page);

  // Step 2: audience and timing (Publish By defaults to a week out)
  await page.waitForSelector('.audience-card', { visible: true });
  await page.click('.audience-card');
  await page.type('input[name="owner"]', 'Test Member');
  await page.type('input[name="replyToAddress"]', 'replies@example.com');
  const email = await page.$eval('input[name="email"]', (e) => e.value);
  if (email === 'member@localhost') await setReactValue(page, 'input[name="email"]', 'member@example.com'); // see the header
  await clickNext(page);

  // Step 3: approvers. Type the address; never pick a suggestion (that calls an admin API).
  await page.waitForSelector('.approver-input-wrap input', { visible: true });
  await page.type('.approver-input-wrap input', 'user2@localhost');
  await page.$eval('.approver-input-wrap input', (e) => e.blur()); // closes any suggestions
  await L.sleep(300);
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/content\/submissions$/.test(r.url()), { timeout: 15000 });
  await page.click('.wizard-nav .btn-submit');
  const res = await created;
  const body = await res.json().catch(() => ({}));
  check('New Request: POST /content/submissions succeeds', res.ok(), `${res.status()}`);
  await page.waitForSelector('.modal-content', { timeout: 10000 });
  const title = await page.$eval('.modal-header h3', (e) => e.textContent);
  check('New Request: "Request Submitted!" shown', title === 'Request Submitted!', title);
  if (!body.id) throw new Error(`no submission id in the reply: ${JSON.stringify(body).slice(0, 300)}`);
  const stored = await L.api(`/content/submissions/${body.id}`);
  check('New Request: stored with the member as submitter',
    [stored.submittedBy, stored.submitterEmail, stored.submittedByEmail].some((v) => v === 'dev-member' || v === 'member@localhost'),
    `submittedBy=${stored.submittedBy}`);
  check('New Request: stored with the typed text', JSON.stringify(stored.richTextContent || stored.content || '').includes(DRAFT));

  // "View Submissions" goes back to /requests, which lists it.
  await page.evaluate(() => [...document.querySelectorAll('.modal-footer button')].find((b) => b.textContent === 'View Submissions').click());
  await L.waitFor(() => page.url().endsWith('/requests'), 'back on /requests', 5000);
  const listed = await L.waitFor(() => page.evaluate((s) => document.body.innerText.includes(s), SUBJECT), 'the request is listed', 10000).catch(() => false);
  check('/requests lists the new request', listed);
  return body.id;
}

async function saveState(u) {
  return u.page.$eval('.save-status', (el) => el.getAttribute('data-state')).catch(() => null);
}

/** The Open list's card descriptions. */
function cards(u) {
  return u.page.$$eval(`${SIDEBAR} .rp-card`, (els) => els.map((e) => (e.querySelector('.rp-desc') || e).textContent.trim()));
}

async function cardHandle(u, text) {
  for (const el of await u.page.$$(`${SIDEBAR} .rp-card`)) {
    const desc = await el.$eval('.rp-desc', (d) => d.textContent.trim()).catch(() => '');
    if (desc.includes(text)) return el;
  }
  return null;
}

const memberCards = async (u) => (await cards(u)).filter((c) => c.includes(TYPED.trim()));

(async () => {
  console.log(`app ${L.APP}, api ${L.API}`);
  const browser = await L.launch();
  let m;
  let r;
  try {
    m = await openMember(browser);

    // ---- 1. /requests ----
    if (!(await checkRequests(m))) throw new Error('/requests did not load for a Member (redirect loop)');

    // ---- 2. New Request ----
    const id = await createRequest(m);
    console.log('submission', id);

    // ---- 3. The review page as the author ----
    await m.page.goto(`${L.APP}/tracked-changes/${id}`, { waitUntil: 'domcontentloaded' });
    const editable = await m.page.waitForSelector(`${L.EDITOR}[contenteditable="true"]`, { timeout: 20000 }).then(() => true).catch(() => false);
    if (!check('author: the editor loads and is editable', editable)) {
      const body = await m.page.evaluate(() => document.body.innerText.slice(0, 400));
      throw new Error(`editor not editable for the member. url=${m.page.url()} body=${body}`);
    }
    await L.waitFor(() => m.page.$('.review-top-bar'), 'top bar', 10000);
    await L.sleep(1500);
    const before = await L.blocks(m);
    check('author: the editor shows the request text', before.some((b) => b.includes(DRAFT)), JSON.stringify(before));
    check('author: no Finish review menu', !(await m.page.$(TOGGLE)));
    check('author: no queue pager', !(await m.page.$('.queue-nav')));
    check('author: save status starts Saved', (await saveState(m)) === 'saved', await saveState(m));

    const idx = before.findIndex((b) => b.includes(DRAFT));
    await L.caret(m, idx, -1);
    const states = new Set();
    const poll = setInterval(async () => { const s = await saveState(m); if (s) states.add(s); }, 50);
    await m.page.keyboard.type(TYPED, { delay: 30 });
    const saved = await L.waitFor(async () => m.changePosts.length > 0 && (await saveState(m)) === 'saved', 'saved after typing', 15000)
      .then(() => true).catch(() => false);
    clearInterval(poll);
    check('author: typing is saved (save status reaches Saved)', saved, `states: ${[...states].join(' -> ')}, change POSTs: ${m.changePosts.length}`);
    check('author: the typed text is in the editor', (await L.blocks(m))[idx].includes(TYPED.trim()));
    const pending = (await L.api(`/tracked-changes/submission/${id}`)).changes.filter((c) => c.status === 'pending');
    check('server: the edit is a pending change by the member',
      pending.length > 0 && pending.every((c) => c.changedBy === 'dev-member' || c.changedBy === 'member@localhost'),
      JSON.stringify(pending.map((c) => ({ by: c.changedBy, name: c.changedByName, new: (c.newValue || '').slice(-30) }))));
    const authorCard = await L.waitFor(async () => (await memberCards(m)).length > 0, 'the member sees its own card', 10000).then(() => true).catch(() => false);
    check('author: sees its edit as a card', authorCard, JSON.stringify(await cards(m)));

    // ---- 4. A reviewer rejects the member's edit ----
    r = await L.openUser(browser, 'reviewer', REVIEWER_SESSION, id);
    r.failed = [];
    r.page.on('response', (res) => {
      if (res.status() >= 400 && res.url().includes('/api/')) r.failed.push(`${res.status()} ${res.request().method()} ${res.url().replace(/^https?:\/\/[^/]+/, '')}`);
    });
    await L.waitFor(() => r.page.$('.review-top-bar'), 'reviewer top bar', 10000);
    check('reviewer: sees the Finish review menu', !!(await L.waitFor(() => r.page.$(TOGGLE), 'Finish review', 5000).catch(() => null)));
    const seen = await L.waitFor(async () => (await memberCards(r)).length > 0, "reviewer sees the member's card", 15000).then(() => true).catch(() => false);
    check("reviewer: sees the member's edit as a card", seen, JSON.stringify(await cards(r)));
    if (seen) {
      const card = await cardHandle(r, TYPED.trim());
      // Names come from /user/directory, which lists stored users only; the dev users aren't
      // stored, so a card shows the id ('dev-member') rather than 'Test Member'.
      const who = await card.$eval('.rp-card__author', (e) => e.textContent.trim()).catch(() => '');
      check('reviewer: the card is attributed to the member', who === 'Test Member' || who === 'dev-member', who);
      await (await card.$('button[title="Reject"]')).click();
      const goneR = await L.waitFor(async () => (await memberCards(r)).length === 0, "reviewer's card goes", 10000).then(() => true).catch(() => false);
      check("reviewer: the member's card goes after Reject", goneR);
      const goneM = await L.waitFor(async () => (await memberCards(m)).length === 0, "member's card goes live", 10000).then(() => true).catch(() => false);
      check("author: the member's card disappears live", goneM, JSON.stringify(await cards(m)));
      const textGone = await L.waitFor(async () => !(await L.blocks(m)).some((b) => b.includes(TYPED.trim())), 'the rejected text leaves the member editor', 10000)
        .then(() => true).catch(() => false);
      check("author: the rejected text leaves the member's editor", textGone, JSON.stringify(await L.blocks(m)));
      const rejected = await L.waitFor(async () => {
        const changes = (await L.api(`/tracked-changes/submission/${id}`)).changes;
        return changes.length > 0 && changes.every((c) => c.status === 'rejected');
      }, 'server: rejected', 10000).then(() => true).catch(() => false);
      check('server: the change is rejected', rejected);
    }
    await L.sleep(1000);
  } catch (e) {
    check(`no exception (${e.message.split('\n')[0]})`, false);
    if (m) await m.page.screenshot({ path: 'fail-member.png' }).catch(() => {});
    console.error(e.stack || e);
  } finally {
    for (const [label, u] of [['member', m], ['reviewer', r]]) {
      if (!u) continue;
      if (u.failed && u.failed.length) console.log(`${label}: failed API responses:\n  ${[...new Set(u.failed)].join('\n  ')}`);
      check(`no console errors (${label})`, u.errors.length === 0, `${u.errors.length} errors`);
      if (u.errors.length) console.log(`${label}: console errors:\n  ${u.errors.slice(0, 30).map((t) => t.slice(0, 300)).join('\n  ')}`);
    }
    await within(browser.close(), 10000);
  }
  if (notes.length) console.log(`\nnotes:\n  ${notes.join('\n  ')}`);
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
