// Review sidebar end to end (collaborative mode): the "Moved" card, reject, Undo, accept,
// History, and clicking a card to scroll to its text.
//
//   A types a sentence at the end of the document, then cuts a paragraph and pastes it
//   lower down (real Cmd+X / Cmd+V). B sees one "Moved" card and rejects it: A's card goes
//   away live and both documents are back to before the cut. B clicks Undo in the toast:
//   the move comes back in both documents and the card reappears. B accepts it: the card
//   goes away and History shows it. Clicking A's other card scrolls B's editor to its text.
//
// RUNS=n repeats the scenario.
const L = require('./lib');

const FILLER = Array.from({ length: 30 }, (_, i) => `Filler paragraph number ${i + 1} with a few words in it.`);
const MOVED = 'Moved paragraph with several words in it.';
const PARAS = ['Intro paragraph here.', MOVED, 'Middle paragraph text.', ...FILLER, 'Last paragraph text.'];
const TYPED = ' Typed by A.';

const SIDEBAR = '.editor-sidebar';

/** Cmd+<key> with the editing command Chrome runs for it (Cut, Paste): real key events. */
async function shortcut(u, key, command) {
  await u.page.keyboard.down('Meta');
  await u.page.keyboard.press(key, { commands: [command] });
  await u.page.keyboard.up('Meta');
}

/** The Open list's cards: ids and plain-language text. */
function cards(u) {
  return u.page.$$eval(`${SIDEBAR} .rp-card`, (els) => els.map((e) => ({
    ids: (e.getAttribute('data-change-ids') || '').split(' ').filter(Boolean),
    text: (e.querySelector('.rp-desc') || e).textContent.trim(),
  })));
}

async function cardHandle(u, prefix) {
  for (const el of await u.page.$$(`${SIDEBAR} .rp-card`)) {
    const text = await el.$eval('.rp-desc', (d) => d.textContent.trim()).catch(() => '');
    if (text.startsWith(prefix)) return el;
  }
  return null;
}

const movedCards = async (u) => (await cards(u)).filter((c) => c.text.startsWith('Moved:'));
const nonEmpty = (blocks) => blocks.filter((b) => b.trim() !== '');

async function serverStatus(subId) {
  const { changes } = await L.api(`/tracked-changes/submission/${subId}`);
  return changes;
}

