// Legacy mode (COLLAB_MODE unset): the old whole-document sync must be what runs.
const L = require('./lib');
const PARAS = ['First paragraph text.', 'Second paragraph text here.', 'Third one.'];
(async () => {
  const cfg = await (await fetch(`${L.API}/config`)).json();
  console.log('GET /api/config ->', JSON.stringify(cfg));
  const browser = await L.launch();
  let failed = 0;
  const report = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };
  try {
    const sub = await L.createSubmission(PARAS);
    const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
    const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
    await L.sleep(1500);
    report(JSON.stringify(await L.blocks(a)) === JSON.stringify(PARAS) && JSON.stringify(await L.blocks(b)) === JSON.stringify(PARAS), 'content loads in both editors (legacy init path)');
    await L.caret(a, 0);
    await a.page.keyboard.type(' Legacy', { delay: 40 });
    const x = await L.converged(a, b);
    report(x[0] === 'First paragraph text. Legacy', `one typist, other editor follows: ${JSON.stringify(x)}`);
    await L.sleep(4000);
    const yjsSockets = [...a.sockets.values(), ...b.sockets.values()].filter((u) => u.includes('/ws/yjs/'));
    report(yjsSockets.length === 0, `no Yjs socket opened (${yjsSockets.length})`);
    const types = [...new Set(a.roomSent)];
    report(types.includes('realtime_content_update') && types.includes('content_updated') && types.includes('cursor_position'),
      `room socket carries the legacy messages: ${types.join(',')}`);
    const { changes } = await L.api(`/tracked-changes/submission/${sub.id}`);
    report(changes.filter((c) => c.field === 'content').length >= 1, `tracked change saved (${changes.length})`);
    report(a.changePosts.length >= 1 && a.changePosts.every((b) => !b.includes('diffAgainstOldValue')),
      `tracked-change POSTs carry no diffAgainstOldValue (${a.changePosts.length} POSTs)`);
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
