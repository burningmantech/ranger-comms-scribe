// The dev-site Moved-card bug end to end (collaborative mode): a reject that failed because
// a stray deletion marker had been stamped with the cut's change id.
//
//   1. A types "\" in a list item and deletes it with Backspace (same transaction: no marker),
//      then deletes two saved characters in one transaction (two markers; before the fix only
//      the first was stamped and the second stayed pending, to be adopted by the next save).
//   2. A cuts the "New for 2026:" paragraph and its list (real Cmd+X) and pastes them over an
//      empty paragraph lower down (Cmd+V): one "Moved" card.
//   3. B rejects the Moved card.
//   4. Both documents are back to before the cut; no deletion marker is pending or carries
//      the cut's id; no "Couldn't revert" toast.
//   5. A failed decision is not replayed: A adds " Updated" in a second section, moves it and
//      rewrites the pasted heading, so B's reject of that move fails (all or nothing: the
//      document is unchanged). B then rejects the "Updated" card: only that card is decided,
//      and the move stays pending in the server and in both sidebars.
//
// Before the fix, step 1's second marker stayed pending, the cut's save stamped it with the
// cut's id, and step 3 failed with "Couldn't revert this change automatically".
//
// RUNS=n repeats the scenario.
const L = require('./lib');

const SIDEBAR = '.editor-sidebar';

const text = (t, format = 0) => ({ type: 'text', version: 1, text: t, format, style: '', mode: 'normal', detail: 0 });
const para = (...children) => ({ type: 'paragraph', version: 1, format: '', indent: 0, direction: 'ltr', textFormat: 0, textStyle: '', children });
const list = (...items) => ({
  type: 'list', version: 1, listType: 'bullet', start: 1, tag: 'ul', format: '', indent: 0, direction: 'ltr',
  children: items.map((t, i) => ({ type: 'listitem', version: 1, value: i + 1, format: '', indent: 0, direction: 'ltr', children: [text(t)] })),
});
const lb = () => ({ type: 'linebreak', version: 1 });

const BLOCKS = [
  para(text('Rangers Ticketing Team')),
  para(text('The Clubhouse Ticketing is now open. Read everything below.')),
  para(text('New for 2026:', 1), text(' '), lb()),
  list('Special Price Tickets will cost $250 plus fees.', 'All Setup Access Passes are sent in one email.'),
  para(text('Key Things to Know for 2026:')),
  list('Only claim a Vehicle Pass if you need one.', 'Make sure you pay for both in one cart.'),
  para(),
  para(text('General Info:')),
  para(text('Second section heading:')),
  list('First second-section item.', 'Second second-section item.'),
  para(),
  para(text('Last paragraph text.')),
];

async function createSubmission() {
  const content = JSON.stringify({ root: { type: 'root', version: 1, format: '', indent: 0, direction: 'ltr', children: BLOCKS } });
  return L.api('/content/submissions', {
    method: 'POST',
    body: { title: `E2E stray marker ${new Date().toISOString()}`, content, status: 'submitted', requiredApprovers: ['user2@localhost'] },
  });
}

async function shortcut(u, key, command) {
  await u.page.keyboard.down('Meta');
  await u.page.keyboard.press(key, { commands: [command] });
  await u.page.keyboard.up('Meta');
}

