// What the document body shows for deletions, in both browsers and after a reload, for the ways
// people delete: type over a selected word (each user), Backspace over a single space, Backspace
// character by character, paste over a word, Enter over a selection. Each deletion shows its deleted text, struck through, where it was
// (adjacent markers read as one, as they look). Then: accepting a type-over replacement leaves
// the new word only, rejecting one brings the old word back once, and undoing a type-over at once
// restores the word with no marker. Prints what each browser shows and fails on a mismatch.
const L = require('./lib');

const PARAS = [
  'the dev stack that owns CloudFront. cdk diff',
  'showed that header as the only change',
  'remove one  space here',
  'delete these chars asAS now',
  'undo this word please',
  'paste over this word',
  'split it here please',
];

/** Each deletion marker in the editor, by paragraph: [paragraph, marker text, change id]. */
async function markers(u) {
  return u.page.$$eval(`${L.EDITOR} > *`, (blocks) => blocks.flatMap((b, i) =>
    [...b.querySelectorAll('.tracked-deletion-wrapper')].map((m) => [i, m.textContent, m.getAttribute('data-change-id')])));
}

/** A paragraph's text as shown, deletion markers in [brackets] (adjacent ones as one). */
async function shown(u, index) {
  return u.page.evaluate((sel, index) => {
    const block = document.querySelector(sel).children[index];
    const clone = block.cloneNode(true);
    clone.querySelectorAll('.tracked-deletion-wrapper').forEach((m) => m.replaceWith(`[${m.textContent}]`));
    return clone.textContent.replace(/\]\[/g, '');
  }, L.EDITOR, index);
}

/** The text of every added-text highlight (CSS highlights named tracked-addition-<change id>). */
async function highlights(u) {
  return u.page.evaluate(() => [...CSS.highlights]
    .filter(([name]) => name.startsWith('tracked-addition-'))
    .flatMap(([, h]) => [...h].map((r) => r.toString())));
}

/** The Open card whose description contains `needle`. */
async function card(u, needle) {
  for (const el of await u.page.$$('.editor-sidebar .rp-card')) {
    const text = await el.$eval('.rp-desc', (d) => d.textContent).catch(() => '');
    if (text.includes(needle)) return el;
  }
  throw new Error(`${u.name}: no card with ${needle}`);
}

async function typeOver(u, index, start, end, text) {
  await L.select(u, index, start, end);
  await u.page.keyboard.type(text, { delay: 40 });
}

(async () => {
  const browser = await L.launch();
  let failed = 0;
  try {
    const sub = await L.createSubmission(PARAS);
    const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
    const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
    await L.converged(a, b);

    // 1. A types "CF" over "CloudFront" (paragraph 0, chars 24..34)
    await typeOver(a, 0, 24, 34, 'CF');
    await L.sleep(3500);
    // 2. B types "footer" over "header" (paragraph 1, chars 12..18)
    await typeOver(b, 1, 12, 18, 'footer');
    await L.sleep(3500);
    // 3. A deletes one of the two spaces in "one  space" with Backspace (paragraph 2, caret at 11)
    await L.caret(a, 2, 11);
    await a.page.keyboard.press('Backspace');
    await L.sleep(3500);
    // 4. A Backspaces "asAS" one character at a time (paragraph 3, caret after "asAS" at 23)
    await L.caret(a, 3, 23);
    for (let i = 0; i < 4; i++) {
      await a.page.keyboard.press('Backspace');
      await L.sleep(120);
    }
    await L.sleep(3500);
    // 5. A pastes "that" over "this" (a real paste event, as Cmd+V sends)
    await L.select(a, 5, 11, 15);
    await a.page.evaluate((sel) => {
      const data = new DataTransfer();
      data.setData('text/plain', 'that');
      document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, L.EDITOR);
    await L.sleep(3500);
    // 6. A presses Enter over " here " (paragraph 6 becomes two)
    await L.select(a, 6, 8, 14);
    await a.page.keyboard.press('Enter');
    await L.sleep(6000);

    const expected = [
      'the dev stack that owns [CloudFront]CF. cdk diff',
      'showed that [header]footer as the only change',
      'remove one[ ] space here',
      'delete these chars [asAS] now',
      'undo this word please',
      'paste over [this]that word',
      'split it[ here ]',
      'please',
    ];
    const report = async (u, label) => {
      console.log(`\n${label}`);
      for (let i = 0; i < expected.length; i++) {
        const text = await shown(u, i);
        const ok = text === expected[i];
        if (!ok) failed++;
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} p${i}: ${JSON.stringify(text)}${ok ? '' : `  (expected ${JSON.stringify(expected[i])})`}`);
      }
      console.log('  markers:', JSON.stringify((await markers(u)).map(([i, t, id]) => [i, t, id && id.slice(0, 8)])));
      // The added text of each replacement is highlighted, whole words (not "foot" of "footer")
      const lit = await highlights(u);
      for (const word of ['CF', 'footer', 'that']) {
        const ok = lit.includes(word);
        if (!ok) failed++;
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} "${word}" highlighted`);
      }
      console.log('  highlights:', JSON.stringify(lit));
    };
    await report(a, 'A (made 1, 3, 4)');
    await report(b, 'B (made 2)');

    const { changes } = await L.api(`/tracked-changes/submission/${sub.id}`);
    console.log('\nserver changes:', JSON.stringify(changes.map((c) => ({ id: c.id.slice(0, 8), by: c.changedBy, old: c.oldValue, new: c.newValue }))));

    await b.page.reload({ waitUntil: 'domcontentloaded' });
    await b.page.waitForSelector(`${L.EDITOR}[contenteditable="true"]`);
    await L.sleep(2500);
    await report(b, 'B after reload');

    // Accept the CloudFront replacement, reject the header one (B decides)
    const check = async (label, index, want) => {
      await L.sleep(2500);
      for (const u of [a, b]) {
        const text = await shown(u, index);
        const ok = text === want;
        if (!ok) failed++;
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label} (${u.name}): ${JSON.stringify(text)}${ok ? '' : `  (expected ${JSON.stringify(want)})`}`);
      }
    };
    console.log('\ndecisions');
    await (await (await card(b, 'CloudFront')).$('button[title="Accept"]')).click();
    await check('accepted CloudFront -> CF', 0, 'the dev stack that owns CF. cdk diff');
    await (await (await card(b, 'header')).$('button[title="Reject"]')).click();
    await check('rejected header -> footer', 1, 'showed that header as the only change');

    // Undo a type-over right away: the word comes back with no marker
    await typeOver(a, 4, 5, 9, 'that');
    await L.sleep(300);
    await a.page.keyboard.down('Meta');
    await a.page.keyboard.press('z');
    await a.page.keyboard.up('Meta');
    await check('undo of a type-over', 4, 'undo this word please');

    const after = (await L.api(`/tracked-changes/submission/${sub.id}`)).changes;
    console.log('server changes after:', JSON.stringify(after.map((c) => ({ old: c.oldValue, new: c.newValue, status: c.status }))));
  } finally {
    await browser.close();
  }
  console.log(failed ? `\n${failed} paragraph(s) wrong` : '\nall shown correctly');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
