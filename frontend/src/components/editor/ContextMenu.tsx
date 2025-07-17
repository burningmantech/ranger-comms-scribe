import React, { useRef, useEffect } from 'react';
import './styles/ContextMenuStyles.css';

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onEdit: () => void;
  onDelete?: () => void;
  canEdit?: boolean;
  canDelete?: boolean;
}

export default function ContextMenu({ x, y, onClose, onEdit, onDelete, canEdit = true, canDelete = true }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);



  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleEdit = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onEdit();
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onDelete) {
      onDelete();
    }
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 1000
      }}
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      {canEdit && (
        <div className="context-menu-item" onClick={handleEdit}>
          <i className="fas fa-edit"></i>
          <span>Edit</span>
        </div>
      )}
      {canDelete && onDelete && (
        <>
          <div className="context-menu-divider" />
          <div className="context-menu-item danger" onClick={handleDelete}>
            <i className="fas fa-trash-alt"></i>
            <span>Delete</span>
          </div>
        </>
      )}
    </div>
  );
} 