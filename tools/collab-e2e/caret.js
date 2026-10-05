// Real browsers, real keystrokes: caret placement under concurrent edits, and attribution checked
// against the server-stored tracked changes (LCS character diff of oldValue -> newValue).
// RUNS (default 10) per scenario; ONLY=<regex> selects scenarios.
const L = require('./lib');

const RUNS = Number(process.env.RUNS || 10);
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const tally = new Map();
function record(name, ok, detail) {
  const t = tally.get(name) || { pass: 0, fail: 0, fails: [] };
  if (ok) t.pass++; else { t.fail++; t.fails.push(detail); }
  tally.set(name, t);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
}
async function scenario(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  try { record(name, true, await fn()); } catch (e) { record(name, false, e.message.split('\n')[0]); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const type = (u, text, delay) => u.page.keyboard.type(text, { delay });
const MOD = 'Meta';
const PARAS = ['First paragraph text.', 'ALPHA [aaaaaaaaaa] line one.', 'Third one.'];
const ID = { A: 'dev-admin', B: 'dev-user2' };

async function pair(browser) {
  const sub = await L.createSubmission(PARAS);
  const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
  const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
  await L.converged(a, b);
  return { sub, a, b, users: { A: a, B: b } };
}
const close = async (p) => { await p.a.context.close(); await p.b.context.close(); };

// ---- Attribution from the server-stored changes ----

/** Characters `n` has that `o` doesn't (LCS). */
function lcsAdded(o, n) {
  const m = o.length, k = n.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(k + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--) dp[i][j] = o[i] === n[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, out = '';
  while (j < k) { if (i < m && o[i] === n[j]) { i++; j++; } else if (i < m && dp[i + 1][j] >= dp[i][j + 1]) i++; else out += n[j++]; }
  return out;
}
const visible = (s) => s.replace(/\s/g, '');

/**
 * Wait for both users' changes to settle and save, then check each user's stored changes:
 * `expected[user] = { added, removed, maxChanges }` (whitespace-insensitive).
 */
async function checkAttribution(p, expected) {
  await L.sleep(4500); // 2.5 s pause settles each change, then the save
  const { changes } = await L.api(`/tracked-changes/submission/${p.sub.id}`);
  const content = (changes || []).filter((c) => c.field === 'content');
  const report = [];
  for (const [user, exp] of Object.entries(expected)) {
    const mine = content.filter((c) => c.changedBy === ID[user]);
    const added = mine.map((c) => lcsAdded(c.oldValue, c.newValue)).join('');
    const removed = mine.map((c) => lcsAdded(c.newValue, c.oldValue)).join('');
    report.push(`${user}: ${mine.length} change(s) +${JSON.stringify(added)} -${JSON.stringify(removed)}`);
    assert(visible(added) === visible(exp.added || ''), `${user} added ${JSON.stringify(added)}, expected ${JSON.stringify(exp.added || '')} [${report.join('; ')}]`);
    assert(visible(removed) === visible(exp.removed || ''), `${user} removed ${JSON.stringify(removed)}, expected ${JSON.stringify(exp.removed || '')} [${report.join('; ')}]`);
    if (exp.maxChanges !== undefined) assert(mine.length <= exp.maxChanges, `${user} has ${mine.length} changes [${report.join('; ')}]`);
  }
  return report.join('; ');
}

(async () => {
  const browser = await L.launch();
  try {
    for (let run = 1; run <= RUNS; run++) {
      console.log(`\n=== run ${run}/${RUNS}`);
      const jitter = (run * 37) % 120;

      for (const [typist, splitter] of [['A', 'B'], ['B', 'A']]) {
        const dir = `(${typist} types, ${splitter} splits)`;

        // The dev-site case: Enter after "ALPHA" while the other user types at the end of that line.
        await scenario(`Enter before the typist's text: placement and attribution ${dir}`, async () => {
          const p = await pair(browser);
          try {
            const t = p.users[typist], s = p.users[splitter];
            await L.caret(t, 1);
            await L.caret(s, 1, 5); // after "ALPHA"
            const typed = ' {hhhhhhhhhhhhhh}';
            await Promise.all([
              type(t, typed, 45),
              (async () => { await L.sleep(150 + jitter); await s.page.keyboard.press('Enter'); })(),
            ]);
            const x = await L.converged(p.a, p.b);
            assert(x[1] === 'ALPHA' && x[2] === ` [aaaaaaaaaa] line one.${typed}`, JSON.stringify(x));
            return await checkAttribution(p, { [typist]: { added: typed, maxChanges: 1 }, [splitter]: { added: '', maxChanges: 1 } });
          } finally { await close(p); }
        });

        await scenario(`Enter after the typist's text: placement and attribution ${dir}`, async () => {
          const p = await pair(browser);
          try {
            const t = p.users[typist], s = p.users[splitter];
            await L.caret(t, 1, 5); // typing after "ALPHA"
            const typed = ' {hhhhhhhh}';
            await Promise.all([
              type(t, typed, 45),
              (async () => {
                await L.sleep(150 + jitter);
                const text = (await L.blocks(s))[1];
                await L.caret(s, 1, text.indexOf(']') + 1); // after "]", later in the line
                await s.page.keyboard.press('Enter');
              })(),
            ]);
            const x = await L.converged(p.a, p.b);
            assert(x[1] === `ALPHA${typed} [aaaaaaaaaa]` && x[2] === ' line one.', JSON.stringify(x));
            return await checkAttribution(p, { [typist]: { added: typed, maxChanges: 1 }, [splitter]: { added: '', maxChanges: 1 } });
          } finally { await close(p); }
        });

        await scenario(`Enter inside the text being typed: placement and attribution ${dir}`, async () => {
          const p = await pair(browser);
          try {
            const t = p.users[typist], s = p.users[splitter];
            const line = PARAS[1];
            await L.caret(t, 1);
            const typed = ' {hhhhhhhhhhhh}';
            const typing = type(t, typed, 60);
            // The splitter waits until 6 characters have arrived, then presses Enter inside them.
            await L.waitFor(async () => ((await L.blocks(s))[1] || '').length >= line.length + 6, 'typed text visible to the splitter');
            await L.caret(s, 1, line.length + 4);
            await s.page.keyboard.press('Enter');
            await typing;
            const x = await L.converged(p.a, p.b);
            assert(x[1] === `${line}${typed.slice(0, 4)}` && x[2] === typed.slice(4), JSON.stringify(x));
            return await checkAttribution(p, { [typist]: { added: typed, maxChanges: 1 }, [splitter]: { added: '', maxChanges: 1 } });
          } finally { await close(p); }
        });
      }

      await scenario('bold the word the other user is typing in: placement and attribution', async () => {
        const p = await pair(browser);
        try {
          await L.caret(p.a, 0, 8); // "First pa|ragraph"
          await L.select(p.b, 0, 6, 15); // "paragraph"
          await Promise.all([
            type(p.a, 'QQQQQQ', 45),
            (async () => { await L.sleep(100 + jitter); await p.b.page.keyboard.down(MOD); await p.b.page.keyboard.press('b'); await p.b.page.keyboard.up(MOD); })(),
          ]);
          const x = await L.converged(p.a, p.b);
          assert(x[0] === 'First paQQQQQQragraph text.', JSON.stringify(x));
          return await checkAttribution(p, { A: { added: 'QQQQQQ', maxChanges: 1 }, B: { added: '', maxChanges: 1 } });
        } finally { await close(p); }
      });

      await scenario('same position, typed at the same time: contiguous, each change only its own text', async () => {
        const p = await pair(browser);
        try {
          await L.caret(p.a, 2, 6); // "Third |one."
          await L.caret(p.b, 2, 6);
          await Promise.all([type(p.a, 'xxxxxx', 40), type(p.b, 'yyyyyy', 40)]);
          const x = await L.converged(p.a, p.b);
          assert(/^Third (xxxxxxyyyyyy|yyyyyyxxxxxx)one\.$/.test(x[2]), JSON.stringify(x[2]));
          return await checkAttribution(p, { A: { added: 'xxxxxx', maxChanges: 1 }, B: { added: 'yyyyyy', maxChanges: 1 } });
        } finally { await close(p); }
      });

      await scenario('different paragraphs at the same time: one change each, own text only', async () => {
        const p = await pair(browser);
        try {
          await L.caret(p.a, 0);
          await L.caret(p.b, 2);
          await Promise.all([type(p.a, ' Kilo', 50), type(p.b, ' Mutex', 50)]);
          await L.converged(p.a, p.b);
          return await checkAttribution(p, { A: { added: ' Kilo', maxChanges: 1 }, B: { added: ' Mutex', maxChanges: 1 } });
        } finally { await close(p); }
      });

      await scenario('single user: typing and a tracked deletion in one change', async () => {
        const p = await pair(browser);
        try {
          await L.caret(p.a, 0);
          await type(p.a, ' Solo', 40);
          await L.select(p.a, 2, 0, 5); // "Third"
          await p.a.page.keyboard.press('Backspace');
          await L.waitFor(async () => (await p.b.page.$$(`${L.EDITOR} .tracked-deletion-wrapper`)).length === 1, 'deletion marker on B');
          await L.converged(p.a, p.b);
          return await checkAttribution(p, { A: { added: ' Solo', removed: 'Third', maxChanges: 1 }, B: { added: '', maxChanges: 0 } });
        } finally { await close(p); }
      });
    }
  } finally {
    await browser.close();
  }
  console.log('\n=== per-scenario results');
  let failed = 0;
  for (const [name, t] of tally) {
    console.log(`${t.pass}/${t.pass + t.fail}  ${name}`);
    failed += t.fail;
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
