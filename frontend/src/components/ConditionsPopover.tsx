import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApprovalGates, ApproverDetail, SubmissionReminder } from '../types/content';
import { councilRoleLabel } from '../utils/access';
import './ConditionsPopover.css';

/**
 * "N/4 conditions met" for the review top bar. The same four approval gates (and dots)
 * as the compact ApprovalTracker; clicking opens a popover that lists each gate as done
 * or not, with who approved it or who is still needed.
 */

export type GateRowStatus = 'met' | 'partial' | 'pending' | 'rejected';

export interface GateRow {
  key: 'councilManager' | 'commsCadre' | 'requiredApprovers' | 'trackedChanges';
  label: string;
  met: boolean;
  status: GateRowStatus;
  /** One line: who approved, or who / what is still needed. */
  detail: string;
}

const personName = (p: { name?: string; email: string }) => p.name || p.email;

/** "Pat (Intake Manager)", or "Pat (declined)". */
const approverLabel = (d: ApproverDetail) =>
  d.status === 'rejected' ? `${personName(d)} (declined)` : d.councilRole ? `${personName(d)} (${councilRoleLabel(d.councilRole)})` : personName(d);

/**
 * `pendingEdits`: the edits still to accept or reject as the review sidebar counts them
 * (one per card: a move is one edit). The server's gate counts change records, so a move
 * would count twice; without it, the gate's count is shown.
 */
export function buildGateRows(gates: ApprovalGates, pendingEdits?: number): GateRow[] {
  const cm = gates.councilManager;
  const cc = gates.commsCadre;
  const ra = gates.requiredApprovers;
  const tc = gates.trackedChanges;
  // The page's count can lag the server's (edits made in the editor since the page loaded
  // are not in its change list yet): 0 there while the gate has pending edits uses the gate's.
  const pending = tc.met ? 0 : (pendingEdits || tc.pending);

  const waitingFor = ra.details.filter((d) => d.status !== 'approved');
  const declined = ra.details.filter((d) => d.status === 'rejected');
  let raDetail: string;
  if (ra.total === 0) {
    raDetail = 'Nobody else to approve';
  } else if (ra.met) {
    raDetail = `All ${ra.total} approved`;
  } else {
    raDetail = `${ra.approved} of ${ra.total} approved. Still needed: ${waitingFor.map(approverLabel).join(', ')}`;
  }

  // Council: the council members on the approvers list (all must approve)
  const council = cm.approvers || [];
  const councilWaiting = council.filter((d) => d.status !== 'approved');
  const councilDeclined = council.some((d) => d.status === 'rejected');
  let cmDetail: string;
  if (cm.met) {
    cmDetail = `Approved by ${council.length ? council.map(approverLabel).join(', ') : cm.approverName || cm.approver || 'the council approver'}`;
  } else if (council.length === 0) {
    cmDetail = 'No council approver chosen yet. The Comms Cadre adds one to the approvers.';
  } else {
    const approved = council.length - councilWaiting.length;
    cmDetail = `${council.length > 1 ? `${approved} of ${council.length} approved. ` : ''}Waiting for ${councilWaiting.map(approverLabel).join(', ')}`;
  }

  return [
    {
      key: 'councilManager',
      label: 'Council',
      met: cm.met,
      status: cm.met ? 'met' : councilDeclined ? 'rejected' : council.length > councilWaiting.length ? 'partial' : 'pending',
      detail: cmDetail,
    },
    {
      key: 'commsCadre',
      label: 'Comms Cadre',
      met: cc.met,
      status: cc.met ? 'met' : 'pending',
      detail: cc.met
        ? `Approved by ${cc.approverName || cc.approver || 'a Comms Cadre member'}`
        : 'Needs approval from a Comms Cadre member',
    },
    {
      key: 'requiredApprovers',
      label: 'Other approvers',
      met: ra.met,
      status: ra.met ? 'met' : declined.length > 0 ? 'rejected' : ra.approved > 0 ? 'partial' : 'pending',
      detail: raDetail,
    },
    {
      key: 'trackedChanges',
      label: 'Edits resolved',
      met: tc.met,
      status: tc.met ? 'met' : pending > 0 ? 'partial' : 'pending',
      detail: tc.met
        ? 'All edits accepted or rejected'
        : pending > 0
          ? `${pending} edit${pending === 1 ? '' : 's'} still to accept or reject`
          : 'No edits yet',
    },
  ];
}

const STATUS_ICON: Record<GateRowStatus, string> = {
  met: 'fas fa-check-circle',
  partial: 'fas fa-adjust',
  pending: 'far fa-circle',
  rejected: 'fas fa-times-circle',
};

