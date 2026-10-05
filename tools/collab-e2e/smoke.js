const L = require('./lib');

(async () => {
  const sub = await L.createSubmission(['First paragraph text.', 'Second paragraph text here.', 'Third one.']);
  console.log('submission', sub.id);
  const browser = await L.launch();
  try {
    const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
    const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
    await L.sleep(1500);
    console.log('A blocks', await L.blocks(a));
    console.log('B blocks', await L.blocks(b));
    console.log('A errors', a.errors.slice(0, 5));
    console.log('B errors', b.errors.slice(0, 5));
    console.log('A logs', a.logs.slice(0, 10));
    console.log('A sockets', [...a.sockets.values()]);
    console.log('A room sent', a.roomSent);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