/** Caret at the end of list item `item` of top-level block `index`. */
async function caretInItem(u, index, item) {
  await u.page.evaluate((sel, index, item) => {
    const li = document.querySelector(sel).children[index].querySelectorAll('li')[item];
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('.tracked-deletion-wrapper') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let last = null;
    let n;
    while ((n = walker.nextNode())) last = n;
    const range = document.createRange();
    range.setStart(last, last.textContent.length);
    range.collapse(true);
    document.querySelector(sel).focus();
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }, L.EDITOR, index, item);
  await L.sleep(80);
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

/** Caret in the (empty) top-level block `index`. */
async function caretInEmpty(u, index) {
  await u.page.evaluate((sel, index) => {
    const root = document.querySelector(sel);
    const block = root.children[index];
    const range = document.createRange();
    range.setStart(block, 0);
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
const movedCards = async (u) => (await cards(u)).filter((c) => c.text.startsWith('Moved:'));
async function cardButton(u, ids, title) {
  for (const el of await u.page.$$(`${SIDEBAR} .rp-card`)) {
    const cardIds = await el.evaluate((e) => e.getAttribute('data-change-ids') || '');
    if (cardIds === ids.join(' ')) return el.$(`button[title="${title}"]`);
  }
  return null;
}
/** Deletion markers in the editor state (the wrapper's data-change-id isn't updated on a stamp). */
const markers = (u) => u.page.evaluate((sel) => {
  const out = [];
  const walk = (n) => {
    if (n.type === 'deleted-text') out.push({ id: n.changeId, text: n.deletedText });
    (n.children || []).forEach(walk);
  };
  walk(document.querySelector(sel).__lexicalEditor.getEditorState().toJSON().root);
  return out;
}, L.EDITOR);
const nonEmpty = (blocks) => blocks.filter((b) => b.trim() !== '');
const errorToast = (u) => u.page.evaluate(() => /Couldn't revert this (change|move) automatically/.test(document.body.innerText));

async function run(browser, n) {
  const sub = await createSubmission();
  const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
  const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
  const APP = new URL(a.page.url()).origin;
  for (const u of [a, b]) {
    await u.context.overridePermissions(APP, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  }
  const decisions = [];
  b.page.on('console', (msg) => {
    const m = msg.text().match(/\[RESOLVE\] handleChangeDecision: changeId=([^,]+), decision=(\w+)/);
    if (m) decisions.push(`${m[1]}:${m[2]}`);
    if (/cascaded change/i.test(msg.text())) cascadeLogs.push(msg.text().slice(0, 200));
  });
  const cascadeLogs = [];
  await L.converged(a, b);
  const t0 = Date.now();
  const step = (msg) => console.log(`[run ${n}] +${((Date.now() - t0) / 1000).toFixed(1)}s ${msg}`);

  // 1a. "\" typed and deleted in the same transaction (in a list item): no marker.
  await caretInItem(a, 5, 1);
  await a.page.keyboard.type('\\\\', { delay: 40 });
  await a.page.keyboard.press('Backspace');
  await L.sleep(3500);
  const typed = await markers(a);
  if (typed.length) throw new Error(`a typed-then-deleted character left a marker: ${JSON.stringify(typed)}`);
  step('A typed "\\\\" and deleted one: no marker');

  // 1b. Two saved characters deleted in one transaction: two markers, both stamped.
  await caretInItem(a, 5, 0);
  await a.page.keyboard.press('Backspace'); // "." of "... if you need one."
  await L.sleep(300);
  await caretInItem(a, 9, 1);
  await a.page.keyboard.press('Backspace'); // "." of "Second second-section item."
  await L.sleep(4500);
  await L.waitFor(async () => {
    const m = await markers(a);
    return m.length === 2 && m.every((x) => x.id && x.id !== '__pending_deletion__');
  }, 'both deletion markers stamped (before the fix the second stayed pending)', 10000)
    .catch(async (e) => { console.log(`[run ${n}] markers: ${JSON.stringify(await markers(a))}`); throw e; });
  const stamped = await markers(a);
  const deletionIds = [...new Set(stamped.map((m) => m.id))];
  step(`A deleted two saved characters: markers ${JSON.stringify(stamped)}`);
  const beforeCut = await L.converged(a, b);

  // 2. Cut "New for 2026:" + its list; paste over the empty paragraph before "General Info:".
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
  if (!moved.some((t) => t.startsWith('New for 2026:'))) throw new Error(`paste did not land: ${JSON.stringify(moved)}`);
  step(`A cut and pasted: ${JSON.stringify(moved.slice(0, 9).map((t) => t.slice(0, 20)))}`);

  // 3. B rejects the Moved card.
  await L.waitFor(async () => (await movedCards(b)).length === 1, 'B sees one Moved card', 15000);
  const move = (await movedCards(b))[0];
  await (await cardButton(b, move.ids, 'Reject')).click();
  await L.sleep(1500);
  if (await errorToast(b)) {
    throw new Error('"Couldn\'t revert" toast after rejecting the Moved card');
  }
  await L.waitFor(async () => (await movedCards(a)).length === 0, "A's Moved card disappears", 10000);

  // 4. Both documents are back to before the cut, with no stray marker.
  const restored = await L.converged(a, b);
  if (JSON.stringify(nonEmpty(restored)) !== JSON.stringify(nonEmpty(beforeCut))) {
    throw new Error(`after reject:\n${JSON.stringify(restored)}\nexpected\n${JSON.stringify(beforeCut)}`);
  }
  if (JSON.stringify(restored) !== JSON.stringify(beforeCut)) {
    console.log(`[run ${n}] note: empty blocks differ: ${JSON.stringify(restored)} vs ${JSON.stringify(beforeCut)}`);
  }
  for (const u of [a, b]) {
    const m = await markers(u);
    const bad = m.filter((x) => x.id === '__pending_deletion__' || move.ids.includes(x.id));
    if (bad.length) throw new Error(`${u.name}: leftover markers ${JSON.stringify(m)}`);
    if (m.length !== 2 || !m.every((x) => deletionIds.includes(x.id))) {
      throw new Error(`${u.name}: the deletion's own markers changed: ${JSON.stringify(m)}`);
    }
  }
  step('B rejected the Moved card: both documents back to before the cut, no stray marker');

  // 5. A failed decision is not replayed. A adds a word inside the second section, moves the
  //    section, then rewrites the pasted heading, so B's reject of that move can't be located
  //    and fails. B then rejects the added word (the move depends on it, so the server
  //    cascades the reject to the move): only that card is decided, and the move, whose text
  //    is still in the document, stays pending.
  await caretInItem(a, 9, 0);
  await a.page.keyboard.type(' Updated', { delay: 30 });
  await L.sleep(4000);
  const updatedCard = await L.waitFor(async () => (await cards(b)).find((c) => /Updated/.test(c.text) && !c.text.startsWith('Moved:')), 'B sees the Updated card', 10000);
  await selectBlocks(a, 8, 9);
  await shortcut(a, 'KeyX', 'Cut');
  await L.sleep(3500);
  const blocks2 = await L.blocks(a);
  const lastIdx = blocks2.indexOf('Last paragraph text.');
  await L.caret(a, lastIdx);
  await a.page.keyboard.press('Enter');
  await shortcut(a, 'KeyV', 'Paste');
  await L.sleep(3500);
  await L.waitFor(async () => (await movedCards(b)).length === 1, 'B sees the second Moved card', 15000).catch(async (e) => { console.log('B cards', JSON.stringify(await cards(b)), JSON.stringify(await L.blocks(a))); throw e; });
  const move2 = (await movedCards(b))[0];
  // Rewrite the pasted heading completely (A's own new transaction).
  const pasted = (await L.blocks(a)).indexOf('Second section heading:');
  await L.select(a, pasted, 0, 'Second section heading:'.length);
  await a.page.keyboard.type('Something else entirely, written over it by A.', { delay: 5 });
  await L.sleep(3500);
  const beforeFailed = await L.converged(a, b);
  decisions.length = 0;
  await (await cardButton(b, move2.ids, 'Reject')).click();
  await L.sleep(1500);
  const failed = await errorToast(b);
  step(`B rejected the rewritten move: ${failed ? 'failed as intended' : 'succeeded'}; decisions ${JSON.stringify(decisions)}`);
  if (!failed) throw new Error('the reject of the rewritten move should have failed');
  if (JSON.stringify(await L.blocks(b)) !== JSON.stringify(beforeFailed)) throw new Error('a failed reject changed the document');

  decisions.length = 0;
  const logMark = cascadeLogs.length;
  await (await cardButton(b, updatedCard.ids, 'Reject')).click();
  await L.sleep(4000);
  step(`B rejected the Updated card: decisions ${JSON.stringify(decisions)}; cascade: ${JSON.stringify(cascadeLogs.slice(logMark))}`);
  const replayed = decisions.filter((d) => move2.ids.some((id) => d.startsWith(id)));
  if (replayed.length) throw new Error(`the failed decision was replayed: ${JSON.stringify(decisions)}`);
  if (!decisions.some((d) => updatedCard.ids.some((id) => d.startsWith(id)))) throw new Error(`the Updated card was not decided: ${JSON.stringify(decisions)}`);
  await L.waitFor(async () => {
    const { changes } = await L.api(`/tracked-changes/submission/${sub.id}`);
    return changes.filter((c) => move2.ids.includes(c.id)).every((c) => c.status === 'pending');
  }, 'server: the move whose reject failed is still pending', 10000);
  if (!(await L.blocks(b)).includes('Something else entirely, written over it by A.')) throw new Error('the moved, rewritten text is gone');
  await L.waitFor(async () => (await movedCards(b)).length === 1 && (await movedCards(a)).length === 1, 'the move is still an open card for both', 10000);
  step('the failed move stayed pending (its text is still there); only the Updated card was decided');

  // 5b. B rejects A's step-1 deletion (two characters). Before the fix this cascaded on the
  //     server to later changes, the failed move among them. Whatever the server cascades,
  //     the move (which the document can't revert) must stay pending with its text.
  decisions.length = 0;
  const mark2 = cascadeLogs.length;
  await (await cardButton(b, deletionIds, 'Reject')).click();
  await L.sleep(4000);
  step(`B rejected the step-1 deletion: decisions ${JSON.stringify(decisions)}; cascade: ${JSON.stringify(cascadeLogs.slice(mark2))}`);
  if (decisions.filter((d) => move2.ids.some((id) => d.startsWith(id))).length) throw new Error(`the failed move was decided: ${JSON.stringify(decisions)}`);
  await L.waitFor(async () => {
    const { changes } = await L.api(`/tracked-changes/submission/${sub.id}`);
    return changes.filter((c) => move2.ids.includes(c.id)).every((c) => c.status === 'pending');
  }, 'server: the move is still pending after the cascade', 10000);
  if (!(await L.blocks(b)).includes('Something else entirely, written over it by A.')) throw new Error('the moved, rewritten text is gone');
  await L.waitFor(async () => (await movedCards(b)).length === 1 && (await movedCards(a)).length === 1, 'the move is still an open card for both after the cascade', 10000);
  await L.converged(a, b);
  step('after the step-1 deletion was rejected the move is still pending, its text in both documents');

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
  console.log(`stray-marker: ${passed}/${runs} passed`);
  process.exit(passed === runs ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
