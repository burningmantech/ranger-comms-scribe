import React, { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { commsCalendarService } from '../../services/commsCalendarService';
import {
  COMMS_METHODS, CommsCalendarEntry, CommsCalendarInput, CommsMethod,
} from '../../types/commsCalendar';
import { ContentSubmission } from '../../types/content';
import {
  anchorDate, cycleLabel, entryCycle, formatShortDate, isValidEmail, splitEmails,
} from '../../utils/commsCalendar';

interface EntryFormModalProps {
  /** The entry being edited; absent when adding one. */
  entry?: CommsCalendarEntry;
  /** Starting values for a new entry (e.g. this year's version of last year's). */
  initial?: CommsCalendarInput;
  entries: CommsCalendarEntry[];
  submissions: ContentSubmission[];
  onClose: () => void;
  onSaved: (entry: CommsCalendarEntry) => void;
}

interface FormState {
  subject: string;
  link: string;
  targetDate: string;
  dateSent: string;
  method: CommsMethod;
  team: string;
  contactEmails: string;
  comments: string;
  submissionId: string;
  carriedFromId: string;
  notRepeating: boolean;
  documentText: string;
}

function toForm(values: CommsCalendarInput | CommsCalendarEntry | undefined): FormState {
  return {
    subject: values?.subject ?? '',
    link: values?.link ?? '',
    targetDate: values?.targetDate ?? '',
    dateSent: values?.dateSent ?? '',
    method: values?.method ?? 'Announce',
    team: values?.team ?? '',
    contactEmails: (values?.contactEmails ?? []).join(', '),
    comments: values?.comments ?? '',
    submissionId: values?.submissionId ?? '',
    carriedFromId: values?.carriedFromId ?? '',
    notRepeating: values?.notRepeating ?? false,
    documentText: values?.documentText ?? '',
  };
}

/** Add or edit a calendar entry. */
export const EntryFormModal: React.FC<EntryFormModalProps> = ({
  entry, initial, entries, submissions, onClose, onSaved,
}) => {
  const [form, setForm] = useState<FormState>(() => toForm(entry ?? initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Teams already used, each with the contacts on its most recent entry
  const teamContacts = useMemo(() => {
    const latest = new Map<string, CommsCalendarEntry>();
    for (const e of entries) {
      if (!e.team) continue;
      const known = latest.get(e.team);
      if (!known || anchorDate(e) > anchorDate(known)) latest.set(e.team, e);
    }
    return latest;
  }, [entries]);

  // Entries this one could continue: anything other than itself, newest first
  const continuable = useMemo(
    () => entries
      .filter((e) => e.id !== entry?.id)
      .sort((a, b) => anchorDate(b).localeCompare(anchorDate(a))),
    [entries, entry?.id],
  );

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const onTeamChange = (team: string) => {
    setForm((f) => {
      const known = teamContacts.get(team);
      const fill = !f.contactEmails.trim() && known && known.contactEmails.length > 0;
      return { ...f, team, ...(fill ? { contactEmails: known!.contactEmails.join(', ') } : {}) };
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const emails = splitEmails(form.contactEmails);
    const bad = emails.find((e) => !isValidEmail(e));
    if (!form.subject.trim()) {
      setError('Subject is required');
      return;
    }
    if (bad) {
      setError(`Not an email address: ${bad}`);
      return;
    }
    const input: CommsCalendarInput = {
      subject: form.subject.trim(),
      link: form.link.trim() || null,
      targetDate: form.targetDate || null,
      dateSent: form.dateSent || null,
      method: form.method,
      team: form.team.trim(),
      contactEmails: emails,
      comments: form.comments,
      submissionId: form.submissionId || null,
      carriedFromId: form.carriedFromId || null,
      notRepeating: form.notRepeating,
      documentText: form.documentText.trim() || null,
    };
    setSaving(true);
    setError(null);
    try {
      const saved = entry
        ? await commsCalendarService.update(entry.id, input)
        : await commsCalendarService.create(input);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      setSaving(false);
    }
  };

  const linkableSubmissions = submissions.filter((s) => s.status === 'approved' || s.status === 'sent' || s.id === form.submissionId);

  return (
    <Modal
      title={entry ? 'Edit entry' : 'Add entry'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="cc-btn cc-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" form="cc-entry-form" className="cc-btn cc-btn--primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      )}
    >
      <form id="cc-entry-form" className="cc-form" onSubmit={submit}>
        {error && <div className="cc-error" role="alert">{error}</div>}
        <label className="cc-field cc-field--full">
          <span>Subject</span>
          <input value={form.subject} onChange={(e) => set('subject', e.target.value)} required maxLength={500} autoFocus />
        </label>
        <label className="cc-field">
          <span>Target send date</span>
          <input type="date" value={form.targetDate} onChange={(e) => set('targetDate', e.target.value)} />
        </label>
        <label className="cc-field">
          <span>Date sent</span>
          <input type="date" value={form.dateSent} onChange={(e) => set('dateSent', e.target.value)} />
        </label>
        <label className="cc-field">
          <span>Method</span>
          <select value={form.method} onChange={(e) => set('method', e.target.value as CommsMethod)}>
            {COMMS_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="cc-field">
          <span>Responsible team</span>
          <input list="cc-teams" value={form.team} onChange={(e) => onTeamChange(e.target.value)} maxLength={200} />
          <datalist id="cc-teams">
            {Array.from(teamContacts.keys()).sort().map((team) => <option key={team} value={team} />)}
          </datalist>
        </label>
        <label className="cc-field cc-field--full">
          <span>Team contacts</span>
          <input
            value={form.contactEmails}
            onChange={(e) => set('contactEmails', e.target.value)}
            placeholder="name@example.org, other@example.org"
          />
          <small>Who gets the nudge next year. Separate addresses with commas.</small>
        </label>
        <label className="cc-field cc-field--full">
          <span>Link to the message</span>
          <input type="url" value={form.link} onChange={(e) => set('link', e.target.value)} placeholder="https://" />
        </label>
        <label className="cc-field cc-field--full">
          <span>The message's text</span>
          <textarea
            rows={4}
            value={form.documentText}
            onChange={(e) => set('documentText', e.target.value)}
            placeholder="Paste the announcement here to find and track its dates (Dates)"
          />
          <small>Not needed when it came from a Scribe request.</small>
        </label>
        <label className="cc-field cc-field--full">
          <span>Milestone / comments</span>
          <textarea rows={2} value={form.comments} onChange={(e) => set('comments', e.target.value)} maxLength={5000} />
        </label>
        <label className="cc-field">
          <span>Scribe request</span>
          <select value={form.submissionId} onChange={(e) => set('submissionId', e.target.value)}>
            <option value="">None</option>
            {linkableSubmissions.map((s) => <option key={s.id} value={s.id}>{s.title || s.id}</option>)}
          </select>
        </label>
        <label className="cc-field">
          <span>Continues last year's</span>
          <select value={form.carriedFromId} onChange={(e) => set('carriedFromId', e.target.value)}>
            <option value="">None</option>
            {continuable.map((e) => {
              const date = e.targetDate || e.dateSent;
              return (
                <option key={e.id} value={e.id}>
                  {cycleLabel(entryCycle(e))} · {date ? `${formatShortDate(date)} · ` : ''}{e.subject}
                </option>
              );
            })}
          </select>
        </label>
        <label className="cc-check cc-field--full">
          <input type="checkbox" checked={form.notRepeating} onChange={(e) => set('notRepeating', e.target.checked)} />
          <span>Won't repeat next year (leave it off Coming up)</span>
        </label>
      </form>
    </Modal>
  );
};

export default EntryFormModal;
