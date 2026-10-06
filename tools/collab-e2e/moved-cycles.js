// Reject / Undo cycles on a Moved card, a plain change and an accept (collaborative mode).
//
// The dev-site bug: A cuts a paragraph and its list and pastes them lower down (one Moved
// card: deletion D + insertion I). B rejects the card, undoes it from History, and rejects
// it again: the document went back to its original order and the card went away, but the
// server kept I pending (D rejected), and History still offered Undo on a "Moved" entry.
//
// Here B runs reject -> undo (History) -> reject -> undo -> reject on the Moved card and, at
// every step, checks that the server has both halves in the same state, matching the
// document (the moved text in its new place when pending, back in place when rejected),
// the Open list and History (an entry is listed only when all its changes are in the state
// it shows). Then the same for a plain change (reject/undo twice) and for Accept + undo.
//
// Every status PUT and undo POST B makes is logged with its body and response (cascade ids
// included) when a check fails, or always with VERBOSE=1. RUNS=n repeats the scenario.
const L = require('./lib');

const SIDEBAR = '.editor-sidebar';

const text = (t, format = 0) => ({ type: 'text', version: 1, text: t, format, style: '', mode: 'normal', detail: 0 });
const para = (...children) => ({ type: 'paragraph', version: 1, format: '', indent: 0, direction: 'ltr', textFormat: 0, textStyle: '', children });
const list = (...items) => ({
  type: 'list', version: 1, listType: 'bullet', start: 1, tag: 'ul', format: '', indent: 0, direction: 'ltr',
  children: items.map((t, i) => ({ type: 'listitem', version: 1, value: i + 1, format: '', indent: 0, direction: 'ltr', children: [text(t)] })),
});

const MOVED_HEAD = 'New for 2026:';
const BLOCKS = [
  para(text('Rangers Ticketing Team')),
  para(text('The Clubhouse Ticketing is now open. Read everything below.')),
  para(text(MOVED_HEAD, 1), text(' '), { type: 'linebreak', version: 1 }),
  list('Special Price Tickets will cost $250 plus fees.', 'All Setup Access Passes are sent in one email.'),
  para(text('Key Things to Know for 2026:')),
  list('Only claim a Vehicle Pass if you need one.', 'Make sure you pay for both in one cart.'),
  para(),
  para(text('General Info:')),
  para(text('Last paragraph text.')),
];
const TYPED = ' Typed by A.';

async function createSubmission() {
  const content = JSON.stringify({ root: { type: 'root', version: 1, format: '', indent: 0, direction: 'ltr', children: BLOCKS } });
  return L.api('/content/submissions', {
    method: 'POST',
    body: { title: `E2E moved cycles ${new Date().toISOString()}`, content, status: 'submitted', requiredApprovers: ['user2@localhost'] },
  });
}

async function shortcut(u, key, command) {
  await u.page.keyboard.down('Meta');
  await u.page.keyboard.press(key, { commands: [command] });
  await u.page.keyboard.up('Meta');
}

/** Select from the start of block `from` to the end of block `to` (a paragraph and its list). */
async function selectBlocks(u, from, to) {
  await u.page.evaluate((sel, from, to) => {
    const root = document.querySelector(sel);
    const texts = (el) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest('.tracked-deletion-wrapper') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const out = [];
      let n;
      while ((n = w.nextNode())) out.push(n);
      return out;
    };
    const first = texts(root.children[from])[0];
    const lastList = texts(root.children[to]);
    const last = lastList[lastList.length - 1];
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.textContent.length);
    root.focus();
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }, L.EDITOR, from, to);
  await L.sleep(80);
}

async function caretInEmpty(u, index) {
  await u.page.evaluate((sel, index) => {
    const root = document.querySelector(sel);
    const range = document.createRange();
    range.setStart(root.children[index], 0);
    range.collapse(true);
    root.focus();
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }, L.EDITOR, index);
  await L.sleep(80);
}

function cards(u) {
  return u.page.$$eval(`${SIDEBAR} .rp-card`, (els) => els.map((e) => ({
    ids: (e.getAttribute('data-change-ids') || '').split(' ').filter(Boolean),
    text: (e.querySelector('.rp-desc') || e).textContent.trim(),
  })));
}
async function cardButton(u, ids, title) {
  for (const el of await u.page.$$(`${SIDEBAR} .rp-card`)) {
    const cardIds = await el.evaluate((e) => e.getAttribute('data-change-ids') || '');
    if (cardIds === ids.join(' ')) return el.$(`button[title="${title}"]`);
  }
  return null;
}
const hasCard = async (u, ids) => (await cards(u)).some((c) => c.ids.join(' ') === ids.join(' '));

