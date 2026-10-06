import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { API_URL } from '../config';
import { COUNCIL_ROLES, councilRoleLabel, storedUser } from '../utils/access';
import './PeopleManagement.css';

/** A person and their access, as GET /api/admin/people returns it. */
export interface Person {
  id: string;
  name: string;
  email: string;
  verified: boolean;
  approved: boolean;
  isAdmin: boolean;
  commsCadre: boolean;
  councilRoles: string[];
}

type AccessChange = Partial<Pick<Person, 'approved' | 'isAdmin' | 'commsCadre' | 'councilRoles'>>;
type Filter = 'all' | 'awaiting' | 'admins' | 'cadre' | 'council';

const FILTERS: Array<{ id: Filter; label: string; test: (p: Person) => boolean }> = [
  { id: 'all', label: 'Everyone', test: () => true },
  { id: 'awaiting', label: 'Awaiting approval', test: (p) => !p.approved },
  { id: 'admins', label: 'Admins', test: (p) => p.isAdmin },
  { id: 'cadre', label: 'Comms Cadre', test: (p) => p.commsCadre },
  { id: 'council', label: 'Council', test: (p) => p.councilRoles.length > 0 },
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
        <dt>Approved</dt>
        <dd>Can sign in, submit comms requests and follow their own requests. New sign-ups wait here for approval.</dd>
        <dt>Comms Cadre</dt>
        <dd>Sees and reviews every request, edits and approves them, sends approved announcements, and builds and sends the newsletter.</dd>
        <dt>Council roles</dt>
        <dd>Council members see and review every request; a request needs a Council approval. The <strong>Communications Manager</strong> also approves newsletter editions and can override an approval.</dd>
        <dt>Admin</dt>
        <dd>Everything above, plus this admin area (people, groups, templates). An Admin can override approvals.</dd>
      </dl>
      <p>One person can hold several roles, for example Comms Cadre and Communications Manager. Their approval then counts for both.</p>
    </details>
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
              <th scope="col">Approved</th>
              <th scope="col">Comms Cadre</th>
              <th scope="col">Council roles</th>
              <th scope="col">Admin</th>
              <th scope="col"><span className="visually-hidden">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const isMe = p.email.toLowerCase() === me;
              const unassigned = COUNCIL_ROLES.filter((r) => !p.councilRoles.includes(r.id));
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
                  <td data-label="Approved">
                    {p.approved ? (
                      <label className="people-switch" title={p.isAdmin || p.commsCadre || p.councilRoles.length > 0 ? 'Someone with a role stays approved' : undefined}>
                        <input type="checkbox" checked onChange={() => change(p, { approved: false })} disabled={p.isAdmin || p.commsCadre || p.councilRoles.length > 0} aria-label={`${p.email} approved`} />
                        <span>Yes</span>
                      </label>
                    ) : (
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => change(p, { approved: true })}>Approve</button>
                    )}
                  </td>
                  <td data-label="Comms Cadre">
                    <label className="people-switch">
                      <input type="checkbox" checked={p.commsCadre} onChange={(e) => change(p, { commsCadre: e.target.checked })} aria-label={`${p.email} Comms Cadre`} />
                      <span>{p.commsCadre ? 'Yes' : 'No'}</span>
                    </label>
                  </td>
                  <td data-label="Council roles">
                    <div className="people-roles">
                      {p.councilRoles.map((role) => (
                        <span key={role} className="people-role">
                          {councilRoleLabel(role)}
                          <button
                            type="button"
                            className="people-role-remove"
                            aria-label={`Remove ${councilRoleLabel(role)} from ${p.email}`}
                            onClick={() => change(p, { councilRoles: p.councilRoles.filter((r) => r !== role) })}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      {unassigned.length > 0 && (
                        <select
                          className="people-role-add"
                          value=""
                          aria-label={`Add a council role to ${p.email}`}
                          onChange={(e) => e.target.value && change(p, { councilRoles: [...p.councilRoles, e.target.value] })}
                        >
                          <option value="">{p.councilRoles.length ? '+ Add' : 'None · add…'}</option>
                          {unassigned.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                        </select>
                      )}
                    </div>
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
