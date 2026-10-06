// Review page header and controls (feat/review-ui-topbar):
// - no Reset button; one "Finish review" menu with Approve / Request changes (modal) / Decline,
//   each checked on its own submission against the server
// - the conditions popover opens and lists the four gates
// - the Compare view shows the comparison
// - Send is offered only once the request is approved, and opens the send preview
// - the save status reaches "Saved" after typing without pressing anything, and the edit
//   survives a reload
// - an author (no approve rights) sees no Finish review menu and no queue pager
// Works in both modes. STRICT=1 adds a slower persistence check: accept a change, type, close
// every client, wait for the Yjs room to be dropped (35 s), then reload.
const L = require('./lib');

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
}

const TOGGLE = '.finish-review__toggle';

async function openReview(browser, name, session, submissionId) {
  const u = await L.openUser(browser, name, session, submissionId);
  await L.waitFor(() => u.page.$('.review-top-bar'), 'top bar');
  return u;
}

async function chooseFinish(u, label) {
  await u.page.click(TOGGLE);
  await u.page.waitForSelector('.finish-review__menu.show');
  const items = await u.page.$$('.finish-review__item');
  for (const item of items) {
    const text = await item.evaluate((el) => el.querySelector('.finish-review__item-label').textContent);
    if (text === label) { await item.click(); return; }
  }
  throw new Error(`no menu item ${label}`);
}

async function saveState(u) {
  return u.page.$eval('.save-status', (el) => el.getAttribute('data-state')).catch(() => null);
}

