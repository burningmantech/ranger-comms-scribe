const L = require('./lib');
const PARAS = ['First paragraph text.', 'Second paragraph text here.', 'Third one.'];
(async () => {
  const browser = await L.launch();
  try {
    const sub = await L.createSubmission(PARAS);
    const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
    const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
    await L.converged(a, b);
    await L.select(a, 2, 0, 5);
    await a.page.keyboard.press('Backspace');
    await L.sleep(6000);
    for (const u of [a, b]) {
      const ids = await u.page.$$eval(`${L.EDITOR} .tracked-deletion-wrapper`, (els) => els.map((e) => e.getAttribute('data-change-id')));
      console.log(u.name, 'markers', ids);
    }
    const { changes } = await L.api(`/tracked-changes/submission/${sub.id}`);
    console.log('changes', changes.map((c) => ({ id: c.id, by: c.changedBy, old: c.oldValue, new: c.newValue, hasPending: (c.richTextNewValue || '').includes('__pending_deletion__') })));
    console.log('A logs', a.logs.slice(-10));
    // Sidebar markup on B
    await b.page.reload({ waitUntil: 'domcontentloaded' });
    await b.page.waitForSelector(`${L.EDITOR}[contenteditable="true"]`);
    await L.sleep(1000);
    const items = await b.page.$$eval('.change-item', (els) => els.map((e) => ({ id: e.getAttribute('data-change-id'), buttons: [...e.querySelectorAll('button')].map((x) => x.title || x.textContent) })));
    console.log('B sidebar items', JSON.stringify(items));
    const groups = await b.page.$$eval('.change-group', (els) => els.map((e) => e.outerHTML.slice(0, 300)));
    console.log('B groups', groups.length, groups[0]);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
