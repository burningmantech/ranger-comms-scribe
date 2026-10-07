import React, { useState } from 'react';
import type { ChangeDescription } from '../../utils/changeDescriptions';

/** Longer text than this is cut, with "Show more". */
const TRUNCATE_AT = 140;

const cut = (s: string, open: boolean) => (open || s.length <= TRUNCATE_AT ? s : s.slice(0, TRUNCATE_AT).trimEnd() + '…');

/**
 * A change in plain language: "Added: …", "Deleted: …", "Replaced 'x' with 'y'",
 * "Moved: …", "Formatted: …". Long text is truncated with a Show more / Show less toggle.
 */
export const ChangeDescriptionText: React.FC<{ description: ChangeDescription }> = ({ description: d }) => {
  const [open, setOpen] = useState(false);
  const longest = Math.max((d.text || '').length, (d.from || '').length, (d.to || '').length);
  const toggle = longest > TRUNCATE_AT && (
    <button
      type="button"
      className="rp-link-btn rp-desc__more"
      onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
    >
      {open ? 'Show less' : 'Show more'}
    </button>
  );

  let body: React.ReactNode;
  switch (d.kind) {
    case 'added':
      body = d.text
        ? <><span className="rp-desc__verb">Added:</span> <span className="rp-desc__ins">{cut(d.text, open)}</span></>
        : <span className="rp-desc__verb">Added a {d.details?.[0] ?? 'line break'}</span>;
      break;
    case 'deleted':
      body = d.text
        ? <><span className="rp-desc__verb">Deleted:</span> <span className="rp-desc__del">{cut(d.text, open)}</span></>
        : <span className="rp-desc__verb">Deleted a {d.details?.[0] ?? 'line break'}</span>;
      break;
    case 'moved':
      body = <><span className="rp-desc__verb">Moved:</span> <span className="rp-desc__move">{cut(d.text, open)}</span></>;
      break;
    case 'replaced':
      body = (
        <>
          <span className="rp-desc__verb">Replaced</span>{' '}
          <span className="rp-desc__del">{cut(d.from || '', open)}</span>{' '}
          <span className="rp-desc__verb">with</span>{' '}
          <span className="rp-desc__ins">{cut(d.to || '', open)}</span>
        </>
      );
      break;
    case 'formatted':
    default:
      body = (
        <>
          <span className="rp-desc__verb">Formatted:</span>{' '}
          {(d.details || []).map((line, i) => (
            <span key={i} className="rp-desc__format">{i > 0 ? '; ' : ''}{line}</span>
          ))}
        </>
      );
  }
  return (
    <div className={`rp-desc rp-desc--${d.kind}`}>
      {body}
      {toggle}
    </div>
  );
};

export default ChangeDescriptionText;
