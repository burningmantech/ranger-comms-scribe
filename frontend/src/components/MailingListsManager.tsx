import React, { useCallback, useEffect, useState } from 'react';
import { API_URL } from '../config';
import './MailingListsManager.css';

export interface MailingList {
  id: string;
  name: string;
  address: string;
  description?: string;
  audiences: string[];
  active: boolean;
  builtIn?: boolean;
}

/** Request audiences a list can serve (keys as the request form stores them). */
const AUDIENCES: Array<{ id: string; label: string }> = [
  { id: 'singular', label: 'Singular announcement' },
  { id: 'newsletter', label: 'Newsletter' },
  { id: 'allcom', label: 'Allcom' },
  { id: 'jrs', label: 'JRS / Event Ops' },
  { id: 'event', label: 'Plan an event' },
  { id: 'website_update', label: 'Website update' },
  { id: 'other', label: 'Other' },
];

const EMPTY = { name: '', address: '', description: '', audiences: [] as string[] };

const headers = (json = false): HeadersInit => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  Authorization: `Bearer ${localStorage.getItem('sessionId') || ''}`,
});

async function readError(res: Response, fallback: string) {
  try {
    return (await res.json())?.error || fallback;
  } catch {
    return fallback;
  }
}

interface FormProps {
  initial: typeof EMPTY;
  submitLabel: string;
  onSubmit: (value: typeof EMPTY) => Promise<string | null>;
  onCancel?: () => void;
}

function ListForm({ initial, submitLabel, onSubmit, onCancel }: FormProps) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof EMPTY>) => setValue((v) => ({ ...v, ...patch }));

  return (
    <form
      className="ml-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const problem = await onSubmit(value);
        setBusy(false);
        setError(problem);
        if (!problem && !onCancel) setValue(EMPTY);
      }}
    >
      <div className="ml-form-row">
        <label>
          Name
          <input value={value.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Intake Cadre" required />
        </label>
        <label>
          List address
          <input type="email" value={value.address} onChange={(e) => set({ address: e.target.value })} placeholder="ranger-intake-cadre@burningman.org" required />
        </label>
      </div>
      <label>
        Who it reaches (optional)
        <input value={value.description} onChange={(e) => set({ description: e.target.value })} placeholder="e.g. The Intake cadre and its mentors" />
      </label>
      <fieldset className="ml-audiences">
        <legend>Suggest it for requests going to</legend>
        {AUDIENCES.map((a) => (
          <label key={a.id} className="ml-check">
            <input
              type="checkbox"
              checked={value.audiences.includes(a.id)}
              onChange={(e) => set({ audiences: e.target.checked ? [...value.audiences, a.id] : value.audiences.filter((x) => x !== a.id) })}
            />
            {a.label}
          </label>
        ))}
      </fieldset>
      {error && <div className="ml-error" role="alert">{error}</div>}
      <div className="ml-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
        {onCancel && <button type="button" className="btn btn-neutral btn-sm" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/**
 * Requests → Settings → Mailing lists: the lists approved announcements can go to. When a
 * request is sent, the lists that serve its audience are ticked to start with.
 */
export const MailingListsManager: React.FC = () => {
  const [lists, setLists] = useState<MailingList[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`${API_URL}/mailing-lists`, { headers: headers() });
    if (!res.ok) {
      setError(await readError(res, 'Could not load the mailing lists'));
      return;
    }
    const body = await res.json();
    setLists(body.lists);
    setCanManage(!!body.canManage);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (id: string | null, value: typeof EMPTY): Promise<string | null> => {
    const res = await fetch(`${API_URL}/mailing-lists${id ? `/${id}` : ''}`, {
      method: id ? 'PUT' : 'POST',
      headers: headers(true),
      body: JSON.stringify(value),
    });
    if (!res.ok) return readError(res, 'Could not save');
    setEditing(null);
    setAdding(false);
    await load();
    return null;
  };

  const setActive = async (list: MailingList, active: boolean) => {
    const res = await fetch(`${API_URL}/mailing-lists/${list.id}`, { method: 'PUT', headers: headers(true), body: JSON.stringify({ active }) });
    if (res.ok) await load();
  };

  const remove = async (list: MailingList) => {
    if (!window.confirm(`Delete the ${list.name} list? Requests already sent to it keep the record.`)) return;
    const res = await fetch(`${API_URL}/mailing-lists/${list.id}`, { method: 'DELETE', headers: headers() });
    if (res.ok) await load();
  };

  const label = (id: string) => AUDIENCES.find((a) => a.id === id)?.label || id;

  return (
    <div className="ml">
      <p className="ml-intro">
        The lists approved announcements can be sent to. When you send a request, the lists that serve its audience are
        ticked to start with; you can change them before sending.
      </p>
      {error && <div className="ml-error" role="alert">{error}</div>}
      {!lists && !error && <p className="ml-intro">Loading…</p>}
      {lists && (
        <ul className="ml-list">
          {lists.map((list) => (
            <li key={list.id} className={`ml-item ${list.active ? '' : 'ml-inactive'}`} data-testid={`list-${list.address}`}>
              {editing === list.id ? (
                <ListForm
                  initial={{ name: list.name, address: list.address, description: list.description || '', audiences: list.audiences }}
                  submitLabel="Save"
                  onSubmit={(v) => save(list.id, v)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <>
                  <div className="ml-main">
                    <div className="ml-name">
                      {list.name}
                      {list.builtIn && <span className="ml-tag">Built in</span>}
                      {!list.active && <span className="ml-tag">Not in use</span>}
                    </div>
                    <div className="ml-address">{list.address}</div>
                    {list.description && <div className="ml-description">{list.description}</div>}
                    <div className="ml-audiences-line">
                      {list.audiences.length ? `Suggested for: ${list.audiences.map(label).join(', ')}` : 'Never suggested; tick it when sending'}
                    </div>
                  </div>
                  {canManage && !list.builtIn && (
                    <div className="ml-buttons">
                      <button type="button" className="btn btn-neutral btn-sm" onClick={() => setEditing(list.id)}>Edit</button>
                      <button type="button" className="btn btn-neutral btn-sm" onClick={() => setActive(list, !list.active)}>{list.active ? 'Stop using' : 'Use again'}</button>
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(list)} aria-label={`Delete ${list.name}`}>Delete</button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (adding ? (
        <div className="ml-item">
          <ListForm initial={EMPTY} submitLabel="Add list" onSubmit={(v) => save(null, v)} onCancel={() => setAdding(false)} />
        </div>
      ) : (
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>+ Add a mailing list</button>
      ))}
    </div>
  );
};

export default MailingListsManager;
