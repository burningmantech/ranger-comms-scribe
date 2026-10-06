import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { API_URL } from '../config';
import { COUNCIL_ROLES, storedUser } from '../utils/access';
import './PeopleManagement.css';

/** A person and their access, as GET /api/admin/people returns it. */
export interface Person {
  id: string;
  name: string;
  email: string;
  verified: boolean;
  isAdmin: boolean;
  commsCadre: boolean;
  /** The one council role held, or null. */
  councilRole: string | null;
}

type AccessChange = Partial<Pick<Person, 'isAdmin' | 'commsCadre' | 'councilRole'>>;
type Filter = 'all' | 'admins' | 'cadre' | 'council';

const FILTERS: Array<{ id: Filter; label: string; test: (p: Person) => boolean }> = [
  { id: 'all', label: 'Everyone', test: () => true },
  { id: 'admins', label: 'Admins', test: (p) => p.isAdmin },
  { id: 'cadre', label: 'Comms Cadre', test: (p) => p.commsCadre },
  { id: 'council', label: 'Council', test: (p) => !!p.councilRole },
];

const authHeaders = (json = false): HeadersInit => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  Authorization: `Bearer ${localStorage.getItem('sessionId') || ''}`,
});

async function errorText(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body?.error || fallback;
  } catch {
    return fallback;
  }
}

/** What each role can do (the server decides; this is the plain-English version). */
function RoleGuide() {
  return (
    <details className="people-guide">
      <summary>What each role can do</summary>
      <dl>
        <dt>Everyone</dt>
        <dd>Anyone signed in can submit comms requests and follow their own requests. No role is needed.</dd>
        <dt>Comms Cadre</dt>
        <dd>Sees and reviews every request, edits and approves them, sends approved announcements, and builds and sends the newsletter.</dd>
        <dt>Council role</dt>
        <dd>Each council member holds one council role. Council members see and review every request; a request needs a Council approval. The <strong>Communications Manager</strong> also approves newsletter editions and can override an approval.</dd>
        <dt>Admin</dt>
        <dd>Everything above, plus this admin area. An Admin can override approvals.</dd>
      </dl>
      <p>Comms Cadre, a council role and Admin can be combined, for example Comms Cadre and Communications Manager. Their approval then counts for both.</p>
    </details>
  );
}

