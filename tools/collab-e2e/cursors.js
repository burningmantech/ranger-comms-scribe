// Remote caret rendering (Yjs awareness) and console-noise count.
const L = require('./lib');
const PARAS = ['First paragraph text.', 'Second paragraph text here.', 'Third one.'];
(async () => {
  const browser = await L.launch();
  try {
    const sub = await L.createSubmission(PARAS);
    const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
    const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
    let warnings = 0;
    a.page.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('Invalid access')) warnings++; });
    await L.converged(a, b);
    await L.caret(b, 1, 6);
    await b.page.keyboard.type('X', { delay: 30 });
    await L.sleep(800);
    const info = await a.page.evaluate(() => {
      const c = document.querySelector('.collab-cursors-container');
      const spans = c ? [...c.querySelectorAll('span')].map((s) => ({ text: s.textContent, style: s.getAttribute('style') })) : [];
      return { container: !!c, spans: spans.slice(0, 4) };
    });
    console.log('A sees remote cursor elements:', JSON.stringify(info));
    const presence = await a.page.$$eval('.presence-avatar', (els) => els.map((e) => e.getAttribute('title')));
    console.log('presence avatars on A:', JSON.stringify(presence));
    await a.page.screenshot({ path: 'cursor-A.png', clip: { x: 0, y: 0, width: 1400, height: 900 } });
    await L.caret(a, 0, 3);
    await a.page.keyboard.type('Y', { delay: 30 });
    await L.sleep(500);
    console.log('"Invalid access" console warnings on A during this run:', warnings);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
