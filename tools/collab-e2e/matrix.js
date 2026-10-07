// Two real browsers (isolated Chrome contexts) on the real app, collaborative mode.
const L = require('./lib');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (e) {
    record(name, false, e.message.split('\n')[0]);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const PARAS = ['First paragraph text.', 'Second paragraph text here.', 'Third one.'];
const type = (u, text, delay = 35) => u.page.keyboard.type(text, { delay });
const MOD = 'Meta'; // headless Chrome on macOS: Lexical treats Cmd as the modifier

async function expandGroups(u) {
  const headers = await u.page.$$('.change-group:not(.change-group--expanded) .change-group__header');
  for (const h of headers) { await h.click(); await L.sleep(50); }
}

async function pair(browser) {
  const sub = await L.createSubmission(PARAS);
  const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
  const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
  await L.converged(a, b);
  return { sub, a, b };
}
async function closePair(p) {
  await p.a.context.close();
  await p.b.context.close();
}

(async () => {
  const runs = Number(process.env.RUNS || 1);
  const browser = await L.launch();
  try {
    for (let run = 1; run <= runs; run++) {
      console.log(`\n=== run ${run}/${runs}`);

      // 1. Seeding and different paragraphs at the same time, then reload.
      {
        const p = await pair(browser);
        const { a, b } = p;
        await check('seed: both editors show the saved content exactly once', async () => {
          const x = await L.blocks(a);
          assert(JSON.stringify(x) === JSON.stringify(PARAS), `got ${JSON.stringify(x)}`);
        });
        await check('different paragraphs, typed at the same time', async () => {
          await L.caret(a, 0);
          await L.caret(b, 2);
          await Promise.all([type(a, ' Kilo'), type(b, ' Mutex')]);
          const x = await L.converged(a, b);
          assert(x[0] === 'First paragraph text. Kilo' && x[2] === 'Third one. Mutex', JSON.stringify(x));
          return JSON.stringify(x);
        });
        await check('reload shows the same content', async () => {
          await L.sleep(4500); // let the open tracked changes settle and save first
          await a.page.reload({ waitUntil: 'domcontentloaded' });
          await a.page.waitForSelector(`${L.EDITOR}[contenteditable="true"]`, { timeout: 20000 });
          const x = await L.converged(a, b);
          assert(x[0].endsWith('Kilo') && x[2].endsWith('Mutex'), JSON.stringify(x));
        });
        await check('attribution: each user\'s change contains only their own text', async () => {
          const { changes } = await L.api(`/tracked-changes/submission/${p.sub.id}`);
          const content = (changes || []).filter((c) => c.field === 'content');
          // Characters each change inserts (LCS diff of the stored old/new values).
          const inserted = (o, n) => {
            const m = o.length, k = n.length;
            const dp = Array.from({ length: m + 1 }, () => new Array(k + 1).fill(0));
            for (let i = m - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--) dp[i][j] = o[i] === n[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            let i = 0, j = 0, out = '';
            while (j < k) { if (i < m && o[i] === n[j]) { i++; j++; } else if (i < m && dp[i + 1][j] >= dp[i][j + 1]) i++; else out += n[j++]; }
            return out;
          };
          const sorted = (t) => t.replace(/\s/g, '').split('').sort().join('');
          const by = (who) => content.filter((c) => c.changedBy === who);
          const insA = by('dev-admin').map((c) => inserted(c.oldValue, c.newValue)).join('');
          const insB = by('dev-user2').map((c) => inserted(c.oldValue, c.newValue)).join('');
          const ca = by('dev-admin'), cb = by('dev-user2');
          assert(ca.length === 1 && cb.length === 1, `changes A=${ca.length} B=${cb.length}`);
          assert(sorted(insA) === sorted('Kilo'), `A inserted ${JSON.stringify(insA)} across ${ca.length} change(s)`);
          assert(sorted(insB) === sorted('Mutex'), `B inserted ${JSON.stringify(insB)} across ${cb.length} change(s)`);
          assert(a.changePosts.length > 0 && a.changePosts.every((x) => x.includes('"diffAgainstOldValue":true')), 'POSTs without diffAgainstOldValue');
          return `A: ${ca.length} change(s), B: ${cb.length} change(s), total content changes ${content.length}`;
        });
        await check('no whole-document, cursor or typing messages on the room socket', async () => {
          const bad = [...a.roomSent, ...b.roomSent].filter((t) => /content_updated|realtime_content_update|cursor_position|typing_|request_cursor/.test(t));
          assert(bad.length === 0, `sent ${bad.join(',')}`);
          return `room types sent: ${[...new Set([...a.roomSent, ...b.roomSent])].join(',') || 'none'}; yjs frames A=${a.yjsFrames} B=${b.yjsFrames}`;
        });
        await check('no console errors', async () => {
          const errs = [...a.errors, ...b.errors].filter((e) => !/favicon|GSI_LOGGER|Turnstile|One Tap|credentials/.test(e));
          assert(errs.length === 0, errs.slice(0, 3).join(' | '));
        });
        await closePair(p);
      }

      // 2. Same paragraph, different positions.
      {
        const p = await pair(browser);
        const { a, b } = p;
        await check('same paragraph, different positions, same time', async () => {
          await L.caret(a, 1, 0);
          await L.caret(b, 1);
          await Promise.all([type(a, 'AAA '), type(b, ' BBB')]);
          const x = await L.converged(a, b);
          assert(x[1] === 'AAA Second paragraph text here. BBB', JSON.stringify(x));
        });
        await closePair(p);
      }

      // 3. Same position.
      {
        const p = await pair(browser);
        const { a, b } = p;
        await check('same position, same time', async () => {
          await L.caret(a, 1, 7);
          await L.caret(b, 1, 7);
          await Promise.all([type(a, 'xxxx'), type(b, 'yyyy')]);
          const x = await L.converged(a, b);
          const t = x.join('\n');
          assert(/^Second (xxxxyyyy|yyyyxxxx)paragraph text here\.$/.test(x[1]), JSON.stringify(x));
          return JSON.stringify(x[1]);
        });
        await closePair(p);
      }

      // 4. Enter in a paragraph while the other user types in it.
      {
        const p = await pair(browser);
        const { a, b } = p;
        await check('Enter in a paragraph while the other user types at its end', async () => {
          await L.caret(a, 1);
          await L.caret(b, 1, 7);
          await Promise.all([type(a, 'ZZZZZZ', 60), (async () => { await L.sleep(150); await b.page.keyboard.press('Enter'); })()]);
          const x = await L.converged(a, b);
          assert(JSON.stringify(x) === JSON.stringify(['First paragraph text.', 'Second ', 'paragraph text here.ZZZZZZ', 'Third one.']), JSON.stringify(x));
          return JSON.stringify(x);
        });
        await check('Enter before the other user\'s caret (they type after it lands)', async () => {
          await L.caret(a, 3); // end of "paragraph text here.ZZZZZZ..." block (index 2 now?)
          const before = await L.blocks(a);
          const idx = before.length - 2; // the paragraph that ends with the text from the previous case
          await L.caret(a, idx);
          await L.caret(b, idx, 3);
          await b.page.keyboard.press('Enter');
          await L.converged(a, b);
          await type(a, ' after');
          const x = await L.converged(a, b);
          assert(x[idx] === 'par' && x[idx + 1] === 'agraph text here.ZZZZZZ after', JSON.stringify(x));
          return `typed " after" at the end of block ${idx}; result ${JSON.stringify(x)}`;
        });
        await closePair(p);
      }

      // 5. Bold while the other user types inside the word.
      {
        const p = await pair(browser);
        const { a, b } = p;
        await check('bold a word while the other user types inside it', async () => {
          await L.select(a, 1, 7, 16); // "paragraph"
          await L.caret(b, 1, 10); // "par|agraph"
          await Promise.all([
            (async () => { await L.sleep(60); await a.page.keyboard.down(MOD); await a.page.keyboard.press('b'); await a.page.keyboard.up(MOD); })(),
            type(b, 'QQ', 50),
          ]);
          const x = await L.converged(a, b);
          // Each Q exactly once. Placement is a known @lexical/yjs limit: a Q that crosses the
          // bold split in flight lands at the split point (e.g. "QparQagraph").
          assert(x[1] === 'Second parQQagraph text here.', JSON.stringify(x));
          const bold = await a.page.$$eval(`${L.EDITOR} strong, ${L.EDITOR} .collaborative-editor-bold`, (els) => els.map((e) => e.textContent));
          const boldB = await b.page.$$eval(`${L.EDITOR} strong, ${L.EDITOR} .collaborative-editor-bold`, (els) => els.map((e) => e.textContent));
          assert(JSON.stringify(bold) === JSON.stringify(boldB) && bold.length > 0, `bold A=${JSON.stringify(bold)} B=${JSON.stringify(boldB)}`);
          return `${JSON.stringify(x[1])}; bold=${JSON.stringify(bold)}`;
        });
        await closePair(p);
      }

      // 6. Tracked deletion marker, reject from the other user, undo.
      {
        const p = await pair(browser);
        const { a, b } = p;
        await check('deletion marker is created once by its author and shown to the other user', async () => {
          await L.select(a, 2, 0, 5); // "Third"
          await a.page.keyboard.press('Backspace');
          await L.waitFor(async () => (await b.page.$$(`${L.EDITOR} .tracked-deletion-wrapper`)).length === 1, 'marker on B');
          await L.sleep(1500); // let both decoration passes run
          const na = (await a.page.$$(`${L.EDITOR} .tracked-deletion-wrapper`)).length;
          const nb = (await b.page.$$(`${L.EDITOR} .tracked-deletion-wrapper`)).length;
          assert(na === 1 && nb === 1, `markers A=${na} B=${nb}`);
          // settle + save -> the author's commit-pending-deletion renames the marker (syncs to B)
          const markerIds = (u) => u.page.$$eval(`${L.EDITOR} .tracked-deletion`, (els) => els.map((e) => e.getAttribute('data-change-id')));
          const ids = await L.waitFor(async () => {
            const [ia, ib] = [await markerIds(a), await markerIds(b)];
            return ia.length === 1 && ib.length === 1 && ia[0] === ib[0] && ia[0] !== '__pending_deletion__' ? ib : null;
          }, 'marker renamed to the saved change id on both');
          return `marker change id on A and B: ${ids.join(',')}`;
        });
        await check('deletion approved by B: marker removed for both, text stays deleted', async () => {
          const { changes } = await L.api(`/tracked-changes/submission/${p.sub.id}`);
          const del = changes.find((c) => c.field === 'content' && c.status === 'pending' && c.oldValue.includes('Third'));
          assert(del, 'no deletion change on the server');
          await expandGroups(b);
          const btn = await b.page.waitForSelector(`.change-item[data-change-ids~="${del.id}"] button[title="Accept"]`, { timeout: 10000 });
          await btn.click();
          await L.waitFor(async () => (await a.page.$$(`${L.EDITOR} .tracked-deletion`)).length === 0 && (await b.page.$$(`${L.EDITOR} .tracked-deletion`)).length === 0, 'markers gone on both');
          const x = await L.converged(a, b);
          assert(!x.join('').includes('Third'), JSON.stringify(x));
          return JSON.stringify(x);
        });
        await check('typed text from A, rejected by B, disappears for both', async () => {
          await L.caret(a, 0);
          await type(a, ' Rejectme');
          await L.converged(a, b);
          await L.sleep(4500); // save
          const { changes } = await L.api(`/tracked-changes/submission/${p.sub.id}`);
          const target = (changes || []).find((c) => c.field === 'content' && c.status === 'pending' && c.newValue.includes('Rejectme') && !c.oldValue.includes('Rejectme'));
          assert(target, 'no tracked change for Rejectme');
          // B's sidebar picks the change up from A's transaction_settled (sidebar-only refetch)
          const sentBefore = b.roomSent.length;
          await L.waitFor(async () => { await expandGroups(b); return (await b.page.$(`.change-item[data-change-ids~="${target.id}"]`)) !== null; }, 'change in B sidebar');
          const btn = await b.page.waitForSelector(`.change-item[data-change-ids~="${target.id}"] button[title="Reject"]`, { timeout: 10000 });
          await btn.click();
          const x = await L.waitFor(async () => {
            const [xa, xb] = [await L.blocks(a), await L.blocks(b)];
            return !xa.join('').includes('Rejectme') && JSON.stringify(xa) === JSON.stringify(xb) ? xa : null;
          }, 'Rejectme removed on both');
          await L.sleep(1500);
          const sent = b.roomSent.slice(sentBefore);
          assert(!sent.some((t) => /content_updated|realtime_content_update/.test(t)), `B sent ${sent.join(',')}`);
          const after = await L.api(`/tracked-changes/submission/${p.sub.id}`);
          const st = after.changes.find((c) => c.id === target.id);
          return `blocks ${JSON.stringify(x)}; room messages from B after reject: ${sent.join(',') || 'none'}; server status=${st && st.status}`;
        });
        await check('Ctrl/Cmd+Z undoes only the local user\'s typing (Yjs UndoManager)', async () => {
          await L.caret(b, 1);
          await type(b, ' Keepme');
          await L.converged(a, b);
          await L.caret(a, 1, 0);
          await type(a, 'Undoable ');
          await L.converged(a, b);
          await a.page.keyboard.down(MOD); await a.page.keyboard.press('z'); await a.page.keyboard.up(MOD);
          const x = await L.waitFor(async () => {
            const [xa, xb] = [await L.blocks(a), await L.blocks(b)];
            return !xa.join('').includes('Undoable') && JSON.stringify(xa) === JSON.stringify(xb) ? xa : null;
          }, 'undo converged');
          assert(x.join('').includes('Keepme'), JSON.stringify(x));
          return JSON.stringify(x);
        });
        await closePair(p);
      }

      // 7. Everyone leaves; the next session seeds from saved content exactly once.
      {
        const p = await pair(browser);
        const { a, b } = p;
        await check('after everyone leaves (room destroyed), the next session seeds once from saved content', async () => {
          await L.caret(a, 0);
          await type(a, ' Persisted');
          await L.converged(a, b);
          await L.sleep(4500); // settle + save
          await closePair(p);
          await L.sleep(32000); // server destroys the room 30 s after the last client leaves
          const a2 = await L.openUser(browser, 'A2', 'dev-admin-session', p.sub.id);
          const b2 = await L.openUser(browser, 'B2', 'dev-user2-session', p.sub.id);
          const x = await L.converged(a2, b2);
          await a2.context.close();
          await b2.context.close();
          assert(L.count(x.join('\n'), 'Persisted') === 1 && L.count(x.join('\n'), 'Second paragraph') === 1, JSON.stringify(x));
          return JSON.stringify(x);
        });
      }
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
