import React, { useEffect } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}

/** A dialog over the page; Escape or a click outside closes it. */
export const Modal: React.FC<ModalProps> = ({ title, onClose, children, footer, wide }) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="cc-modal__overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`cc-modal${wide ? ' cc-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="cc-modal__header">
          <h2>{title}</h2>
          <button type="button" className="cc-modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="cc-modal__body">{children}</div>
        {footer && <div className="cc-modal__footer">{footer}</div>}
      </div>
    </div>
  );
};

export default Modal;
