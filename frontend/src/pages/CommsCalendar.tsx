import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useContent } from '../contexts/ContentContext';
import { commsCalendarService } from '../services/commsCalendarService';
import {
  COMMS_METHODS, CommsCalendarEntry, CommsCalendarInput, CommsMethod, UpcomingItem,
} from '../types/commsCalendar';
import {
  anchorDate, cycleLabel, cycleStartYear, describeDaysUntil, entryCycle, formatShortDate, localToday,
} from '../utils/commsCalendar';
import { EntryFormModal } from '../components/commsCalendar/EntryFormModal';
import { NudgeModal } from '../components/commsCalendar/NudgeModal';
import { AddFromRequestModal } from '../components/commsCalendar/AddFromRequestModal';
import { CsvImportModal } from '../components/commsCalendar/CsvImportModal';
import './CommsCalendar.css';

type Tab = 'upcoming' | 'all';
type Dialog =
  | { kind: 'edit'; entry?: CommsCalendarEntry; initial?: CommsCalendarInput }
  | { kind: 'nudge'; entry: CommsCalendarEntry; anniversary?: string }
  | { kind: 'import' }
  | { kind: 'fromRequest' };

const WINDOW_OPTIONS = [2, 4, 6, 8, 12];
const TAB_KEY = 'commsCalendar.tab';
const WEEKS_KEY = 'commsCalendar.weeks';

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Settings are a convenience only
  }
}

function lastNudgeText(entry: CommsCalendarEntry): string {
  const last = entry.nudges[entry.nudges.length - 1];
  if (!last) return '';
  return `Nudged ${formatShortDate(last.at.slice(0, 10))} by ${last.byName}`;
}

const SubjectCell: React.FC<{ entry: CommsCalendarEntry }> = ({ entry }) => (
  <>
    {entry.link ? (
      <a href={entry.link} target="_blank" rel="noopener noreferrer">{entry.subject}</a>
    ) : entry.subject}
    {entry.submissionId && (
      <Link to={`/tracked-changes/${entry.submissionId}`} className="cc-tag" title="Open the Scribe request">Scribe</Link>
    )}
  </>
);

const ContactsLine: React.FC<{ entry: CommsCalendarEntry }> = ({ entry }) => (
  entry.contactEmails.length > 0
    ? <div className="cc-muted cc-small">{entry.contactEmails.join(', ')}</div>
    : <div className="cc-muted cc-small cc-missing">No contacts</div>
);

/**
 * Comms Calendar: what was sent each Sep→Aug cycle, by whom, and which anniversaries are
 * coming up so Comms can ask the team whether to send something similar again.
 */
