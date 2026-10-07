import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { newsletterService } from '../../services/newsletterService';
import { TrayItem } from '../../types/newsletter';

interface TrayPanelProps {
  /** Adds the request to the edition (the page saves first and reloads after). */
  onAdd: (submissionId: string) => Promise<void>;
  disabled: boolean;
  /** Changes when the edition's sections change, to reload the tray. */
  refreshKey: string;
}

const formatDate = (iso?: string) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

function Item({ item, onAdd, disabled, busy }: { item: TrayItem; onAdd?: () => void; disabled: boolean; busy: boolean }) {
  return (
    <li className={`nle-tray-item ${onAdd ? '' : 'nle-tray-upcoming'}`}>
      <div className="nle-tray-main">
        <Link to={`/tracked-changes/${item.id}`} className="nle-tray-title" title="Open the request">{item.headline}</Link>
        {item.headline !== item.title && <div className="nle-tray-sub">{item.title}</div>}
        <div className="nle-tray-meta">
          {item.hasBlurb ? 'Blurb' : 'No blurb'}
          {item.photoCount > 0 && ` · ${item.photoCount} photo${item.photoCount === 1 ? '' : 's'}`}
          {item.keyDateCount > 0 && ` · ${item.keyDateCount} date${item.keyDateCount === 1 ? '' : 's'}`}
          {item.readMore !== 'none' && ' · Read more'}
          {item.publishBy && ` · publish by ${formatDate(item.publishBy)}`}
        </div>
        {(item.writingHelp.blurb || (!item.hasBlurb && item.writingHelp.document)) && (
          <span className="nl-badge nl-badge-help">Needs a blurb written</span>
        )}
      </div>
      {onAdd ? (
        <button type="button" className="btn btn-sm btn-primary" onClick={onAdd} disabled={disabled || busy}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      ) : (
        <span className="nl-badge nl-badge-in_review">In review</span>
      )}
    </li>
  );
}

/** Approved newsletter requests not in any edition yet (and the ones still in review). */
export const TrayPanel: React.FC<TrayPanelProps> = ({ onAdd, disabled, refreshKey }) => {
  const [tray, setTray] = useState<{ ready: TrayItem[]; upcoming: TrayItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    newsletterService.getTray().then(setTray).catch((err) => setError(err.message));
  }, []);

  useEffect(load, [load, refreshKey]);

  const add = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await onAdd(id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
      load();
    }
  };

  return (
    <div className="nle-tray">
      <p className="nle-muted">Requests for the newsletter that aren't in an edition yet. Adding one copies its item into this edition; you can then edit it freely.</p>
      {error && <div className="field-error" role="alert">{error}</div>}
      {!tray && !error && <p className="nle-muted">Loading…</p>}
      {tray && (
        <>
          <h4 className="nle-tray-heading">Ready ({tray.ready.length})</h4>
          {tray.ready.length === 0 ? <p className="nle-muted">Nothing approved and waiting.</p> : (
            <ul className="nle-tray-list">
              {tray.ready.map((item) => (
                <Item key={item.id} item={item} onAdd={() => add(item.id)} disabled={disabled} busy={busyId === item.id} />
              ))}
            </ul>
          )}
          {tray.upcoming.length > 0 && (
            <>
              <h4 className="nle-tray-heading">Still in review ({tray.upcoming.length})</h4>
              <ul className="nle-tray-list">
                {tray.upcoming.map((item) => <Item key={item.id} item={item} disabled busy={false} />)}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
};

export default TrayPanel;
