// The approval status follows the tracked changes, live in two browsers (collaborative mode):
//
//   1. dev-admin (A, the author) types an edit, then approves (Finish review -> Approve) as the
//      required approver, a council manager and a Comms Cadre member (seeded below). The
//      status stays in_review (an edit is pending): both headers show 3/4, no Send.
//   2. dev-user2 (B, CommsCadre) accepts the edit: the status becomes approved, both headers
//      show 4/4 and the Send button appears in both browsers without a reload.
//   3. A types a new edit: the status drops back to in_review and Send disappears in both.
//   4. B accepts it: approved again.
//   5. A comment (posted by A) shows in Open for both. B resolves it: it moves to History
//      live for A ("Resolved by"), and Open shows "All caught up" for both. A reopens it from
//      History: it is back in Open for B. B resolves it again; after a reload A still has it
//      in History.
//
// Fails on any console error in either browser.
//
// Setup: dev-admin (dev@localhost, userType Admin) satisfies the council and Comms Cadre
// gates only as a listed member. The script adds dev@localhost to the Comms Cadre list
// (POST /comms-cadre, dev bypass) and as a council manager (PUT /admin/council-managers,
// which checks a real admin session and needs a stored user: it makes the bootstrap admin
// like member.js and stores dev@localhost with POST /admin/bulk-create-users). So it needs
// the backend started as for member.js (README.md). Run it after the other scripts on a
// store: the seeded memberships change the gates they see.
const L = require('./lib');

const AUTHOR = 'dev-admin-session';
const REVIEWER = 'dev-user2-session';
const DEV_EMAIL = 'dev@localhost';
const SIDEBAR = '.editor-sidebar';
const TOGGLE = '.finish-review__toggle';
const SEND = '.document-view-bar__send';
const COMMENT = 'Please check the intro before sending.';

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  return !!ok;
}

/** check() once `cond` holds within `ms`; FAIL with the last value otherwise. */
async function eventually(name, cond, ms = 10000, describe) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    last = await cond();
    if (last) return check(name, true);
    await L.sleep(150);
  }
  return check(name, false, describe ? await describe() : `last: ${JSON.stringify(last)}`);
}

async function seedMemberships() {
  const cadre = await L.api('/comms-cadre');
  if (!cadre.some((m) => m.email === DEV_EMAIL)) {
    await L.api('/comms-cadre', { method: 'POST', body: { email: DEV_EMAIL, name: 'Dev Admin', userId: 'dev-admin' } });
  }
  const council = await L.api('/council/members');
  if (!council.some((m) => m.email === DEV_EMAIL)) {
    const session = await L.adminSession();
    await L.api('/admin/bulk-create-users', { method: 'POST', session, body: { users: [{ name: 'Dev Admin', email: DEV_EMAIL, approved: true }] } });
    await L.api('/admin/council-managers', { method: 'PUT', session, body: { email: DEV_EMAIL, role: 'CommunicationsManager', action: 'add' } });
  }
}

async function createSubmission() {
  const content = JSON.stringify({
    root: {
      type: 'root', version: 1, format: '', indent: 0, direction: 'ltr',
      children: ['Intro paragraph for the approval flow.', 'Second paragraph.'].map((text) => ({
        type: 'paragraph', version: 1, format: '', indent: 0, direction: 'ltr', textFormat: 0, textStyle: '',
        children: [{ type: 'text', version: 1, text, format: 0, style: '', mode: 'normal', detail: 0 }],
      })),
    },
  });
  return L.api('/content/submissions', {
    method: 'POST',
    body: { title: `Approval flow ${new Date().toISOString()}`, content, status: 'submitted', requiredApprovers: [DEV_EMAIL] },
  });
}