async function tab(u, n) {
  await (await u.page.$(`${SIDEBAR} .rp-tab:nth-child(${n})`)).click();
  await L.sleep(200);
}
/** History entries: text, the ids they cover (data-change-ids when present) and whether Undo is offered. */
async function history(u) {
  await tab(u, 2);
  const items = await u.page.$$eval(`${SIDEBAR} .rp-history__item`, (els) => els.map((e) => ({
    text: e.textContent.replace(/\s+/g, ' ').trim(),
    ids: (e.getAttribute('data-history-ids') || '').split(' ').filter(Boolean),
    undo: !!e.querySelector('.rp-history__undo'),
  })));
  await tab(u, 1);
  return items;
}
async function historyUndo(u, match) {
  await tab(u, 2);
  for (const el of await u.page.$$(`${SIDEBAR} .rp-history__item`)) {
    const t = await el.evaluate((e) => e.textContent.replace(/\s+/g, ' ').trim());
    if (match(t)) {
      const btn = await el.$('.rp-history__undo');
      if (!btn) throw new Error(`History entry has no Undo: ${t}`);
      await btn.click();
      await L.sleep(300);
      await tab(u, 1);
      return t;
    }
  }
  throw new Error(`no History entry matches: ${JSON.stringify(await history(u))}`);
}

async function statuses(subId, ids) {
  const { changes } = await L.api(`/tracked-changes/submission/${subId}`);
  return ids.map((id) => {
    const c = changes.find((x) => x.id === id);
    return c ? c.status : 'missing';
  });
}

