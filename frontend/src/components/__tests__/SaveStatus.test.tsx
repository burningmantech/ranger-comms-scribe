import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import SaveStatus from '../SaveStatus';
import { TransactionManager } from '../../services/transactionManager';

function lex(text: string): object {
  return {
    root: {
      children: [{ type: 'paragraph', children: [{ type: 'text', text }], direction: 'ltr', format: '', indent: 0, version: 1 }],
      direction: 'ltr', format: '', indent: 0, type: 'root', version: 1,
    },
  };
}

function deferredSave() {
  const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const fn = jest.fn((sid: string, change: any) => new Promise<any>((resolve, reject) => {
    pending.push({
      resolve: () => resolve({ id: `r${pending.length}`, submissionId: sid, field: change.field, oldValue: change.oldValue,
        newValue: change.newValue, changedBy: 'u', changedByName: 'U', timestamp: '', status: 'pending', comments: [] }),
      reject,
    });
  }));
  return { fn, pending };
}

async function ticks() {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => process.nextTick(r));
}

const state = (container: HTMLElement) => container.querySelector('.save-status')?.getAttribute('data-state');

describe('SaveStatus', () => {
  it('goes Saved -> Unsaved changes -> Saving… -> Saved', async () => {
    const { fn, pending } = deferredSave();
    const tm = new TransactionManager('s1', { saveFunction: fn, deleteFunction: jest.fn(), retryDelayMs: 0, pauseDelayMs: 60000 });
    const { container } = render(<SaveStatus transactionManager={tm} />);
    expect(screen.getByText('Saved')).toBeInTheDocument();

    act(() => {
      tm.startTransaction('content', lex('a'));
      tm.notifyActivity(lex('ab'));
    });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    act(() => { tm.flush(); });
    expect(state(container)).toBe('saving');
    expect(screen.getByText('Saving…')).toBeInTheDocument();

    await act(async () => { pending[0].resolve(); await ticks(); });
    expect(state(container)).toBe('saved');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('saves the open edit when the page is hidden', async () => {
    const { fn } = deferredSave();
    const tm = new TransactionManager('s1', { saveFunction: fn, deleteFunction: jest.fn(), retryDelayMs: 0, pauseDelayMs: 60000 });
    render(<SaveStatus transactionManager={tm} />);
    act(() => {
      tm.startTransaction('content', lex('a'));
      tm.notifyActivity(lex('ab'));
    });
    const vis = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    vis.mockRestore();
    expect(tm.getActiveTransaction()).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('saves the open edit on unmount', () => {
    const { fn } = deferredSave();
    const tm = new TransactionManager('s1', { saveFunction: fn, deleteFunction: jest.fn(), retryDelayMs: 0, pauseDelayMs: 60000 });
    const { unmount } = render(<SaveStatus transactionManager={tm} />);
    act(() => {
      tm.startTransaction('content', lex('a'));
      tm.notifyActivity(lex('ab'));
    });
    unmount();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flushes on beforeunload and asks to confirm while a save is in flight', () => {
    const { fn } = deferredSave();
    const tm = new TransactionManager('s1', { saveFunction: fn, deleteFunction: jest.fn(), retryDelayMs: 0, pauseDelayMs: 60000 });
    render(<SaveStatus transactionManager={tm} />);
    act(() => {
      tm.startTransaction('content', lex('a'));
      tm.notifyActivity(lex('ab'));
    });
    const event = new Event('beforeunload', { cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not block unload when everything is saved', () => {
    const tm = new TransactionManager('s1', { saveFunction: jest.fn(), deleteFunction: jest.fn(), retryDelayMs: 0, pauseDelayMs: 60000 });
    render(<SaveStatus transactionManager={tm} />);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps Couldn't save after a later edit saves, until Retry saves the failed one", async () => {
    let fail = true;
    const save = jest.fn(async (sid: string, change: any) => {
      if (fail) throw new Error('offline');
      return { id: `r${save.mock.calls.length}`, submissionId: sid, field: change.field, oldValue: change.oldValue, newValue: change.newValue,
        changedBy: 'u', changedByName: 'U', timestamp: '', status: 'pending' as const, comments: [] };
    });
    const tm = new TransactionManager('s1', { saveFunction: save, deleteFunction: jest.fn(), retryDelayMs: 0, pauseDelayMs: 60000 });
    const { container } = render(<SaveStatus transactionManager={tm} />);
    await act(async () => {
      tm.startTransaction('content', lex('a'));
      tm.notifyActivity(lex('ab'));
      tm.flush();
      await ticks();
    });
    expect(state(container)).toBe('error');

    fail = false;
    await act(async () => {
      tm.startTransaction('content', lex('ab'));
      tm.notifyActivity(lex('abc'));
      tm.flush();
      await ticks();
    });
    expect(tm.getSaveStatus()).toBe('all-saved'); // the manager alone would report saved
    expect(state(container)).toBe('error');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await ticks();
    });
    expect(state(container)).toBe('saved');
    expect(tm.getUndoStack().every((tx) => tx.status === 'saved')).toBe(true);
  });

  it("shows Couldn't save with a Retry that saves again", async () => {
    let fail = true;
    const save = jest.fn(async (sid: string, change: any) => {
      if (fail) throw new Error('offline');
      return { id: 'r1', submissionId: sid, field: change.field, oldValue: change.oldValue, newValue: change.newValue,
        changedBy: 'u', changedByName: 'U', timestamp: '', status: 'pending' as const, comments: [] };
    });
    const tm = new TransactionManager('s1', { saveFunction: save, deleteFunction: jest.fn(), retryDelayMs: 0, pauseDelayMs: 60000 });
    const { container } = render(<SaveStatus transactionManager={tm} />);
    await act(async () => {
      tm.startTransaction('content', lex('a'));
      tm.notifyActivity(lex('ab'));
      tm.flush();
      await ticks();
    });
    expect(screen.getByText("Couldn't save")).toBeInTheDocument();
    fail = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await ticks();
    });
    expect(state(container)).toBe('saved');
    expect(save).toHaveBeenCalledTimes(3);
  });
});
