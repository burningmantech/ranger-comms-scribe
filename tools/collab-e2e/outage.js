// Outage handling: read-only while the Yjs socket is down; a short outage resumes the same doc,
// a long one (> 20 s) starts a fresh doc. Either way: no duplicated content.
const L = require('./lib');
const PARAS = ['First paragraph text.', 'Second paragraph text here.', 'Third one.'];

async function editable(u) {
  return u.page.$eval(L.EDITOR, (el) => el.getAttribute('contenteditable'));
}

(async () => {
  const browser = await L.launch();
  let failed = 0;
  const report = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };
  try {
    for (const [label, outageMs] of (process.env.ONLY_RESEED ? [] : process.env.ONLY_LONG ? [['long (26 s)', 26000]] : [['short (5 s)', 5000], ['long (26 s)', 26000]])) {
      const sub = await L.createSubmission(PARAS);
      const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
      const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
      await L.converged(a, b);
      await L.caret(b, 1);
      await b.page.keyboard.type(' before', { delay: 30 });
      await L.converged(a, b);

      const bWsBefore = [...b.sockets.values()].filter((u) => u.includes('/ws/yjs/')).length;
      await b.dropConnections();
      let readOnly = false;
      try {
        await L.waitFor(async () => (await editable(b)) === 'false', 'B read-only while offline', 8000);
        readOnly = true;
      } catch { /* reported below */ }
      report(readOnly, `${label}: B's editor is read-only while its Yjs socket is down`);

      await L.caret(a, 0);
      await a.page.keyboard.type(' during', { delay: 30 });
      await L.sleep(outageMs);
      await b.restoreConnections();
      await L.waitFor(async () => (await editable(b)) === 'true', 'B editable again', 20000);
      let x;
      try { x = await L.converged(a, b); } catch (e) {
        console.log('DIVERGED A', JSON.stringify(await L.blocks(a)), 'B', JSON.stringify(await L.blocks(b)), 'B editable', await editable(b), 'B logs', b.logs.join(' | '), 'B errors', b.errors.slice(0, 5).join(' | '));
        throw e;
      }
      const t = x.join('\n');
      const bWsAfter = [...b.sockets.values()].filter((u) => u.includes('/ws/yjs/')).length;
      report(L.count(t, 'during') === 1 && L.count(t, 'before') === 1 && L.count(t, 'First paragraph') === 1 && L.count(t, 'Third one') === 1,
        `${label}: after reconnect both editors match with nothing duplicated: ${JSON.stringify(x)} (B yjs sockets ${bWsBefore} -> ${bWsAfter})`);

      const fresh = b.logs.some((l) => l.includes('fresh document'));
      report(fresh === outageMs > 20000, `${label}: fresh Yjs document after the outage: ${fresh}`);
      await L.caret(b, 2);
      await b.page.keyboard.type(' after', { delay: 30 });
      const y = await L.converged(a, b);
      report(L.count(y.join('\n'), 'after') === 1, `${label}: editing works after reconnect: ${JSON.stringify(y)}`);
      const errs = [...a.errors, ...b.errors].filter((e) => !/ERR_INTERNET_DISCONNECTED|WebSocket|net::|Failed to fetch|Session expired or invalid/.test(e));
      report(errs.length === 0, `${label}: no unexpected console errors ${errs.slice(0, 2).join(' | ')}`);
      await a.context.close();
      await b.context.close();
    }
    // The room is destroyed and seeded again from saved content while B is offline.
    {
      const label = 'room re-seeded while B was offline (45 s)';
      const sub = await L.createSubmission(PARAS);
      const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
      const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
      await L.converged(a, b);
      await L.caret(a, 1);
      await a.page.keyboard.type(' saved', { delay: 30 });
      await L.converged(a, b);
      await L.sleep(4500); // A's change saves (it becomes the saved proposed content)
      await b.dropConnections();
      await a.context.close(); // last client leaves; the server destroys the room 30 s later
      await L.sleep(33000);
      const a2 = await L.openUser(browser, 'A2', 'dev-admin-session', sub.id); // seeds a new room from saved content
      await L.sleep(1000);
      await L.caret(a2, 2);
      await a2.page.keyboard.type(' new', { delay: 30 });
      await L.sleep(12000 - 1000);
      await b.restoreConnections();
      await L.waitFor(async () => (await editable(b)) === 'true', 'B editable again', 20000);
      const x = await L.converged(a2, b);
      const t = x.join('\n');
      report(L.count(t, 'saved') === 1 && L.count(t, 'First paragraph') === 1 && L.count(t, 'new') === 1,
        `${label}: B rejoins without duplicating the document: ${JSON.stringify(x)}`);
      await a2.context.close();
      await b.context.close();
    }
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
