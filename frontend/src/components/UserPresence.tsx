import React, { useState, useEffect, useCallback } from 'react';
import { User, DocumentCollaborator } from '../types/content';
import './UserPresence.css';

export interface UserPresenceData {
  userId: string;
  userName: string;
  userEmail: string;
  status: 'online' | 'typing' | 'idle' | 'offline';
  lastSeen: string;
  cursor?: {
    position: number;
    selectionStart?: number;
    selectionEnd?: number;
  };
  currentActivity?: 'editing' | 'viewing' | 'commenting' | 'idle';
  avatar?: string;
  color?: string;
}

interface UserPresenceProps {
  users: UserPresenceData[];
  currentUser: User;
  showDetailed?: boolean;
  showActivity?: boolean;
  maxVisible?: number;
  onUserClick?: (userId: string) => void;
  compact?: boolean;
}

// Generate consistent colors for users
const generateUserColor = (userId: string): string => {
  // Use the same color palette as the cursor system
  const colors = [
    '#1a73e8', // Blue
    '#ea4335', // Red  
    '#34a853', // Green
    '#fbbc04', // Yellow
    '#ff6d01', // Orange
    '#9c27b0', // Purple
    '#00bcd4', // Cyan
    '#795548', // Brown
    '#607d8b', // Blue Grey
    '#e91e63', // Pink
  ];
  
  // Simple hash function to get consistent color for user
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) & 0xffffffff;
  }
  return colors[Math.abs(hash) % colors.length];
};

const getInitials = (name: string): string => {
  return name
    .split(' ')
    .map(word => word.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 2);
};

const getTimeAgo = (timestamp: string): string => {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return then.toLocaleDateString();
};

const getActivityIcon = (activity?: string): string => {
  switch (activity) {
    case 'editing': return '✏️';
    case 'viewing': return '👁️';
    case 'commenting': return '💬';
    case 'idle': return '😴';
    default: return '👤';
  }
};

const getStatusColor = (status: string): string => {
  switch (status) {
    case 'online': return '#00D2D3';
    case 'typing': return '#4ECDC4';
    case 'idle': return '#FFB142';
    case 'offline': return '#95A5A6';
    default: return '#95A5A6';
  }
};