export const CommsCalendar: React.FC = () => {
  const { submissions } = useContent();
  const today = localToday();
  const thisCycle = cycleStartYear(today);

  const [entries, setEntries] = useState<CommsCalendarEntry[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => (readSetting(TAB_KEY) === 'all' ? 'all' : 'upcoming'));
  const [weeks, setWeeks] = useState<number>(() => {
    const saved = Number(readSetting(WEEKS_KEY));
    return WINDOW_OPTIONS.includes(saved) ? saved : 6;
  });
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Filters for the All tab
  const [cycle, setCycle] = useState<number | 'all'>(thisCycle);
  const [team, setTeam] = useState('');
  const [methods, setMethods] = useState<Set<CommsMethod>>(new Set(COMMS_METHODS));
  const [sent, setSent] = useState<'any' | 'sent' | 'unsent'>('any');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, soon] = await Promise.all([
        commsCalendarService.list(),
        commsCalendarService.upcoming(weeks * 7, localToday()),
      ]);
      setEntries(list.entries);
      setCanEdit(list.canEdit);
      setUpcoming(soon.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the calendar');
    } finally {
      setLoading(false);
    }
  }, [weeks]);

  useEffect(() => {
    load();
  }, [load]);

  const chooseTab = (next: Tab) => {
    setTab(next);
    writeSetting(TAB_KEY, next);
  };

  const chooseWeeks = (next: number) => {
    setWeeks(next);
    writeSetting(WEEKS_KEY, String(next));
  };

  const closeAndReload = () => {
    setDialog(null);
    load();
  };

  const markNotRepeating = async (entry: CommsCalendarEntry) => {
    try {
      await commsCalendarService.update(entry.id, { notRepeating: true });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the entry');
    }
  };

  const remove = async (entry: CommsCalendarEntry) => {
    setConfirmDeleteId(null);
    try {
      await commsCalendarService.remove(entry.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the entry');
    }
  };

  const startThisYear = (item: UpcomingItem) => setDialog({
    kind: 'edit',
    initial: {
      subject: item.entry.subject,
      method: item.entry.method,
      team: item.entry.team,
      contactEmails: item.entry.contactEmails,
      targetDate: item.anniversary,
      carriedFromId: item.entry.id,
      comments: '',
    },
  });

  const cycles = useMemo(() => {
    const years = new Set<number>([thisCycle]);
    for (const e of entries) years.add(entryCycle(e));
    return Array.from(years).sort((a, b) => b - a);
  }, [entries, thisCycle]);

  const teams = useMemo(
    () => Array.from(new Set(entries.map((e) => e.team).filter(Boolean))).sort(),
    [entries],
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return entries
      .filter((e) => cycle === 'all' || entryCycle(e) === cycle)
      .filter((e) => !team || e.team === team)
      .filter((e) => methods.has(e.method))
      .filter((e) => sent === 'any' || (sent === 'sent' ? !!e.dateSent : !e.dateSent))
      .filter((e) => !term || `${e.subject} ${e.comments} ${e.team}`.toLowerCase().includes(term))
      .sort((a, b) => anchorDate(a).localeCompare(anchorDate(b)) || a.subject.localeCompare(b.subject));
  }, [entries, cycle, team, methods, sent, search]);

  const toggleMethod = (method: CommsMethod) => setMethods((prev) => {
    const next = new Set(prev);
    if (next.has(method)) next.delete(method);
    else next.add(method);
    return next;
  });

  return (
    <div className="comms-calendar">
      <div className="cc-header">
        <div>
          <h1>Comms Calendar</h1>
          <p className="cc-muted">
            What went out each year (September to August), and whose anniversaries are coming up.
          </p>
        </div>
        {canEdit && (
          <div className="cc-actions">
            <button type="button" className="cc-btn cc-btn--primary" onClick={() => setDialog({ kind: 'edit' })}>Add entry</button>
            <button type="button" className="cc-btn" onClick={() => setDialog({ kind: 'fromRequest' })}>Add from request</button>
            <button type="button" className="cc-btn" onClick={() => setDialog({ kind: 'import' })}>Import CSV</button>
          </div>
        )}
      </div>

      <div className="cc-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'upcoming'} className={`cc-tab${tab === 'upcoming' ? ' cc-tab--active' : ''}`} onClick={() => chooseTab('upcoming')}>
          Upcoming{upcoming.length > 0 ? ` (${upcoming.length})` : ''}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'all'} className={`cc-tab${tab === 'all' ? ' cc-tab--active' : ''}`} onClick={() => chooseTab('all')}>
          All entries
        </button>
      </div>

      {error && <div className="cc-error" role="alert">{error}</div>}

      {loading ? (
        <div className="cc-empty">Loading…</div>
      ) : tab === 'upcoming' ? (
        <section aria-label="Upcoming anniversaries">
          <div className="cc-filters">
            <label className="cc-inline">
              <span>Anniversaries in the next</span>
              <select value={weeks} onChange={(e) => chooseWeeks(Number(e.target.value))} aria-label="Window">
                {WINDOW_OPTIONS.map((w) => <option key={w} value={w}>{w} weeks</option>)}
              </select>
            </label>
            <span className="cc-muted cc-small">Includes the past two weeks. An item leaves this list once this year's entry continues it, or it's marked "won't repeat".</span>
          </div>
          {upcoming.length === 0 ? (
            <div className="cc-empty">Nothing coming up in the next {weeks} weeks.</div>
          ) : (
            <div className="cc-table-wrap">
              <table className="cc-table">
                <thead>
                  <tr>
                    <th>This year</th>
                    <th>Subject</th>
                    <th>Team</th>
                    <th>Last time</th>
                    <th>Nudges</th>
                    {canEdit && <th aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map((item) => (
                    <tr key={item.entry.id}>
                      <td className="cc-nowrap">
                        <div>{formatShortDate(item.anniversary)}</div>
                        <div className={`cc-small ${item.overdue ? 'cc-overdue' : 'cc-muted'}`}>{describeDaysUntil(item.daysUntil)}</div>
                      </td>
                      <td><SubjectCell entry={item.entry} /></td>
                      <td>
                        <div>{item.entry.team || <span className="cc-missing">No team</span>}</div>
                        <ContactsLine entry={item.entry} />
                      </td>
                      <td className="cc-nowrap">
                        <div>{formatShortDate(item.entry.dateSent || item.entry.targetDate, true)}</div>
                        <div className="cc-muted cc-small">{item.entry.method}</div>
                      </td>
                      <td className="cc-small">{lastNudgeText(item.entry) || <span className="cc-muted">Not yet</span>}</td>
                      {canEdit && (
                        <td>
                          <div className="cc-row-actions">
                            <button type="button" className="cc-btn cc-btn--primary cc-btn--small" onClick={() => setDialog({ kind: 'nudge', entry: item.entry, anniversary: item.anniversary })}>
                              Nudge
                            </button>
                            <button type="button" className="cc-btn cc-btn--small" onClick={() => startThisYear(item)}>
                              This year's entry
                            </button>
                            <button type="button" className="cc-btn cc-btn--ghost cc-btn--small" onClick={() => markNotRepeating(item.entry)}>
                              Won't repeat
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <section aria-label="All entries">
          <div className="cc-filters">
            <select value={String(cycle)} onChange={(e) => setCycle(e.target.value === 'all' ? 'all' : Number(e.target.value))} aria-label="Cycle">
              {cycles.map((y) => <option key={y} value={y}>{cycleLabel(y)}</option>)}
              <option value="all">All years</option>
            </select>
            <select value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Team">
              <option value="">All teams</option>
              {teams.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={sent} onChange={(e) => setSent(e.target.value as typeof sent)} aria-label="Sent">
              <option value="any">Sent or not</option>
              <option value="sent">Sent</option>
              <option value="unsent">Not sent</option>
            </select>
            <div className="cc-method-filter">
              {COMMS_METHODS.map((m) => (
                <label key={m} className="cc-check">
                  <input type="checkbox" checked={methods.has(m)} onChange={() => toggleMethod(m)} />
                  <span>{m}</span>
                </label>
              ))}
            </div>
            <input className="cc-search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
          </div>
          {visible.length === 0 ? (
            <div className="cc-empty">
              {entries.length === 0 ? 'The calendar is empty. Import last year\'s spreadsheet to get started.' : 'No entries match.'}
            </div>
          ) : (
            <div className="cc-table-wrap">
              <table className="cc-table">
                <thead>
                  <tr>
                    <th>Target</th>
                    <th>Subject</th>
                    <th>Method</th>
                    <th>Sent</th>
                    <th>Team</th>
                    <th>Milestone / comments</th>
                    <th>Nudges</th>
                    {canEdit && <th aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((entry) => (
                    <tr key={entry.id} className={entry.notRepeating ? 'cc-row--off' : ''}>
                      <td className="cc-nowrap">{formatShortDate(entry.targetDate, cycle === 'all')}</td>
                      <td>
                        <SubjectCell entry={entry} />
                        {entry.notRepeating && <span className="cc-tag cc-tag--muted">Won't repeat</span>}
                      </td>
                      <td>{entry.method}</td>
                      <td className="cc-nowrap">{formatShortDate(entry.dateSent, cycle === 'all')}</td>
                      <td>
                        <div>{entry.team}</div>
                        <ContactsLine entry={entry} />
                      </td>
                      <td className="cc-comments">{entry.comments}</td>
                      <td className="cc-small">{lastNudgeText(entry)}</td>
                      {canEdit && (
                        <td>
                          <div className="cc-row-actions">
                            {confirmDeleteId === entry.id ? (
                              <>
                                <button type="button" className="cc-btn cc-btn--danger cc-btn--small" onClick={() => remove(entry)}>Delete</button>
                                <button type="button" className="cc-btn cc-btn--ghost cc-btn--small" onClick={() => setConfirmDeleteId(null)}>Keep</button>
                              </>
                            ) : (
                              <>
                                <button type="button" className="cc-btn cc-btn--small" onClick={() => setDialog({ kind: 'edit', entry })}>Edit</button>
                                <button type="button" className="cc-btn cc-btn--ghost cc-btn--small" onClick={() => setConfirmDeleteId(entry.id)} aria-label={`Delete ${entry.subject}`}>Delete</button>
                              </>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {dialog?.kind === 'edit' && (
        <EntryFormModal
          entry={dialog.entry}
          initial={dialog.initial}
          entries={entries}
          submissions={submissions}
          onClose={() => setDialog(null)}
          onSaved={closeAndReload}
        />
      )}
      {dialog?.kind === 'nudge' && (
        <NudgeModal entry={dialog.entry} anniversary={dialog.anniversary} onClose={() => setDialog(null)} onSent={closeAndReload} />
      )}
      {dialog?.kind === 'import' && (
        <CsvImportModal entries={entries} onClose={() => setDialog(null)} onImported={load} />
      )}
      {dialog?.kind === 'fromRequest' && (
        <AddFromRequestModal
          entries={entries}
          submissions={submissions}
          onClose={() => setDialog(null)}
          onAdded={(entry) => {
            load();
            setDialog({ kind: 'edit', entry });
          }}
        />
      )}
    </div>
  );
};

export default CommsCalendar;