interface ConditionsPopoverProps {
  gates: ApprovalGates;
  /** Edits still to accept or reject, counted like the review sidebar (see buildGateRows). */
  pendingEdits?: number;
  /** Reminders already sent on this request (shown as "Reminded …"). */
  reminders?: SubmissionReminder[];
  /**
   * Sends a reminder (target: an approver's email, 'council' or 'commsCadre') and
   * resolves to the request's reminders; rejects with the reason. Omit to hide Remind.
   */
  onRemind?: (target: string) => Promise<SubmissionReminder[]>;
}

/** Remind buttons for an unmet gate: one per waiting approver, or one for the Comms Cadre. */
function remindTargets(row: GateRow, gates: ApprovalGates): Array<{ target: string; label: string }> {
  if (row.met) return [];
  const each = (list: ApproverDetail[]) => list
    .filter((d) => d.status !== 'approved')
    .map((d) => ({ target: d.email.toLowerCase(), label: `Remind ${personName(d)}` }));
  if (row.key === 'councilManager') return each(gates.councilManager.approvers || []);
  if (row.key === 'commsCadre') return [{ target: 'commsCadre', label: 'Remind the Comms Cadre' }];
  if (row.key === 'requiredApprovers') return each(gates.requiredApprovers.details);
  return [];
}

const REMIND_AGAIN_MS = 20 * 60 * 60 * 1000;

function reminderNote(reminders: SubmissionReminder[], target: string): { recent: boolean; text: string } | null {
  const last = [...reminders].reverse().find((r) => r.target === target);
  if (!last) return null;
  const at = new Date(last.at);
  const recent = Date.now() - at.getTime() < REMIND_AGAIN_MS;
  const when = at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return { recent, text: `Reminded ${when} by ${last.byName}` };
}

const ConditionsPopover: React.FC<ConditionsPopoverProps> = ({ gates, pendingEdits, reminders: initialReminders, onRemind }) => {
  const [open, setOpen] = useState(false);
  const [reminders, setReminders] = useState<SubmissionReminder[]>(initialReminders || []);
  const [busy, setBusy] = useState<string | null>(null);
  const [remindError, setRemindError] = useState<{ target: string; text: string } | null>(null);
  useEffect(() => setReminders(initialReminders || []), [initialReminders]);

  const remind = async (target: string) => {
    if (!onRemind) return;
    setBusy(target);
    setRemindError(null);
    try {
      setReminders(await onRemind(target));
    } catch (err) {
      setRemindError({ target, text: err instanceof Error ? err.message : 'Could not send the reminder' });
    } finally {
      setBusy(null);
    }
  };
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const rows = buildGateRows(gates, pendingEdits);
  const metCount = rows.filter((r) => r.met).length;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      }
    };
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open, close]);

  return (
    <div className="conditions-popover">
      <button
        ref={buttonRef}
        type="button"
        className="conditions-popover__trigger"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        title="Approval conditions"
      >
        <span className="conditions-popover__dots" aria-hidden="true">
          {rows.map((r) => (
            <span key={r.key} className={`conditions-popover__dot conditions-popover__dot--${r.status}`} />
          ))}
        </span>
        <span className="conditions-popover__count">{metCount}/4 conditions met</span>
        <i className={`fas fa-chevron-${open ? 'up' : 'down'} conditions-popover__chevron`} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={popoverRef}
          id={popoverId}
          className="conditions-popover__panel"
          role="dialog"
          aria-label="Approval conditions"
        >
          <div className="conditions-popover__heading">Approval conditions</div>
          <ul className="conditions-popover__list">
            {rows.map((r) => (
              <li key={r.key} className={`conditions-popover__row conditions-popover__row--${r.status}`} data-gate={r.key}>
                <i className={`${STATUS_ICON[r.status]} conditions-popover__icon`} aria-hidden="true" />
                <div className="conditions-popover__text">
                  <div className="conditions-popover__label">
                    {r.label}
                    <span className="conditions-popover__state">{r.met ? 'Done' : 'Not done'}</span>
                  </div>
                  <div className="conditions-popover__detail">{r.detail}</div>
                  {onRemind && remindTargets(r, gates).map(({ target, label }) => {
                    const note = reminderNote(reminders, target);
                    return (
                      <div key={target} className="conditions-popover__remind">
                        <button
                          type="button"
                          className="conditions-popover__remind-btn"
                          disabled={busy !== null || !!note?.recent}
                          onClick={() => remind(target)}
                          title={note?.recent ? 'Reminded in the last day' : 'Email them, and add a notification'}
                        >
                          <i className="fas fa-bell" aria-hidden="true" /> {busy === target ? 'Sending…' : label}
                        </button>
                        {note && <span className="conditions-popover__reminded">{note.text}</span>}
                        {remindError?.target === target && <span className="conditions-popover__remind-error" role="alert">{remindError.text}</span>}
                      </div>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default ConditionsPopover;