export const UserPresence: React.FC<UserPresenceProps> = ({
  users,
  currentUser,
  showDetailed = false,
  showActivity = true,
  maxVisible = 5,
  onUserClick,
  compact = false
}) => {
  const [expanded, setExpanded] = useState(false);
  const [showTooltip, setShowTooltip] = useState<string | null>(null);

  // Include current user and sort by activity, with current user first
  const allUsers = users
    .sort((a, b) => {
      // Current user always comes first
      const aIsCurrent = a.userId === (currentUser.id || currentUser.email);
      const bIsCurrent = b.userId === (currentUser.id || currentUser.email);
      
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      
      // Sort by status priority: online > typing > idle > offline
      const statusPriority = { online: 3, typing: 4, idle: 2, offline: 1 };
      const aPriority = statusPriority[a.status] || 0;
      const bPriority = statusPriority[b.status] || 0;
      
      if (aPriority !== bPriority) {
        return bPriority - aPriority;
      }
      
      // Then by last seen (most recent first)
      return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    });

  const otherUsers = allUsers.filter(user => user.userId !== (currentUser.id || currentUser.email));

  const visibleUsers = expanded ? allUsers : allUsers.slice(0, maxVisible);
  const hiddenCount = allUsers.length - maxVisible;

  const handleUserClick = useCallback((userId: string) => {
    if (onUserClick) {
      onUserClick(userId);
    }
  }, [onUserClick]);

  if (compact) {
    return (
      <div className="user-presence-compact">
        {visibleUsers.map(user => {
          const isCurrentUser = user.userId === (currentUser.id || currentUser.email);
          return (
            <div
              key={user.userId}
              className={`user-avatar-compact ${user.status} ${isCurrentUser ? 'current-user' : ''}`}
              style={{ 
                backgroundColor: user.color || generateUserColor(user.userId),
                borderColor: isCurrentUser ? '#1a73e8' : getStatusColor(user.status),
                borderWidth: isCurrentUser ? '2px' : '1px'
              }}
              onClick={() => handleUserClick(user.userId)}
              onMouseEnter={() => setShowTooltip(user.userId)}
              onMouseLeave={() => setShowTooltip(null)}
              title={`${user.userName}${isCurrentUser ? ' (you)' : ''} - ${user.status}`}
            >
              <span className="avatar-text">{getInitials(user.userName)}</span>
              <div className={`status-indicator ${user.status}`}></div>
              {isCurrentUser && (
                <div className="current-user-badge">You</div>
              )}
            
              {showTooltip === user.userId && (
                <div className="user-tooltip">
                  <div className="tooltip-header">
                    <span className="tooltip-name">{user.userName}</span>
                    <span className="tooltip-status">{user.status}</span>
                  </div>
                  <div className="tooltip-details">
                    <div className="tooltip-email">{user.userEmail}</div>
                    <div className="tooltip-time">{getTimeAgo(user.lastSeen)}</div>
                    {showActivity && user.currentActivity && (
                      <div className="tooltip-activity">
                        {getActivityIcon(user.currentActivity)} {user.currentActivity}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        
        {hiddenCount > 0 && !expanded && (
          <div 
            className="more-users-compact"
            onClick={() => setExpanded(true)}
          >
            +{hiddenCount}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`user-presence ${showDetailed ? 'detailed' : ''}`}>
      <div className="presence-header">
        <h3 className="presence-title">
          {allUsers.length === 0 ? 'No one here' : 
           allUsers.length === 1 ? '1 person here' : 
           `${allUsers.length} people here`}
        </h3>
        
        {allUsers.length > 0 && (
          <div className="presence-summary">
            <span className="online-count">
              {allUsers.filter(u => u.status === 'online' || u.status === 'typing').length} online
            </span>
          </div>
        )}
      </div>

      <div className="presence-users">
        {(expanded ? allUsers : allUsers.slice(0, maxVisible)).map(user => {
          const isCurrentUser = user.userId === (currentUser.id || currentUser.email);
          return (
            <div
              key={user.userId}
              className={`presence-user ${user.status} ${isCurrentUser ? 'current-user' : ''}`}
              onClick={() => handleUserClick(user.userId)}
            >
              <div 
                className={`user-avatar ${user.status}`}
                style={{ 
                  backgroundColor: user.color || generateUserColor(user.userId),
                  borderColor: isCurrentUser ? '#1a73e8' : 'transparent',
                  borderWidth: isCurrentUser ? '2px' : '0px'
                }}
              >
                <span className="avatar-text">{getInitials(user.userName)}</span>
                <div className={`status-dot ${user.status}`}></div>
              </div>
              
              <div className="user-info">
                <div className="user-name">
                  {user.userName}
                  {isCurrentUser && <span className="current-user-indicator"> (you)</span>}
                </div>
                <div className="user-details">
                  <span className={`user-status ${user.status}`}>
                    {user.status === 'typing' && '✏️ '}
                    {user.status === 'online' && '🟢 '}
                    {user.status === 'idle' && '🟡 '}
                    {user.status === 'offline' && '⚫ '}
                    {user.status}
                  </span>
                  
                  {showActivity && user.currentActivity && (
                    <span className="user-activity">
                      {getActivityIcon(user.currentActivity)} {user.currentActivity}
                    </span>
                  )}
                  
                  <span className="user-time">{getTimeAgo(user.lastSeen)}</span>
                </div>
                
                {showDetailed && (
                  <div className="user-email">{user.userEmail}</div>
                )}
              </div>
              
              {user.status === 'typing' && (
                <div className="typing-indicator">
                  <div className="typing-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        
        {hiddenCount > 0 && !expanded && (
          <div 
            className="show-more-users"
            onClick={() => setExpanded(true)}
          >
            Show {hiddenCount} more {hiddenCount === 1 ? 'person' : 'people'}
          </div>
        )}
        
        {expanded && allUsers.length > maxVisible && (
          <div 
            className="show-less-users"
            onClick={() => setExpanded(false)}
          >
            Show less
          </div>
        )}
      </div>
    </div>
  );
};

export default UserPresence; 