/** B's network calls to the status / undo endpoints, with bodies and responses. */
function recordNetwork(u) {
  const calls = [];
  u.page.on('request', (req) => {
    const url = req.url();
    if (!/\/tracked-changes\/(change\/[^/]+\/status|[^/]+\/undo|batch)/.test(url)) return;
    let body = req.postData() || '';
    try {
      const j = JSON.parse(body);
      for (const k of ['revertedRichText', 'proposedVersionsRichText']) if (j[k]) j[k] = `<${j[k].length} chars>`;
      body = JSON.stringify(j);
    } catch { /* not JSON */ }
    calls.push({ at: Date.now(), method: req.method(), url: url.replace(/^.*\/tracked-changes\//, ''), body, req });
  });
  u.page.on('response', async (res) => {
    const call = calls.find((c) => c.req === res.request());
    if (!call) return;
    let t = await res.text().catch(() => '');
    try {
      const j = JSON.parse(t);
      if (j.change) j.change = { id: j.change.id, status: j.change.status, reappliedAt: j.change.reappliedAt };
      t = JSON.stringify(j);
    } catch { /* keep */ }
    call.status = res.status();
    call.response = t.slice(0, 300);
  });
  return calls;
}

async function run(browser, n) {
  const verbose = process.env.VERBOSE === '1';
  const sub = await createSubmission();
  const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
  const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
  const APP = new URL(a.page.url()).origin;
  for (const u of [a, b]) {
    await u.context.overridePermissions(APP, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  }
  const calls = recordNetwork(b);
  // Status PUTs to hold back (id -> ms): the dev site's latency lets one half's PUT reach the
  // server well after the other's, so the first one cascades to the second.
  const delayPut = new Map();
  await b.page.setRequestInterception(true);
  b.page.on('request', (req) => {
    const m = req.method() === 'PUT' && req.url().match(/\/tracked-changes\/change\/([^/]+)\/status/);
    const ms = m && delayPut.get(m[1]);
    if (ms) setTimeout(() => req.continue().catch(() => {}), ms);
    else req.continue().catch(() => {});
  });
  const consoleLog = [];
  b.page.on('console', (msg) => {
    const t = msg.text();
    if (/\[RESOLVE\] (handleChangeDecision|cascaded)|\[UNDO\]|back to pending|Could not set|Undo failed/.test(t)) consoleLog.push(`B ${t.slice(0, 220)}`);
  });
  const t0 = Date.now();
  const step = (msg) => console.log(`[run ${n}] +${((Date.now() - t0) / 1000).toFixed(1)}s ${msg}`);
  const dump = () => {
    for (const c of calls) console.log(`  ${((c.at - t0) / 1000).toFixed(1)}s ${c.method} ${c.url} ${c.body} -> ${c.status} ${c.response}`);
    for (const l of consoleLog) console.log(`  ${l}`);
  };

  try {
    const original = await L.converged(a, b);

    // A types at the end of the last paragraph (a plain change, used later).
    await L.caret(a, original.length - 1);
    await a.page.keyboard.type(TYPED, { delay: 25 });
    await L.sleep(3500);
    const beforeCut = await L.converged(a, b);

    // A cuts "New for 2026:" + its list and pastes them over the empty paragraph.
    await selectBlocks(a, 2, 3);
    await shortcut(a, 'KeyX', 'Cut');
    await L.sleep(3500);
    const afterCut = await L.blocks(a);
    const emptyIdx = afterCut.findIndex((t, i) => i > 3 && t === '' && afterCut[i + 1] === 'General Info:');
    if (emptyIdx < 0) throw new Error(`no empty paragraph before General Info: ${JSON.stringify(afterCut)}`);
    await caretInEmpty(a, emptyIdx);
    await shortcut(a, 'KeyV', 'Paste');
    await L.sleep(3500);
    const moved = await L.converged(a, b);
    if (moved.findIndex((t) => t.startsWith(MOVED_HEAD)) <= 3) throw new Error(`paste did not land lower down: ${JSON.stringify(moved)}`);

    const move = await L.waitFor(async () => (await cards(b)).find((c) => c.text.startsWith('Moved:')), 'B sees the Moved card', 15000);
    const typed = await L.waitFor(async () => (await cards(b)).find((c) => /Typed by A/.test(c.text) && !c.text.startsWith('Moved:')), 'B sees the typed card', 15000);
    if (move.ids.length !== 2) throw new Error(`Moved card should hold two changes: ${JSON.stringify(move)}`);
    step(`setup: move ${move.ids.join(' + ')}, typed ${typed.ids.join(' ')}`);

    const nonEmpty = (bl) => bl.filter((t) => t.trim() !== '');
    const sameText = (x, y) => JSON.stringify(nonEmpty(x)) === JSON.stringify(nonEmpty(y));

    /**
     * After a decision or an undo: the server has every id in `want`, stably (still after
     * 4 s), both documents show `doc`, the card is open for both exactly when pending, and
     * History lists an entry for these ids only with all of them in that state.
     */
    async function check(label, ids, want, doc, entryRe) {
      await L.waitFor(async () => (await statuses(sub.id, ids)).every((s) => s === want), `${label}: server has ${want}`, 10000)
        .catch(async (e) => { console.log(`  server: ${JSON.stringify(await statuses(sub.id, ids))}`); throw e; });
      await L.sleep(4000);
      const st = await statuses(sub.id, ids);
      if (!st.every((s) => s === want)) throw new Error(`${label}: server drifted to ${JSON.stringify(st)} (want all ${want})`);
      const docs = await L.converged(a, b);
      if (!sameText(docs, doc)) throw new Error(`${label}: document\n${JSON.stringify(docs)}\nexpected\n${JSON.stringify(doc)}`);
      for (const u of [a, b]) {
        await L.waitFor(async () => (await hasCard(u, ids)) === (want === 'pending'), `${label}: ${u.name}'s card ${want === 'pending' ? 'shown' : 'hidden'}`, 10000);
      }
      const h = await history(b);
      const entries = h.filter((e) => entryRe.test(e.text));
      if (want === 'pending' && entries.some((e) => e.undo)) throw new Error(`${label}: History still offers Undo: ${JSON.stringify(entries)}`);
      if (want !== 'pending') {
        const verb = want === 'rejected' ? 'Rejected' : 'Accepted';
        if (entries.length !== 1 || !entries[0].text.startsWith(verb) || !entries[0].undo) {
          throw new Error(`${label}: History should list one ${verb} entry with Undo: ${JSON.stringify(h)}`);
        }
      }
      step(`${label}: server ${JSON.stringify(st)}, document ok, cards ok, History ${JSON.stringify(entries.map((e) => `${e.text.slice(0, 30)}${e.undo ? ' [Undo]' : ''}`))}`);
    }

    const isMove = /Moved:/;
    // Moved card: reject, undo, reject, undo, reject.
    // Cycle 1 as is; cycle 2 holds back the insertion's PUT (the deletion's reaches the
    // server first and cascades to the insertion, as on the dev site); cycle 3 the deletion's.
    for (let cycle = 1; cycle <= 3; cycle++) {
      delayPut.clear();
      if (cycle === 2) delayPut.set(move.ids[1], 1500);
      if (cycle === 3) delayPut.set(move.ids[0], 1500);
      await (await cardButton(b, move.ids, 'Reject')).click();
      await check(`move reject #${cycle}`, move.ids, 'rejected', beforeCut, isMove);
      if (cycle === 3) break;
      await historyUndo(b, (t) => isMove.test(t));
      await check(`move undo #${cycle}`, move.ids, 'pending', moved, isMove);
    }

    // Plain change: reject, undo, reject, undo.
    const isTyped = /Typed by A/;
    const withoutTyped = beforeCut.map((t) => t.replace(TYPED, ''));
    for (let cycle = 1; cycle <= 2; cycle++) {
      await (await cardButton(b, typed.ids, 'Reject')).click();
      await check(`plain reject #${cycle}`, typed.ids, 'rejected', withoutTyped, isTyped);
      await historyUndo(b, (t) => isTyped.test(t) && !isMove.test(t));
      await check(`plain undo #${cycle}`, typed.ids, 'pending', beforeCut, isTyped);
    }

    // Moved card: undo the last reject, then Accept + undo, twice.
    await historyUndo(b, (t) => isMove.test(t));
    await check('move undo #3', move.ids, 'pending', moved, isMove);
    for (let cycle = 1; cycle <= 2; cycle++) {
      await (await cardButton(b, move.ids, 'Accept')).click();
      await check(`move accept #${cycle}`, move.ids, 'approved', moved, isMove);
      await historyUndo(b, (t) => isMove.test(t));
      await check(`move accept-undo #${cycle}`, move.ids, 'pending', moved, isMove);
    }

    // The state the dev bug left behind, forced: the move rejected, then only the insertion
    // set back to pending on the server (its text stays gone, the deletion's text is back
    // where it was cut). After a reload B sees it as an "Added" card; rejecting it must
    // succeed without changing the document (its text is already gone), not fail with
    // "Couldn't revert", and never remove the deletion's restored copy.
    delayPut.clear();
    await (await cardButton(b, move.ids, 'Reject')).click();
    await check('move reject #4', move.ids, 'rejected', beforeCut, isMove);
    const [delId, insId] = move.ids;
    await L.api(`/tracked-changes/${insId}/undo`, { method: 'POST', body: { submissionId: sub.id } });
    if (JSON.stringify(await statuses(sub.id, move.ids)) !== '["rejected","pending"]') {
      throw new Error(`forced state: ${JSON.stringify(await statuses(sub.id, move.ids))}`);
    }
    await b.page.reload({ waitUntil: 'domcontentloaded' });
    await b.page.waitForSelector(`${L.EDITOR}[contenteditable="true"]`, { timeout: 20000 });
    const added = await L.waitFor(async () => (await cards(b)).find((c) => c.ids.join(' ') === insId), 'B sees the insertion as its own card after a reload', 15000)
      .catch(async (e) => { console.log('B cards', JSON.stringify(await cards(b))); throw e; });
    if (!added.text.startsWith('Added:')) throw new Error(`the lone insertion's card: ${JSON.stringify(added)}`);
    const docBefore = await L.converged(a, b);
    if (!sameText(docBefore, beforeCut)) throw new Error(`forced state document: ${JSON.stringify(docBefore)}`);
    await (await cardButton(b, [insId], 'Reject')).click();
    await L.sleep(1500);
    if (await b.page.evaluate(() => /Couldn't revert/.test(document.body.innerText))) {
      throw new Error('"Couldn\'t revert" toast when rejecting an insertion whose text is already gone');
    }
    await check('lone insertion reject', move.ids, 'rejected', beforeCut, isMove);
    const docAfter = await L.converged(a, b);
    if (JSON.stringify(docAfter) !== JSON.stringify(docBefore)) {
      throw new Error(`rejecting the gone insertion changed the document:\n${JSON.stringify(docAfter)}\nwas\n${JSON.stringify(docBefore)}`);
    }
    step(`lone insertion ${insId.slice(0, 8)} (deletion ${delId.slice(0, 8)} rejected) rejected as a no-op`);

    // A fresh load (no local decisions): Open and History come from the server alone.
    await b.page.reload({ waitUntil: 'domcontentloaded' });
    await b.page.waitForSelector(`${L.EDITOR}[contenteditable="true"]`, { timeout: 20000 });
    await L.waitFor(async () => (await cards(b)).some((c) => /Typed by A/.test(c.text)), 'B reloaded: the typed card', 15000);
    if ((await cards(b)).some((c) => c.ids.some((id) => move.ids.includes(id)))) throw new Error('reloaded: a card for the rejected move');
    const reloaded = (await history(b)).filter((e) => isMove.test(e.text));
    if (reloaded.length !== 1 || !reloaded[0].text.startsWith('Rejected') || !reloaded[0].undo) {
      throw new Error(`reloaded History: ${JSON.stringify(reloaded)}`);
    }
    step('reloaded: Open and History match the server');

    if (verbose) dump();
    for (const u of [a, b]) {
      const errors = u.errors.filter((e) => !/favicon|DevTools|Failed to load resource/.test(e));
      if (errors.length) console.log(`[run ${n}] ${u.name} console errors:`, errors.slice(0, 5));
    }
  } catch (e) {
    console.log(`[run ${n}] network and console log:`);
    dump();
    throw e;
  } finally {
    await a.context.close();
    await b.context.close();
  }
}

(async () => {
  const runs = Number(process.env.RUNS || 1);
  const browser = await L.launch();
  let passed = 0;
  try {
    for (let n = 1; n <= runs; n++) {
      try {
        await run(browser, n);
        passed++;
        console.log(`[run ${n}] PASS`);
      } catch (e) {
        console.error(`[run ${n}] FAIL: ${e.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`moved-cycles: ${passed}/${runs} passed`);
  process.exit(passed === runs ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