const server = (id) => L.api(`/content/submissions/${id}`);
const pendingOnServer = async (id) => ((await L.api(`/tracked-changes/submission/${id}`)).changes || []).filter((c) => c.status === 'pending');
const conditions = (u) => u.page.$eval('.conditions-popover__count', (el) => el.textContent.trim()).catch(() => null);
const hasSend = async (u) => !!(await u.page.$(SEND));
const openTexts = (u) => u.page.$$eval(`${SIDEBAR} .rp-card`, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
const emptyTitle = (u) => u.page.$eval(`${SIDEBAR} .rp-empty__title`, (el) => el.textContent.trim()).catch(() => null);
const tab = (u, n) => u.page.click(`${SIDEBAR} .rp-tab:nth-child(${n})`);

async function chooseFinish(u, label) {
  await u.page.click(TOGGLE);
  await u.page.waitForSelector('.finish-review__menu.show');
  for (const item of await u.page.$$('.finish-review__item')) {
    const text = await item.evaluate((el) => el.querySelector('.finish-review__item-label').textContent);
    if (text === label) { await item.click(); return; }
  }
  throw new Error(`no menu item ${label}`);
}

/** Types `text` at the end of the last paragraph and waits until the server has the change. */
async function typeEdit(u, subId, text) {
  const before = (await pendingOnServer(subId)).length;
  await L.caret(u, (await L.blocks(u)).length - 1);
  await u.page.keyboard.type(text, { delay: 25 });
  await L.waitFor(async () => (await pendingOnServer(subId)).length > before, `server has the edit "${text.trim()}"`, 15000);
}

/** B accepts the card describing `text`. */
async function acceptCard(u, text) {
  const card = await L.waitFor(async () => {
    for (const el of await u.page.$$(`${SIDEBAR} .rp-card`)) {
      const t = await el.evaluate((e) => e.textContent);
      if (t.includes(text)) return el;
    }
    return null;
  }, `${u.name} sees the card for "${text.trim()}"`, 15000);
  await (await card.$('button[title="Accept"]')).click();
}

(async () => {
  const config = await L.api('/config').catch(() => ({}));
  console.log('collab mode:', config.collabMode || config.mode || JSON.stringify(config));
  await seedMemberships();
  const sub = await createSubmission();
  console.log('submission', sub.id);
  const browser = await L.launch();
  let a;
  let b;
  try {
    a = await L.openUser(browser, 'A', AUTHOR, sub.id);
    b = await L.openUser(browser, 'B', REVIEWER, sub.id);
    await L.converged(a, b);

    // ---- 1. An edit pending, then all the approvals ----
    await typeEdit(a, sub.id, ' First edit.');
    await chooseFinish(a, 'Approve');
    await L.waitFor(async () => ((await server(sub.id)).approvals || []).some((x) => x.approverEmail === DEV_EMAIL && x.status === 'approved'), 'approval stored', 8000);
    const s1 = await server(sub.id);
    const g = s1.approvalGates || {};
    check('the approval meets the required approver, council and Comms Cadre gates',
      g.requiredApprovers?.met && g.councilManager?.met && g.commsCadre?.met, JSON.stringify({ ra: g.requiredApprovers?.met, cm: g.councilManager?.met, cc: g.commsCadre?.met }));
    check('status stays in_review while an edit is pending', s1.status === 'in_review', s1.status);
    await eventually('A: header shows 3/4', async () => (await conditions(a)) === '3/4 conditions met', 8000, () => conditions(a));
    await eventually('B: header shows 3/4 live (approval_added)', async () => (await conditions(b)) === '3/4 conditions met', 8000, () => conditions(b));
    check('no Send before approval (A, B)', !(await hasSend(a)) && !(await hasSend(b)));

    // ---- 2. B resolves the last edit: approved live ----
    await acceptCard(b, 'First edit.');
    await eventually('server: approved after the last edit is accepted', async () => (await server(sub.id)).status === 'approved', 10000, async () => (await server(sub.id)).status);
    await eventually('A: header shows 4/4 without a reload', async () => (await conditions(a)) === '4/4 conditions met', 8000, () => conditions(a));
    await eventually('B: header shows 4/4 without a reload', async () => (await conditions(b)) === '4/4 conditions met', 8000, () => conditions(b));
    await eventually('A: Send appears without a reload', () => hasSend(a), 8000);
    await eventually('B: Send appears without a reload', () => hasSend(b), 8000);

    // ---- 3. A new edit by the author: back to in_review ----
    await typeEdit(a, sub.id, ' Second edit.');
    await eventually('server: back to in_review after a new edit', async () => (await server(sub.id)).status === 'in_review', 10000, async () => (await server(sub.id)).status);
    await eventually('A: Send hidden again', async () => !(await hasSend(a)), 8000);
    await eventually('B: Send hidden again', async () => !(await hasSend(b)), 8000);
    await eventually('A: header back to 3/4', async () => (await conditions(a)) === '3/4 conditions met', 8000, () => conditions(a));
    await eventually('B: header back to 3/4', async () => (await conditions(b)) === '3/4 conditions met', 8000, () => conditions(b));

    // ---- 4. B accepts it: approved again ----
    await acceptCard(b, 'Second edit.');
    await eventually('server: approved again', async () => (await server(sub.id)).status === 'approved', 10000, async () => (await server(sub.id)).status);
    await eventually('A: Send back', () => hasSend(a), 8000);
    await eventually('B: Send back', () => hasSend(b), 8000);

    // ---- 5. Resolve a comment ----
    await L.api(`/content/submissions/${sub.id}/comments`, { method: 'POST', body: { content: COMMENT } });
    await eventually('A: the comment is in Open', async () => (await openTexts(a)).some((t) => t.includes(COMMENT)), 8000, () => openTexts(a));
    await eventually('B: the comment is in Open', async () => (await openTexts(b)).some((t) => t.includes(COMMENT)), 8000, () => openTexts(b));
    check('B: "All changes reviewed. Open comments:"', await b.page.$eval(`${SIDEBAR} .rp-note`, (el) => el.textContent.trim()).catch(() => '') === 'All changes reviewed. Open comments:');
    await b.page.click(`${SIDEBAR} .rp-card--comment .rp-comment__resolve`);
    await eventually('B: Open shows "All caught up"', async () => (await emptyTitle(b)) === 'All caught up', 5000, () => emptyTitle(b));
    await eventually('A: Open shows "All caught up" live', async () => (await emptyTitle(a)) === 'All caught up', 8000, async () => JSON.stringify({ empty: await emptyTitle(a), open: await openTexts(a) }));
    const stored = (await server(sub.id)).comments.find((c) => c.content === COMMENT);
    check('server: the comment is resolved by dev-user2', stored?.resolved === true && stored?.resolvedBy === 'user2@localhost', JSON.stringify(stored));
    await tab(a, 2);
    const resolvedItem = `${SIDEBAR} .rp-history__item--resolved`;
    await eventually('A: History lists it as "Resolved by"', async () => {
      const t = await a.page.$eval(resolvedItem, (el) => el.textContent.replace(/\s+/g, ' ')).catch(() => '');
      return t.includes('Resolved by') && t.includes(COMMENT);
    }, 5000);

    // A reopens it from History: back in Open for B
    await a.page.click(`${resolvedItem} .rp-history__reopen`);
    await eventually('B: the reopened comment is back in Open', async () => (await openTexts(b)).some((t) => t.includes(COMMENT)), 8000, () => openTexts(b));
    await eventually('server: the comment is open again', async () => (await server(sub.id)).comments.find((c) => c.content === COMMENT)?.resolved === false, 5000);
    await tab(a, 1);
    await eventually('A: the reopened comment is in Open', async () => (await openTexts(a)).some((t) => t.includes(COMMENT)), 5000, () => openTexts(a));

    // B resolves it again; A reloads: still resolved
    await b.page.click(`${SIDEBAR} .rp-card--comment .rp-comment__resolve`);
    await eventually('A: "All caught up" again', async () => (await emptyTitle(a)) === 'All caught up', 8000, () => emptyTitle(a));
    await a.page.reload({ waitUntil: 'domcontentloaded' });
    await a.page.waitForSelector(`${L.EDITOR}[contenteditable="true"]`, { timeout: 20000 });
    await eventually('A after a reload: "All caught up"', async () => (await emptyTitle(a)) === 'All caught up', 8000, () => emptyTitle(a));
    await tab(a, 2);
    await eventually('A after a reload: History has the resolved comment', async () => !!(await a.page.$(resolvedItem)), 5000);
    check('A after a reload: Send shown (approved)', await hasSend(a));
    check('A after a reload: header shows 4/4', (await conditions(a)) === '4/4 conditions met', await conditions(a));

    for (const u of [a, b]) {
      const errors = u.errors.filter((e) => !/favicon|DevTools/.test(e));
      check(`${u.name}: no console errors`, errors.length === 0, errors.slice(0, 5).join(' | '));
    }
  } catch (e) {
    check(`scenario ran to the end`, false, e.message);
    for (const u of [a, b].filter(Boolean)) if (u.errors.length) console.log(`${u.name} console errors:`, u.errors.slice(0, 8));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`approval-flow: ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