/** One person per line: "Name <email>", "Name, email" or just an email. Bad lines are returned. */
export function parsePeople(text: string): { people: Array<{ name: string; email: string }>; bad: string[] } {
  const people: Array<{ name: string; email: string }> = [];
  const bad: string[] = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/[^\s<>,;"]+@[^\s<>,;"]+\.[^\s<>,;"]+/);
    if (!match) {
      bad.push(line);
      continue;
    }
    const email = match[0].toLowerCase();
    const name = line.replace(match[0], '').replace(/[<>,;"()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!people.some((p) => p.email === email)) people.push({ name: name || email.split('@')[0], email });
  }
  return { people, bad };
}

/** Add people before they sign in, optionally with a role. */
function AddPeople({ onAdded }: { onAdded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const parsed = parsePeople(text);

  const submit = async () => {
    if (parsed.people.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`${API_URL}/admin/bulk-create-users`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ users: parsed.people }),
      });
      if (!response.ok) throw new Error(await errorText(response, 'Could not add them'));
      const body = await response.json();
      const created: Person[] = body.users || [];
      const noRole: string[] = [];
      if (role) {
        const access = role === 'commsCadre' ? { commsCadre: true } : role === 'admin' ? { isAdmin: true } : { councilRole: role };
        for (const person of created) {
          const res = await fetch(`${API_URL}/admin/people/${encodeURIComponent(person.id)}/access`, { method: 'PUT', headers: authHeaders(true), body: JSON.stringify(access) });
          if (!res.ok) noRole.push(`${person.email} (${await errorText(res, 'role not set')})`);
        }
      }
      const failed = (body.errors || []).length;
      const problems = [failed ? `${failed} could not be added` : '', noRole.length ? `no role for ${noRole.join(', ')}` : ''].filter(Boolean).join('; ');
      setMessage({ kind: problems ? 'error' : 'ok', text: `Added ${created.length}${problems ? `; ${problems}` : ''}. They can sign in with Google or reset a password with that address.` });
      setText('');
      await onAdded();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Could not add them' });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}><i className="fas fa-user-plus" aria-hidden="true" /> Add people</button>;
  }
  return (
    <div className="people-add">
      <label htmlFor="people-add-text"><strong>Add people</strong> (one per line: a name and an email address)</label>
      <textarea
        id="people-add-text"
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'Pat Ranger <pat@example.org>\nsam@example.org'}
      />
      <div className="people-add-options">
        <label>
          Role{' '}
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role for the people added">
            <option value="">None</option>
            <option value="commsCadre">Comms Cadre</option>
            {COUNCIL_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            <option value="admin">Admin</option>
          </select>
        </label>
      </div>
      {parsed.bad.length > 0 && <div className="people-row-error">No email address in: {parsed.bad.join('; ')}</div>}
      {message && <div className={message.kind === 'error' ? 'people-row-error' : 'people-added'} role="status">{message.text}</div>}
      <div className="people-add-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || parsed.people.length === 0} onClick={submit}>
          {busy ? 'Adding…' : `Add ${parsed.people.length || ''} ${parsed.people.length === 1 ? 'person' : 'people'}`.replace('  ', ' ')}
        </button>
        <button type="button" className="btn btn-neutral btn-sm" onClick={() => { setOpen(false); setMessage(null); }}>Close</button>
      </div>
    </div>
  );
}

