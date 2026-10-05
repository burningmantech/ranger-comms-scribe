// Real browsers, real keystrokes: caret preservation and one tracked change per user. RUNS (default 10) per scenario.
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

async function pair(browser) {
  const sub = await L.createSubmission(PARAS);
  const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
  const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
  await L.converged(a, b);
  return { sub, a, b };
}
const close = async (p) => { await p.a.context.close(); await p.b.context.close(); };

(async () => {
  const browser = await L.launch();
  try {
    for (let run = 1; run <= RUNS; run++) {
      console.log(`\n=== run ${run}/${RUNS}`);
      const jitter = (run * 37) % 120;

      // The dev-site failure: Enter after "ALPHA" while the other user types at the end of that line.
      await scenario('Enter after a word while the other user types at the end of the line', async () => {
        const p = await pair(browser);
        try {
          await L.caret(p.a, 1);
          await L.caret(p.b, 1, 5); // after "ALPHA"
          await Promise.all([
            type(p.a, ' {aaaaaaaaaaaaaa}', 45),
            (async () => { await L.sleep(150 + jitter); await p.b.page.keyboard.press('Enter'); })(),
          ]);
          const x = await L.converged(p.a, p.b);
          assert(x[1] === 'ALPHA' && x[2] === ' [aaaaaaaaaa] line one. {aaaaaaaaaaaaaa}', JSON.stringify(x));
          return JSON.stringify(x.slice(1, 3));
        } finally { await close(p); }
      });

      await scenario('Enter inside the text the other user is typing (before their caret)', async () => {
        const p = await pair(browser);
        try {
          await L.caret(p.a, 1, 18); // after "]"
          await L.caret(p.b, 1, 12); // inside "[aaaa|aaaaaa]"
          await Promise.all([
            type(p.a, 'ZZZZZZZZ', 45),
            (async () => { await L.sleep(120 + jitter); await p.b.page.keyboard.press('Enter'); })(),
          ]);
          const x = await L.converged(p.a, p.b);
          assert(x[1] === 'ALPHA [aaaaa' && x[2] === 'aaaaa]ZZZZZZZZ line one.', JSON.stringify(x));
          return JSON.stringify(x.slice(1, 3));
        } finally { await close(p); }
      });

      await scenario('bold the word the other user is typing in', async () => {
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
          return JSON.stringify(x[0]);
        } finally { await close(p); }
      });

      await scenario('same position, typed at the same time: two contiguous blocks', async () => {
        const p = await pair(browser);
        try {
          await L.caret(p.a, 2, 6); // "Third |one."
          await L.caret(p.b, 2, 6);
          await Promise.all([type(p.a, 'xxxxxx', 40), type(p.b, 'yyyyyy', 40)]);
          const x = await L.converged(p.a, p.b);
          assert(/^Third (xxxxxxyyyyyy|yyyyyyxxxxxx)one\.$/.test(x[2]), JSON.stringify(x[2]));
          return JSON.stringify(x[2]);
        } finally { await close(p); }
      });

      await scenario('two users each type a word at the same time: one tracked change each, own text only', async () => {
        const p = await pair(browser);
        try {
          await L.caret(p.a, 0);
          await L.caret(p.b, 2);
          await Promise.all([type(p.a, ' Kilo', 50), type(p.b, ' Mutex', 50)]);
          await L.converged(p.a, p.b);
          await L.sleep(4500); // 2.5 s pause, then the save
          const { changes } = await L.api(`/tracked-changes/submission/${p.sub.id}`);
          const content = changes.filter((c) => c.field === 'content');
          const byA = content.filter((c) => c.changedBy === 'dev-admin');
          const byB = content.filter((c) => c.changedBy === 'dev-user2');
          assert(byA.length === 1 && byB.length === 1, `changes A=${byA.length} B=${byB.length}`);
          const [ca, cb] = [byA[0], byB[0]];
          assert(ca.newValue.includes('Kilo') && !ca.oldValue.includes('Kilo') && !ca.newValue.includes('Mutex') && !ca.oldValue.includes('Mutex') || (ca.newValue.split('Mutex').length === ca.oldValue.split('Mutex').length && ca.newValue.includes('Kilo')),
            `A change ${JSON.stringify([ca.oldValue, ca.newValue])}`);
          assert(cb.newValue.includes('Mutex') && cb.newValue.split('Kilo').length === cb.oldValue.split('Kilo').length,
            `B change ${JSON.stringify([cb.oldValue, cb.newValue])}`);
          const fullA = [ca.richTextOldValue, ca.richTextNewValue].map((j) => j.includes('Kilo'));
          const fullB = [cb.richTextOldValue, cb.richTextNewValue].map((j) => j.includes('Mutex'));
          assert(!fullA[0] && fullA[1] && !fullB[0] && fullB[1], `full docs A=${fullA} B=${fullB}`);
          return `A ${JSON.stringify([ca.oldValue, ca.newValue])} B ${JSON.stringify([cb.oldValue, cb.newValue])}`;
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