async function run(browser, n) {
  const sub = await L.createSubmission(PARAS);
  const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
  const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
  const APP = new URL(a.page.url()).origin;
  for (const u of [a, b]) {
    await u.context.overridePermissions(APP, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  }
  await L.converged(a, b);
  const t0 = Date.now();
  const step = (msg) => console.log(`[run ${n}] +${((Date.now() - t0) / 1000).toFixed(1)}s ${msg} (console errors so far: A ${a.errors.length}, B ${b.errors.length})`);

  // 1. A types at the end of the last paragraph (its own tracked change).
  const last = PARAS.length - 1;
  await L.caret(a, last);
  await a.page.keyboard.type(TYPED, { delay: 25 });
  await L.sleep(3500); // settle (2.5 s pause) and save
  step('A typed');

  // 2. A cuts paragraph 1 (its whole text) ...
  await L.select(a, 1, 0, MOVED.length);
  await shortcut(a, 'KeyX', 'Cut');
  await L.sleep(3500);
  const beforeCutExpected = [PARAS[0], MOVED, PARAS[2], ...FILLER, PARAS[last] + TYPED];
  step(`A cut: block 1 is now ${JSON.stringify((await L.blocks(a))[1])}`);

  // ... and pastes it as a new paragraph after "Middle paragraph text." (block 2).
  await L.caret(a, 2);
  await a.page.keyboard.press('Enter');
  await shortcut(a, 'KeyV', 'Paste');
  await L.sleep(3500);
  const moved = await L.converged(a, b);
  if (!moved.includes(MOVED) || moved[1] !== '') throw new Error(`paste did not land: ${JSON.stringify(moved.slice(0, 5))}`);
  step('A pasted');

  // 3. B sees one "Moved" card (and A's typing as its own card).
  await L.waitFor(async () => (await movedCards(b)).length === 1, 'B sees one Moved card', 15000);
  const bCards = await cards(b);
  const move = (await movedCards(b))[0];
  console.log(`[run ${n}] B cards:`, JSON.stringify(bCards.map((c) => c.text.slice(0, 60))));
  if (move.ids.length !== 2) throw new Error(`Moved card should hold two changes: ${JSON.stringify(move)}`);
  if (bCards.some((c) => /^(Added|Deleted):\s*Moved paragraph/.test(c.text))) throw new Error('the move halves are shown separately');
  await L.waitFor(async () => (await movedCards(a)).length === 1, 'A sees the Moved card too', 15000);

  // 4. B rejects the move: A's card disappears live; both documents are back to before the cut.
  const reject = await (await cardHandle(b, 'Moved:')).$('button[title="Reject"]');
  await reject.click();
  await L.waitFor(async () => (await movedCards(a)).length === 0, "A's Moved card disappears live", 10000);
  const restored = await L.converged(a, b);
  if (JSON.stringify(nonEmpty(restored)) !== JSON.stringify(beforeCutExpected)) {
    throw new Error(`after reject: ${JSON.stringify(restored)}\nexpected ${JSON.stringify(beforeCutExpected)}`);
  }
  await L.waitFor(async () => (await serverStatus(sub.id)).filter((c) => move.ids.includes(c.id)).every((c) => c.status === 'rejected'), 'server: both rejected');
  step('B rejected: both documents back to before the cut, server has both rejected');

  // 5. B clicks Undo in the toast: the move comes back in both documents, the card reappears.
  const undo = await b.page.waitForSelector('.rp-undo-toast .rp-undo-toast__undo', { timeout: 5000 });
  const toastText = await b.page.$eval('.rp-undo-toast__message', (e) => e.textContent);
  if (toastText !== 'Rejected') throw new Error(`toast says ${toastText}`);
  await undo.click();
  await L.waitFor(async () => JSON.stringify(await L.blocks(b)) === JSON.stringify(moved), 'B: the move is back', 10000);
  const undone = await L.converged(a, b);
  if (JSON.stringify(undone) !== JSON.stringify(moved)) throw new Error(`after undo: ${JSON.stringify(undone)}`);
  await L.waitFor(async () => (await movedCards(b)).length === 1, "B's Moved card reappears", 10000);
  await L.waitFor(async () => (await movedCards(a)).length === 1, "A's Moved card reappears", 10000);
  await L.waitFor(async () => (await serverStatus(sub.id)).filter((c) => move.ids.includes(c.id)).every((c) => c.status === 'pending'), 'server: both pending');
  step('B undid: the move is back in both documents, cards back, server pending');

  // 6. B accepts the move: the card disappears (both sides) and History shows it.
  const accept = await (await cardHandle(b, 'Moved:')).$('button[title="Accept"]');
  await accept.click();
  await L.waitFor(async () => (await movedCards(b)).length === 0, "B's Moved card disappears", 10000);
  await L.waitFor(async () => (await movedCards(a)).length === 0, "A's Moved card disappears", 10000);
  const afterAccept = await L.converged(a, b);
  if (JSON.stringify(afterAccept) !== JSON.stringify(moved)) throw new Error(`accept changed the document: ${JSON.stringify(afterAccept)}`);
  await L.waitFor(async () => (await serverStatus(sub.id)).filter((c) => move.ids.includes(c.id)).every((c) => c.status === 'approved'), 'server: both approved');
  const historyTab = await b.page.$(`${SIDEBAR} .rp-tab:nth-child(2)`);
  await historyTab.click();
  const history = await L.waitFor(async () => {
    const items = await b.page.$$eval(`${SIDEBAR} .rp-history__item`, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    return items.length > 0 ? items : null;
  }, 'History lists the decision');
  if (!/Accepted by .*Moved:/.test(history[0])) throw new Error(`History: ${JSON.stringify(history)}`);
  step(`History: ${history[0].slice(0, 90)}`);

  // 6b. Undo the accept from History: only the status flips (the text is already there).
  const historyUndo = await b.page.$(`${SIDEBAR} .rp-history__item .rp-history__undo`);
  if (!historyUndo) throw new Error('no Undo in History');
  await historyUndo.click();
  await L.waitFor(async () => (await serverStatus(sub.id)).filter((c) => move.ids.includes(c.id)).every((c) => c.status === 'pending'), 'server: pending after undoing the accept');
  await (await b.page.$(`${SIDEBAR} .rp-tab:nth-child(1)`)).click();
  await L.waitFor(async () => (await movedCards(b)).length === 1, "B's Moved card is back after undoing the accept", 10000);
  await L.waitFor(async () => (await movedCards(a)).length === 1, "A's Moved card is back after undoing the accept", 10000);
  const afterUndoAccept = await L.converged(a, b);
  if (JSON.stringify(afterUndoAccept) !== JSON.stringify(moved)) throw new Error(`undoing the accept changed the document: ${JSON.stringify(afterUndoAccept)}`);
  const original = (await L.api(`/content/submissions/${sub.id}`)).richTextContent || '';
  step(`undid the accept from History: card back for both, documents unchanged, server pending; stored original ${original.includes(MOVED) ? 'still has' : 'lacks'} the moved text`);

  // 6c. Accept again: History shows the decision once.
  await (await (await cardHandle(b, 'Moved:')).$('button[title="Accept"]')).click();
  await L.waitFor(async () => (await movedCards(b)).length === 0 && (await movedCards(a)).length === 0, 'Moved card gone again', 10000);
  await L.waitFor(async () => (await serverStatus(sub.id)).filter((c) => move.ids.includes(c.id)).every((c) => c.status === 'approved'), 'server: approved again');
  await (await b.page.$(`${SIDEBAR} .rp-tab:nth-child(2)`)).click();
  const history2 = await b.page.$$eval(`${SIDEBAR} .rp-history__item`, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const moveEntries = history2.filter((h) => h.includes('Moved:'));
  if (moveEntries.length !== 1 || !/Accepted by/.test(moveEntries[0])) throw new Error(`History after re-accept: ${JSON.stringify(history2)}`);
  step('accepted again: History shows the move once');
  await (await b.page.$(`${SIDEBAR} .rp-tab:nth-child(1)`)).click();

  // 7. Clicking a card scrolls the editor to its text (A's typing, at the end of a long document).
  await b.page.evaluate(() => {
    window.scrollTo(0, 0);
    let el = document.querySelector('.proposed-collaborative-editor');
    while (el) { if (el.scrollTop) el.scrollTop = 0; el = el.parentElement; }
  });
  await L.sleep(300);
  const offscreen = await b.page.evaluate((sel) => {
    const blocks = document.querySelector(sel).children;
    const r = blocks[blocks.length - 1].getBoundingClientRect();
    return r.top > window.innerHeight || r.bottom < 0;
  }, L.EDITOR);
  const typedCard = await cardHandle(b, 'Added:');
  if (!typedCard) throw new Error(`no Added card: ${JSON.stringify(await cards(b))}`);
  await typedCard.click();
  await L.sleep(1200);
  const focus = await b.page.evaluate(() => {
    const h = CSS.highlights && CSS.highlights.get('tce-change-focus');
    if (!h) return null;
    const range = [...h][0];
    const r = range.getBoundingClientRect();
    return { text: range.toString(), top: r.top, bottom: r.bottom, vh: window.innerHeight };
  });
  if (!focus || !focus.text.includes('Typed by A')) throw new Error(`click did not highlight the text: ${JSON.stringify(focus)}`);
  if (!(focus.top >= 0 && focus.bottom <= focus.vh)) throw new Error(`click did not scroll to the text: ${JSON.stringify(focus)}`);
  step(`card click: was offscreen=${offscreen}, now highlighted ${JSON.stringify(focus.text)} at y=${Math.round(focus.top)} of ${focus.vh}`);

  for (const u of [a, b]) {
    const errors = u.errors.filter((e) => !/favicon|DevTools|Failed to load resource/.test(e));
    if (errors.length) console.log(`[run ${n}] ${u.name} console errors:`, errors.slice(0, 5));
  }
  await a.context.close();
  await b.context.close();
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
  console.log(`review-ui: ${passed}/${runs} passed`);
  process.exit(passed === runs ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