/** Admin → People: everyone's access in one place. */
export const PeopleManagement: React.FC = () => {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editingName, setEditingName] = useState<{ id: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const me = (storedUser()?.email || '').toLowerCase();

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/admin/people`, { headers: authHeaders() });
      if (!response.ok) throw new Error(await errorText(response, 'Could not load people'));
      const body = await response.json();
      setPeople(body.people || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load people');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (person: Person) => setPeople((list) => (list || []).map((p) => (p.id === person.id ? person : p)));

  const change = async (person: Person, patch: AccessChange) => {
    setSaving((s) => ({ ...s, [person.id]: true }));
    setRowError((e) => ({ ...e, [person.id]: '' }));
    replace({ ...person, ...patch }); // shown at once; put back if the server refuses
    try {
      const response = await fetch(`${API_URL}/admin/people/${encodeURIComponent(person.id)}/access`, {
        method: 'PUT',
        headers: authHeaders(true),
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(await errorText(response, 'Could not save'));
      replace((await response.json()).person);
    } catch (err) {
      replace(person);
      setRowError((e) => ({ ...e, [person.id]: err instanceof Error ? err.message : 'Could not save' }));
    } finally {
      setSaving((s) => ({ ...s, [person.id]: false }));
    }
  };

  const rename = async (person: Person, name: string) => {
    setEditingName(null);
    if (!name.trim() || name.trim() === person.name) return;
    const response = await fetch(`${API_URL}/admin/update-user-name`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ userId: person.id, name: name.trim() }),
    });
    if (response.ok) replace({ ...person, name: name.trim() });
    else setRowError((e) => ({ ...e, [person.id]: 'Could not rename' }));
  };

  const remove = async (person: Person) => {
    setConfirmDelete(null);
    const response = await fetch(`${API_URL}/admin/users/${encodeURIComponent(person.id)}`, { method: 'DELETE', headers: authHeaders() });
    if (response.ok) {
      setPeople((list) => (list || []).filter((p) => p.id !== person.id));
    } else {
      const message = await errorText(response, 'Could not delete');
      setRowError((e) => ({ ...e, [person.id]: message }));
    }
  };

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, (people || []).filter(f.test).length])), [people]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const test = FILTERS.find((f) => f.id === filter)!.test;
    return (people || []).filter((p) => test(p) && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)));
  }, [people, query, filter]);

  return (
    <div className="admin-section people">
      <div className="people-head">
        <h2>People</h2>
        <p className="admin-hint">Everyone who has signed up, and what they can do. Changes save as you make them.</p>
        <RoleGuide />
        <AddPeople onAdded={load} />
      </div>

      <div className="people-toolbar">
        <input
          type="search"
          className="people-search"
          placeholder="Search by name or email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search people"
        />
        <div className="people-filters" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`people-filter ${filter === f.id ? 'active' : ''}`}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label} <span className="people-count">{counts[f.id] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error-message" role="alert">{error}</div>}
      {!people && !error && <p className="admin-hint">Loading…</p>}
      {people && shown.length === 0 && <p className="admin-hint">Nobody matches.</p>}

      {shown.length > 0 && (
        <table className="people-table">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Comms Cadre</th>
              <th scope="col">Council role</th>
              <th scope="col">Admin</th>
              <th scope="col"><span className="visually-hidden">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const isMe = p.email.toLowerCase() === me;
              return (
                <tr key={p.id} className={saving[p.id] ? 'saving' : ''} data-testid={`person-${p.email}`}>
                  <td className="people-person" data-label="Person">
                    {editingName?.id === p.id ? (
                      <input
                        className="people-name-input"
                        value={editingName.value}
                        autoFocus
                        aria-label={`Name of ${p.email}`}
                        onChange={(e) => setEditingName({ id: p.id, value: e.target.value })}
                        onBlur={() => rename(p, editingName.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') rename(p, editingName.value);
                          if (e.key === 'Escape') setEditingName(null);
                        }}
                      />
                    ) : (
                      <button type="button" className="people-name" onClick={() => setEditingName({ id: p.id, value: p.name })} title="Rename">
                        {p.name || p.email}{isMe && <span className="people-you"> (you)</span>}
                      </button>
                    )}
                    <div className="people-email">{p.email}{!p.verified && <span className="people-unverified"> · email not verified</span>}</div>
                    {rowError[p.id] && <div className="people-row-error" role="alert">{rowError[p.id]}</div>}
                  </td>
                  <td data-label="Comms Cadre">
                    <label className="people-switch">
                      <input type="checkbox" checked={p.commsCadre} onChange={(e) => change(p, { commsCadre: e.target.checked })} aria-label={`${p.email} Comms Cadre`} />
                      <span>{p.commsCadre ? 'Yes' : 'No'}</span>
                    </label>
                  </td>
                  <td data-label="Council role">
                    <select
                      className={`people-council ${p.councilRole ? 'held' : ''}`}
                      value={p.councilRole || ''}
                      aria-label={`${p.email} council role`}
                      onChange={(e) => change(p, { councilRole: e.target.value || null })}
                    >
                      <option value="">None</option>
                      {COUNCIL_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select>
                  </td>
                  <td data-label="Admin">
                    <label className="people-switch" title={isMe && p.isAdmin ? "You can't remove your own Admin" : undefined}>
                      <input type="checkbox" checked={p.isAdmin} disabled={isMe && p.isAdmin} onChange={(e) => change(p, { isAdmin: e.target.checked })} aria-label={`${p.email} Admin`} />
                      <span>{p.isAdmin ? 'Yes' : 'No'}</span>
                    </label>
                  </td>
                  <td className="people-actions">
                    {!isMe && (confirmDelete === p.id ? (
                      <span className="people-confirm">
                        Delete {p.name || p.email}?
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(p)}>Delete</button>
                        <button type="button" className="btn btn-neutral btn-sm" onClick={() => setConfirmDelete(null)}>Keep</button>
                      </span>
                    ) : (
                      <button type="button" className="people-delete" onClick={() => setConfirmDelete(p.id)} aria-label={`Delete ${p.email}`} title="Delete this account">
                        <i className="fas fa-trash" aria-hidden="true" />
                      </button>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default PeopleManagement;