(async () => {
  const config = await L.api('/config').catch(() => ({}));
  console.log('collab mode:', config.collabMode || config.mode || JSON.stringify(config));
  const browser = await L.launch();
  try {
    // ---- 1. Header, conditions, compare, save status, reload (submission A) ----
    const subA = await L.createSubmission(['Alpha first paragraph.', 'Alpha second paragraph.']);
    let a = await openReview(browser, 'reviewer', 'dev-admin-session', subA.id);
    const buttons = await a.page.$$eval('button', (els) => els.map((e) => e.textContent.trim()));
    check('no Reset button', !buttons.some((t) => /^reset$/i.test(t)));
    check('no separate Approve/Reject buttons in the top bar',
      (await a.page.$$eval('.review-top-bar button', (els) => els.map((e) => e.textContent.trim())))
        .every((t) => !/^(approve|reject|request changes)$/i.test(t)));
    check('Finish review button present', !!(await a.page.$(TOGGLE)));
    check('conditions shown once', (await a.page.evaluate(() => (document.body.innerText.match(/conditions met/g) || []).length)) === 1);

    await a.page.click('.conditions-popover__trigger');
    const gateRows = await a.page.$$eval('.conditions-popover__panel [data-gate]', (els) => els.map((e) => e.getAttribute('data-gate')));
    check('conditions popover lists the four gates', gateRows.length === 4, gateRows.join(','));
    await a.page.keyboard.press('Escape');
    check('popover closes on Escape', !(await a.page.$('.conditions-popover__panel')));

    check('save status starts Saved', (await saveState(a)) === 'saved');
    await L.caret(a, 0, -1);
    const typed = ' Typed by e2e.';
    const states = new Set();
    const poll = setInterval(async () => { const s = await saveState(a); if (s) states.add(s); }, 50);
    await a.page.keyboard.type(typed, { delay: 30 });
    try {
      await L.waitFor(async () => (a.changePosts.length > 0 && (await saveState(a)) === 'saved'), 'saved after typing', 15000);
      check('save status reaches Saved after typing, no button press', true, `states seen: ${[...states].join(' -> ')}`);
    } catch (e) {
      check('save status reaches Saved after typing, no button press', false, `states: ${[...states].join(',')} posts=${a.changePosts.length}`);
    }
    clearInterval(poll);
    check('status showed Unsaved changes while typing', states.has('unsaved'));
    check('no Save button', !(await a.page.$$eval('button', (els) => els.some((e) => e.textContent.trim() === 'Save'))));

    await a.page.evaluate(() => [...document.querySelectorAll('.document-view-bar__option')].find((b) => b.textContent === 'Compare').click());
    await L.waitFor(() => a.page.$('.diff-section'), 'comparison view', 5000).then(() => check('Compare shows the comparison', true)).catch(() => check('Compare shows the comparison', false));
    check('Send not offered before approval', !(await a.page.$('.document-view-bar__send')));
    await a.page.evaluate(() => [...document.querySelectorAll('.document-view-bar__option')].find((b) => b.textContent === 'Proposed').click());
    await a.page.waitForSelector(`${L.EDITOR}[contenteditable="true"]`);

    await a.page.reload({ waitUntil: 'domcontentloaded' });
    await a.page.waitForSelector(`${L.EDITOR}[contenteditable="true"]`, { timeout: 20000 });
    await L.sleep(1500);
    const afterReload = await L.blocks(a);
    check('edit persists after reload', afterReload[0] && afterReload[0].includes(typed.trim()), JSON.stringify(afterReload));
    check('no console errors (reviewer A)', a.errors.length === 0, a.errors.slice(0, 3).join(' | '));
    await a.context.close();

    // ---- 1b. An edit is saved when leaving right after typing (before the 2.5 s pause) ----
    const subL = await L.createSubmission(['Lima paragraph.']);
    const l = await openReview(browser, 'leaver', 'dev-admin-session', subL.id);
    await L.caret(l, 0, -1);
    await l.page.keyboard.type(' left fast', { delay: 20 });
    await l.page.click('.review-top-bar__back'); // in-app navigation unmounts the editor
    await L.waitFor(async () => {
      const tc = await L.api(`/tracked-changes/submission/${subL.id}`);
      return (tc.changes || []).some((ch) => (ch.newValue || '').includes('left fast'));
    }, 'change saved on unmount', 8000).then(() => check('edit saved when navigating away right after typing', true))
      .catch(() => check('edit saved when navigating away right after typing', false));
    await l.context.close();

    const subH = await L.createSubmission(['Hotel paragraph.']);
    const h = await openReview(browser, 'hider', 'dev-admin-session', subH.id);
    await L.caret(h, 0, -1);
    await h.page.keyboard.type(' hidden tab', { delay: 20 });
    await h.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await L.waitFor(async () => {
      const tc = await L.api(`/tracked-changes/submission/${subH.id}`);
      return (tc.changes || []).some((ch) => (ch.newValue || '').includes('hidden tab'));
    }, 'change saved on hide', 2000).then(() => check('edit saved at once when the page is hidden', true))
      .catch(() => check('edit saved at once when the page is hidden', false));
    await h.context.close();

    // ---- 1c. A failed save shows "Couldn't save" + Retry, which survives a later good save ----
    const subR = await L.createSubmission(['Romeo paragraph.']);
    const r = await openReview(browser, 'retrier', 'dev-admin-session', subR.id);
    await r.page.evaluate(() => {
      const nativeFetch = window.fetch.bind(window);
      window.__failChangePosts = true;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (window.__failChangePosts && init && init.method === 'POST' && /\/tracked-changes\/submission\/[^/]+$/.test(url)) {
          return Promise.resolve(new Response('unavailable', { status: 503 }));
        }
        return nativeFetch(input, init);
      };
    });
    await L.caret(r, 0, -1);
    await r.page.keyboard.type(' first', { delay: 20 });
    await L.waitFor(async () => (await saveState(r)) === 'error', 'error state', 12000)
      .then(() => check("failed save shows Couldn't save", true)).catch(async () => check("failed save shows Couldn't save", false, await saveState(r)));
    check('Retry offered on error', !!(await r.page.$('.save-status__retry')));
    await r.page.evaluate(() => { window.__failChangePosts = false; });
    await L.caret(r, 0, -1);
    await r.page.keyboard.type(' second', { delay: 20 });
    await L.waitFor(async () => {
      const tc = await L.api(`/tracked-changes/submission/${subR.id}`);
      return (tc.changes || []).length > 0;
    }, 'second edit saved', 10000).catch(() => null);
    await L.sleep(300);
    check('still shows the error after a later edit saved', (await saveState(r)) === 'error' && !!(await r.page.$('.save-status__retry')), await saveState(r));
    await r.page.click('.save-status__retry');
    await L.waitFor(async () => (await saveState(r)) === 'saved', 'saved after retry', 10000)
      .then(() => check('Retry saves the failed edit and ends at Saved', true)).catch(async () => check('Retry saves the failed edit and ends at Saved', false, await saveState(r)));
    const tcR = await L.api(`/tracked-changes/submission/${subR.id}`);
    check('both edits stored after Retry', (tcR.changes || []).some((ch) => /first/.test(ch.newValue)) && (tcR.changes || []).some((ch) => /second/.test(ch.newValue)),
      JSON.stringify((tcR.changes || []).map((ch) => ch.newValue)));
    await r.context.close();

    // ---- 2. Approve (submission B) ----
    const subB = await L.createSubmission(['Bravo text.']);
    const b = await openReview(browser, 'approver', 'dev-admin-session', subB.id);
    await chooseFinish(b, 'Approve');
    await L.waitFor(async () => {
      const s = await L.api(`/content/submissions/${subB.id}`);
      return (s.approvals || []).some((x) => x.status === 'approved' && (x.approverEmail === 'dev@localhost' || x.approverId === 'dev-admin'));
    }, 'approval stored', 8000).then(() => check('Finish review -> Approve stores an approval', true)).catch(() => check('Finish review -> Approve stores an approval', false));
    await b.context.close();

    // ---- 3. Request changes (submission C) ----
    const subC = await L.createSubmission(['Charlie text.']);
    const c = await openReview(browser, 'requester', 'dev-admin-session', subC.id);
    await chooseFinish(c, 'Request changes');
    await c.page.waitForSelector('.request-changes-dialog textarea');
    await L.sleep(200);
    const focused = await c.page.evaluate(() => document.activeElement && document.activeElement.tagName);
    check('Request changes opens the modal with the textarea focused', focused === 'TEXTAREA', `focus on ${focused}`);
    await c.page.type('.request-changes-dialog textarea', 'Please shorten the intro.');
    await c.page.evaluate(() => [...document.querySelectorAll('.request-changes-dialog button')].find((x) => x.textContent.trim() === 'Submit').click());
    await L.waitFor(async () => {
      const s = await L.api(`/content/submissions/${subC.id}`);
      return s.status === 'in_review' && (s.comments || []).some((x) => x.content === 'Please shorten the intro.');
    }, 'request stored', 8000).then(() => check('Finish review -> Request changes posts the comment', true)).catch(() => check('Finish review -> Request changes posts the comment', false));
    await c.context.close();

    // ---- 4. Decline (submission D) ----
    const subD = await L.createSubmission(['Delta text.']);
    const d = await openReview(browser, 'decliner', 'dev-admin-session', subD.id);
    await chooseFinish(d, 'Decline');
    await L.waitFor(async () => {
      const s = await L.api(`/content/submissions/${subD.id}`);
      return (s.approvals || []).some((x) => x.status === 'rejected');
    }, 'decline stored', 8000).then(() => check('Finish review -> Decline stores a rejection', true)).catch(() => check('Finish review -> Decline stores a rejection', false));
    // Keyboard: open with Enter, Escape closes, focus back on the button
    await d.page.focus(TOGGLE);
    await d.page.keyboard.press('Enter');
    await d.page.waitForSelector('.finish-review__menu.show');
    await d.page.keyboard.press('Escape');
    await L.sleep(200);
    const kb = await d.page.evaluate((sel) => ({
      open: !!document.querySelector('.finish-review__menu.show'),
      focus: document.activeElement === document.querySelector(sel),
    }), TOGGLE);
    check('menu opens with Enter, Escape closes and returns focus', !kb.open && kb.focus, JSON.stringify(kb));
    await d.context.close();

    // ---- 5. Send (approved submission E) ----
    const subE = await L.createSubmission(['Echo text.']);
    await L.api(`/content/submissions/${subE.id}/override-approve`, { method: 'POST', body: { confirm: true, reason: 'e2e' } });
    const e = await openReview(browser, 'sender', 'dev-admin-session', subE.id);
    const sendBtn = await e.page.$('.document-view-bar__send');
    check('Send offered once approved', !!sendBtn);
    if (sendBtn) {
      await sendBtn.click();
      await L.waitFor(() => e.page.$('.send-mode-section .send-mode-preview'), 'send preview', 5000)
        .then(() => check('Send opens the send preview', true)).catch(() => check('Send opens the send preview', false));
      check('send preview has Copy to Clipboard', await e.page.$$eval('.send-mode-actions button', (els) => els.some((x) => /copy to clipboard/i.test(x.textContent))));
    }
    await e.context.close();

    // ---- 6. Author view (no approve rights): page sees a plain member ----
    const author = await browser.createBrowserContext();
    const ap = await author.newPage();
    const member = { id: 'author-1', email: 'author@localhost', name: 'Author', roles: [], userType: 'Public', approved: true, verified: true, groups: [] };
    // The page sees a plain member (the backend still serves the dev admin's data).
    await ap.evaluateOnNewDocument((u) => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.endsWith('/api/auth/me')) return Promise.resolve(new Response(JSON.stringify({ user: u }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        if (url.endsWith('/api/admin/user-roles')) return Promise.resolve(new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } }));
        return nativeFetch(input, init);
      };
    }, member);
    const subF = await L.createSubmission(['Foxtrot text.']);
    await ap.goto(`${L.APP}/requests`, { waitUntil: 'domcontentloaded' });
    await ap.evaluate((u) => { localStorage.setItem('sessionId', 'dev-admin-session'); localStorage.setItem('user', JSON.stringify(u)); }, member);
    await ap.goto(`${L.APP}/tracked-changes/${subF.id}`, { waitUntil: 'domcontentloaded' });
    await ap.waitForSelector('.review-top-bar', { timeout: 20000 });
    await L.sleep(1500);
    check('author: no Finish review menu', !(await ap.$(TOGGLE)));
    check('author: no queue pager', !(await ap.$('.queue-nav')));
    check('author: conditions still shown', !!(await ap.$('.conditions-popover__trigger')));
    await author.close();

    // ---- 7. Queue pager for a reviewer (several in-flight submissions exist by now) ----
    const g = await openReview(browser, 'pager', 'dev-admin-session', subA.id);
    await L.waitFor(() => g.page.$('.queue-nav'), 'queue pager', 5000).catch(() => null);
    const label = await g.page.$eval('.queue-nav__position', (el) => el.textContent).catch(() => null);
    check('reviewer: pager reads "Request N of M"', /^Request \d+ of \d+$/.test(label || ''), label);
    const tips = await g.page.$$eval('.queue-nav__btn', (els) => els.map((x) => x.title));
    check('pager tooltips say request', tips.join('|') === 'Previous request ([)|Next request (])', tips.join('|'));
    const nextEnabled = await g.page.$eval('.queue-nav__btn:last-child', (el) => !el.disabled).catch(() => false);
    const prevEnabled = await g.page.$eval('.queue-nav__btn:first-child', (el) => !el.disabled).catch(() => false);
    if (nextEnabled || prevEnabled) {
      const before = g.page.url();
      await g.page.click(nextEnabled ? '.queue-nav__btn:last-child' : '.queue-nav__btn:first-child');
      await L.waitFor(async () => g.page.url() !== before, 'url change', 5000).catch(() => null);
      check('pager navigates to another /tracked-changes/ page', /\/tracked-changes\/[^/]+$/.test(g.page.url()) && g.page.url() !== before, g.page.url());
      // An edit after paging is saved against the new submission, not the first one.
      const newId = g.page.url().split('/').pop();
      await g.page.waitForSelector(`${L.EDITOR}[contenteditable="true"]`, { timeout: 15000 });
      await L.sleep(1000);
      const postsBefore = g.changePosts.length;
      const urlsBefore = g.changeUrls.length;
      await L.caret(g, 0, -1);
      await g.page.keyboard.type(' paged', { delay: 30 });
      await L.waitFor(() => g.changePosts.length > postsBefore, 'save after paging', 10000).catch(() => null);
      const target = g.changeUrls.slice(urlsBefore).map((u) => u.split('/').pop());
      check('edit after paging is saved to the new submission', target.length > 0 && target.every((id) => id === newId), `${target.join(',')} vs ${newId}`);
    }
    await g.context.close();

    // ---- 8. STRICT persistence: after an accept, and after the room is dropped ----
    if (process.env.STRICT) {
      const subS = await L.createSubmission(['Sierra first.', 'Sierra second.']);
      let s = await openReview(browser, 'strict', 'dev-admin-session', subS.id);
      await L.caret(s, 0, -1);
      await s.page.keyboard.type(' one', { delay: 30 });
      await L.waitFor(async () => s.changePosts.length > 0 && (await saveState(s)) === 'saved', 'first save', 15000);
      const tc = await L.api(`/tracked-changes/submission/${subS.id}`);
      await L.api(`/tracked-changes/change/${tc.changes[0].id}/status`, { method: 'PUT', body: { status: 'approved', submissionId: subS.id } });
      await L.sleep(1500);
      await L.caret(s, 1, -1);
      await s.page.keyboard.type(' two', { delay: 30 });
      await L.waitFor(async () => s.changePosts.length > 1 && (await saveState(s)) === 'saved', 'second save', 15000);
      await s.context.close();
      console.log('waiting 35 s for the room to be dropped...');
      await L.sleep(35000);
      const stored = await L.api(`/tracked-changes/submission/${subS.id}`);
      const rich = JSON.stringify(stored.proposedVersionsRichText || {});
      check('STRICT: stored proposed version has both edits', rich.includes('Sierra first. one') && rich.includes('Sierra second. two'), rich.slice(0, 200));
      s = await openReview(browser, 'strict2', 'dev-admin-session', subS.id);
      await L.sleep(1500);
      const bl = await L.blocks(s);
      check('STRICT: both edits present after the room was dropped', bl.join('|').includes('Sierra first. one') && bl.join('|').includes('Sierra second. two'), JSON.stringify(bl));
      await s.context.close();
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
