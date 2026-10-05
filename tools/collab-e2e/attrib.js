const L = require('./lib');
const PARAS = ['First paragraph text.', 'Second paragraph text here.', 'Third one.'];
(async () => {
  const browser = await L.launch();
  try {
    const sub = await L.createSubmission(PARAS);
    const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
    const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
    await L.converged(a, b);
    await L.caret(a, 0);
    await L.caret(b, 2);
    await Promise.all([a.page.keyboard.type(' Alpha', { delay: 35 }), b.page.keyboard.type(' Bravo', { delay: 35 })]);
    console.log(await L.converged(a, b));
    await L.sleep(4500);
    const { changes } = await L.api(`/tracked-changes/submission/${sub.id}`);
    for (const c of changes.filter((c) => c.field === 'content')) {
      console.log(c.changedBy, JSON.stringify(c.oldValue), '->', JSON.stringify(c.newValue), c.timestamp);
    }
    console.log('A logs', a.logs.slice(-12));
    console.log('B logs', b.logs.slice(-12));
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
