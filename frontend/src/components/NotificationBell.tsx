import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_URL } from '../config';
import './NotificationBell.css';

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  submissionId?: string;
  read: boolean;
  createdAt: string;
}

const NOTIFICATION_ICONS: Record<string, string> = {
  approval_received: 'fas fa-check-circle',
  rejection_received: 'fas fa-times-circle',
  changes_made: 'fas fa-pen',
  assigned_as_approver: 'fas fa-user-check',
  submission_waiting: 'fas fa-clock',
  ready_to_send: 'fas fa-paper-plane',
  comment_on_change: 'fas fa-comment',
  comment_reply: 'fas fa-reply',
  changes_requested: 'fas fa-exclamation-circle',
};

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const NotificationBell: React.FC = () => {
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const sessionId = localStorage.getItem('sessionId');

  const fetchUnreadCount = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`${API_URL}/notifications/unread-count`, {
        headers: { Authorization: `Bearer ${sessionId}` },
      });
      if (res.ok) {
        const data = await res.json();
        setUnreadCount(data.unreadCount);
      }
    } catch { /* ignore */ }
  }, [sessionId]);

  // Poll every 30 seconds
  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const fetchNotifications = async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/notifications?limit=15`, {
        headers: { Authorization: `Bearer ${sessionId}` },
      });
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications);
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  const handleToggle = () => {
    if (!open) fetchNotifications();
    setOpen(!open);
  };

  const handleMarkAllRead = async () => {
    if (!sessionId) return;
    try {
      await fetch(`${API_URL}/notifications/read-all`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${sessionId}` },
      });
      setUnreadCount(0);
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch { /* ignore */ }
  };

  const handleNotificationClick = async (notif: Notification) => {
    if (!notif.read && sessionId) {
      try {
        await fetch(`${API_URL}/notifications/${notif.id}/read`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${sessionId}` },
        });
        setUnreadCount(prev => Math.max(0, prev - 1));
        setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, read: true } : n));
      } catch { /* ignore */ }
    }
    setOpen(false);
    if (notif.submissionId) {
      navigate(`/tracked-changes/${notif.submissionId}`);
    }
  };

  return (
    <div className="notification-bell" ref={dropdownRef}>
      <button className="notification-bell__trigger" onClick={handleToggle} title="Notifications">
        <i className="fas fa-bell" />
        {unreadCount > 0 && (
          <span className="notification-bell__badge">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="notification-bell__dropdown">
          <div className="notification-bell__header">
            <span className="notification-bell__title">Notifications</span>
            {unreadCount > 0 && (
              <button className="notification-bell__mark-read" onClick={handleMarkAllRead}>
                Mark all read
              </button>
            )}
          </div>
          <div className="notification-bell__list">
            {loading ? (
              <div className="notification-bell__loading">Loading...</div>
            ) : notifications.length === 0 ? (
              <div className="notification-bell__empty">No notifications</div>
            ) : (
              notifications.map(notif => (
                <button
                  key={notif.id}
                  className={`notification-bell__item ${!notif.read ? 'notification-bell__item--unread' : ''}`}
                  onClick={() => handleNotificationClick(notif)}
                >
                  <i className={`notification-bell__icon ${NOTIFICATION_ICONS[notif.type] || 'fas fa-bell'}`} />
                  <div className="notification-bell__content">
                    <div className="notification-bell__msg">{notif.message}</div>
                    <div className="notification-bell__time">{formatRelativeTime(new Date(notif.createdAt))}</div>
                  </div>
                  {!notif.read && <span className="notification-bell__dot" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
