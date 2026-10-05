import { TransactionManager } from '../transactionManager';

function lex(text: string): object {
  return {
    root: {
      children: [{ type: 'paragraph', children: [{ type: 'text', text }], direction: 'ltr', format: '', indent: 0, version: 1 }],
      direction: 'ltr', format: '', indent: 0, type: 'root', version: 1,
    },
  };
}

const okSave = () => jest.fn(async (sid: string, change: any) => ({
  id: `remote-${Math.random()}`, submissionId: sid, field: change.field, oldValue: change.oldValue,
  newValue: change.newValue, changedBy: 'u', changedByName: 'U', timestamp: new Date().toISOString(),
  status: 'pending' as const, comments: [],
}));

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => process.nextTick(r));
}

describe('TransactionManager.flush', () => {
  it('settles the active transaction with the latest notified state and saves it', async () => {
    const save = okSave();
    const tm = new TransactionManager('s1', { saveFunction: save, deleteFunction: jest.fn(), retryDelayMs: 0, pauseDelayMs: 60000 });
    tm.startTransaction('content', lex('Hello'));
    tm.notifyActivity(lex('Hello there'));
    const tx = tm.flush();
    expect(tx).not.toBeNull();
    expect(tm.getActiveTransaction()).toBeNull();
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1].newValue).toBe('Hello there');
  });

  it('does nothing without an active transaction or before any activity', () => {
    const save = okSave();
    const tm = new TransactionManager('s1', { saveFunction: save, deleteFunction: jest.fn(), retryDelayMs: 0, pauseDelayMs: 60000 });
    expect(tm.flush()).toBeNull();
    tm.startTransaction('content', lex('Hello'));
    expect(tm.flush()).toBeNull();
    expect(tm.getActiveTransaction()).not.toBeNull();
  });

  it('emits active-transaction-changed on start, settle and discard', () => {
    const tm = new TransactionManager('s1', { saveFunction: okSave(), deleteFunction: jest.fn(), retryDelayMs: 0, pauseDelayMs: 60000 });
    const events: boolean[] = [];
    tm.on('active-transaction-changed', (active: boolean) => events.push(active));
    tm.startTransaction('content', lex('a'));
    tm.notifyActivity(lex('ab'));
    tm.flush();
    tm.startTransaction('content', lex('ab'));
    tm.pauseForChangeResolution();
    expect(events).toEqual([true, false, true, false]);
  });
});

describe('TransactionManager.retryFailedSaves', () => {
  it('saves failed transactions again and clears the error', async () => {
    let fail = true;
    const save = jest.fn(async (sid: string, change: any) => {
      if (fail) throw new Error('offline');
      return { id: 'remote-1', submissionId: sid, field: change.field, oldValue: change.oldValue, newValue: change.newValue,
        changedBy: 'u', changedByName: 'U', timestamp: '', status: 'pending' as const, comments: [] };
    });
    const tm = new TransactionManager('s1', { saveFunction: save, deleteFunction: jest.fn(), retryDelayMs: 0, pauseDelayMs: 60000 });
    tm.startTransaction('content', lex('one'));
    tm.notifyActivity(lex('one two'));
    tm.flush();
    await settle();
    expect(tm.getSaveStatus()).toBe('error');
    expect(save).toHaveBeenCalledTimes(2); // the save and its automatic retry

    fail = false;
    await tm.retryFailedSaves();
    expect(tm.getSaveStatus()).toBe('all-saved');
    expect(save).toHaveBeenCalledTimes(3);
    expect(tm.getUndoStack()[0].status).toBe('saved');
    expect(tm.getUndoStack()[0].remoteChangeId).toBe('remote-1');
  });

  it('returns to the error state when the retry fails too', async () => {
    const save = jest.fn(async () => { throw new Error('offline'); });
    const tm = new TransactionManager('s1', { saveFunction: save, deleteFunction: jest.fn(), retryDelayMs: 0, pauseDelayMs: 60000 });
    tm.startTransaction('content', lex('one'));
    tm.notifyActivity(lex('one two'));
    tm.flush();
    await settle();
    await tm.retryFailedSaves();
    expect(tm.getSaveStatus()).toBe('error');
    expect(tm.getUndoStack()[0].status).toBe('failed');
  });
});
