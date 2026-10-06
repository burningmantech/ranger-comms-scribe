import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}

/**
 * A dialog over the page; Escape or a click outside closes it. Rendered on document.body, so a
 * dialog's own form works when it is opened from inside another form (the request form).
 */
/** Open dialogs, newest last: Escape closes only the one on top (e.g. Track over a request's dates). */
const openDialogs: symbol[] = [];

export const Modal: React.FC<ModalProps> = ({ title, onClose, children, footer, wide }) => {
  const [id] = useState(() => Symbol(title));
  useEffect(() => {
    openDialogs.push(id);
    return () => {
      openDialogs.splice(openDialogs.indexOf(id), 1);
    };
  }, [id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openDialogs[openDialogs.length - 1] === id) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, id]);

  return createPortal(
    <div className="cc-modal__overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`cc-modal${wide ? ' cc-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="cc-modal__header">
          <h2>{title}</h2>
          <button type="button" className="cc-modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="cc-modal__body">{children}</div>
        {footer && <div className="cc-modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
};

export default Modal;
