// Editor remounts: tab switch away and back; queue navigation to another submission.
const L = require('./lib');
(async () => {
  const browser = await L.launch();
  let failed = 0;
  const report = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };
  try {
    const other = await L.createSubmission(['Other submission body.']);
    const sub = await L.createSubmission(['First paragraph text.', 'Second paragraph text here.']);
    const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
    const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
    await L.converged(a, b);

    // B leaves the Proposed tab (editor unmounts), A types, B comes back.
    const clickTab = async (u, label) => {
      const tabs = await u.page.$$('.tce-tab');
      for (const t of tabs) if ((await t.evaluate((e) => e.textContent.trim())) === label) { await t.click(); return; }
      throw new Error(`no tab ${label}`);
    };
    await clickTab(b, 'Original Version');
    await L.sleep(500);
    await L.caret(a, 0);
    await a.page.keyboard.type(' while-away', { delay: 30 });
    await clickTab(b, 'Proposed Version');
    await b.page.waitForSelector(`${L.EDITOR}[contenteditable="true"]`, { timeout: 15000 });
    const x = await L.converged(a, b);
    report(L.count(x.join('\n'), 'while-away') === 1 && L.count(x.join('\n'), 'First paragraph') === 1, `tab switch away and back: ${JSON.stringify(x)}`);
    await L.caret(b, 1);
    await b.page.keyboard.type(' back', { delay: 30 });
    const y = await L.converged(a, b);
    report(L.count(y.join('\n'), 'back') === 1, `editing after returning: ${JSON.stringify(y)}`);

    // Queue navigation (same page, different submission): B must get the other room.
    const prev = await b.page.$('.queue-navigator button, button[title*="revious"]');
    if (prev) {
      await b.page.evaluate((id) => { window.history.pushState({}, '', `/tracked-changes/${id}`); window.dispatchEvent(new PopStateEvent('popstate')); }, other.id);
      await L.waitFor(async () => (await L.blocks(b)).join('') === 'Other submission body.', 'B shows the other submission', 15000);
      report(true, 'navigating to another submission shows its content');
      await L.caret(b, 0);
      await b.page.keyboard.type(' nav', { delay: 30 });
      await L.sleep(1500);
      const ax = await L.blocks(a);
      report(!ax.join('').includes('nav') && !ax.join('').includes('Other submission'), `the first submission is untouched: ${JSON.stringify(ax)}`);
    } else {
      report(false, 'no queue navigator found');
    }
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
