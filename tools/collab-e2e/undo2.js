// Does Cmd+Z undo tracked-change bookkeeping (a reject, a marker rename)?
const L = require('./lib');
const PARAS = ['First paragraph text.', 'Second paragraph text here.', 'Third one.'];
const undo = async (u) => { await u.page.keyboard.down('Meta'); await u.page.keyboard.press('z'); await u.page.keyboard.up('Meta'); };
async function expandGroups(u) {
  for (const h of await u.page.$$('.change-group:not(.change-group--expanded) .change-group__header')) { await h.click(); await L.sleep(50); }
}
(async () => {
  const browser = await L.launch();
  try {
    // 0. The seeder presses Cmd+Z right after load: the seed must not be undoable.
    {
      const sub = await L.createSubmission(PARAS);
      const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
      await L.sleep(800);
      await L.caret(a, 1);
      await undo(a);
      await L.sleep(800);
      console.log('seeder after undo:', JSON.stringify(await L.blocks(a)));
      await a.context.close();
    }
    // 1. B rejects A's insertion, then B presses Cmd+Z.
    {
      const sub = await L.createSubmission(PARAS);
      const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
      const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
      await L.converged(a, b);
      await L.caret(a, 0);
      await a.page.keyboard.type(' Rejectme', { delay: 30 });
      await L.sleep(4500);
      const { changes } = await L.api(`/tracked-changes/submission/${sub.id}`);
      const target = changes.find((c) => c.newValue.includes('Rejectme'));
      await L.waitFor(async () => { await expandGroups(b); return (await b.page.$(`.change-item[data-change-ids~="${target.id}"]`)) !== null; }, 'in sidebar');
      await (await b.page.$(`.change-item[data-change-ids~="${target.id}"] button[title="Reject"]`)).click();
      await L.waitFor(async () => !(await L.blocks(a)).join('').includes('Rejectme'), 'rejected');
      await L.sleep(1500);
      await L.caret(b, 1); // focus B's editor
      await undo(b);
      await L.sleep(1500);
      console.log('after B undo:', JSON.stringify(await L.blocks(a)), JSON.stringify(await L.blocks(b)));
      await a.context.close(); await b.context.close();
    }
    // 2. A deletes "Third", the marker gets renamed after the save, then A presses Cmd+Z twice.
    {
      const sub = await L.createSubmission(PARAS);
      const a = await L.openUser(browser, 'A', 'dev-admin-session', sub.id);
      const b = await L.openUser(browser, 'B', 'dev-user2-session', sub.id);
      await L.converged(a, b);
      await L.select(a, 2, 0, 5);
      await a.page.keyboard.press('Backspace');
      await L.sleep(5000);
      const ids = (u) => u.page.$$eval(`${L.EDITOR} .tracked-deletion`, (els) => els.map((e) => e.getAttribute('data-change-id')));
      console.log('marker ids before undo:', await ids(a), await ids(b));
      await L.caret(a, 1);
      await undo(a);
      await L.sleep(1000);
      console.log('after 1 undo:', await ids(a), await ids(b), JSON.stringify(await L.blocks(b)));
      await undo(a);
      await L.sleep(1000);
      console.log('after 2 undos:', await ids(a), await ids(b), JSON.stringify(await L.blocks(b)));
      await a.context.close(); await b.context.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
