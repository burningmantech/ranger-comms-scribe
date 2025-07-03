import React, { useState, useEffect, useRef } from 'react';
import { webSocketManager, WebSocketMessage, SubmissionWebSocketClient } from '../services/websocketService';
import { User } from '../types/content';

interface SubmissionCollaboratorsProps {
  submissionId: string;
  currentUser: User;
  onWebSocketMessage?: (message: WebSocketMessage) => void;
}

interface ConnectedUser {
  userId: string;
  userName: string;
  userEmail: string;
  connectedAt: string;
  isEditing?: boolean;
  lastActivity?: string;
}

export const SubmissionCollaborators = React.forwardRef<
  {
    notifyEditingStarted: () => void;
    notifyEditingStopped: () => void;
    notifyContentUpdated: (changes: any) => void;
  },
  SubmissionCollaboratorsProps
>(({ submissionId, currentUser, onWebSocketMessage }, ref) => {
  const [connectedUsers, setConnectedUsers] = useState<ConnectedUser[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<string>('disconnected');
  const [notifications, setNotifications] = useState<WebSocketMessage[]>([]);
  const wsClientRef = useRef<SubmissionWebSocketClient | null>(null);

  // Get effective user ID (fallback to email if id is not available)
  const effectiveUserId = currentUser.id || currentUser.email;

  useEffect(() => {
    let mounted = true;

    const connectToWebSocket = async () => {
      try {
        console.log('Connecting to WebSocket for submission:', submissionId);
        
        const client = await webSocketManager.connectToSubmission(
          submissionId,
          effectiveUserId,
          currentUser.name,
          currentUser.email
        );
        
        if (!mounted) return;
        
        wsClientRef.current = client;
        setConnectionStatus(client.connectionState);

        // Set up event handlers
        client.on('connected', (message) => {
          console.log('Connected to submission room:', message);
          setConnectionStatus('connected');
        });

        client.on('room_state', (message) => {
          console.log('🏠 Room state received:', message);
          console.log('👥 Users in room:', message.users);
          console.log('🔍 Current user ID:', effectiveUserId);
          console.log('🔍 Current user details:', { effectiveUserId, currentUser });
          
          if (message.users) {
            // Deduplicate users by userId to prevent React key conflicts
            const uniqueUsers = message.users.reduce((acc, user) => {
              if (!acc.find(existing => existing.userId === user.userId)) {
                acc.push(user);
              } else {
                console.log('⚠️ Duplicate user found, skipping:', user.userId);
              }
              return acc;
            }, [] as typeof message.users);

            const mappedUsers = uniqueUsers.map(user => ({
              ...user,
              isEditing: false,
              lastActivity: new Date().toISOString()
            }));
            console.log('👥 Deduplicated and mapped users:', mappedUsers);
            setConnectedUsers(mappedUsers);
          }
        });

        client.on('user_joined', (message) => {
          console.log('👋 User joined:', message);
          console.log('🔍 Joining user ID:', message.userId, 'vs current user ID:', effectiveUserId);
          console.log('🔍 Is same user?', message.userId === effectiveUserId);
          
          setConnectedUsers(prev => {
            console.log('👥 Previous users:', prev);
            const existing = prev.find(u => u.userId === message.userId);
            console.log('🔍 User already exists?', !!existing);
            
            if (existing) {
              console.log('👥 User already in room, not adding');
              return prev;
            }
            
            const newUser = {
              userId: message.userId,
              userName: message.userName,
              userEmail: message.userEmail,
              connectedAt: message.timestamp,
              isEditing: false,
              lastActivity: message.timestamp
            };
            
            console.log('👥 Adding new user:', newUser);
            const updatedUsers = [...prev, newUser];
            
            // Deduplicate just in case (extra safety)
            const uniqueUsers = updatedUsers.reduce((acc, user) => {
              if (!acc.find(existing => existing.userId === user.userId)) {
                acc.push(user);
              }
              return acc;
            }, [] as typeof updatedUsers);
            
            console.log('👥 Final user list after deduplication:', uniqueUsers);
            return uniqueUsers;
          });
          
          // Show notification
          if (message.userId !== effectiveUserId) {
            console.log('🔔 Showing notification for other user');
            addNotification(message);
          } else {
            console.log('🔕 Not showing notification for current user');
          }
        });

        client.on('user_left', (message) => {
          console.log('User left:', message);
          setConnectedUsers(prev => prev.filter(u => u.userId !== message.userId));
          
          // Show notification
          if (message.userId !== effectiveUserId) {
            addNotification(message);
          }
        });

        client.on('editing_started', (message) => {
          console.log('User started editing:', message);
          setConnectedUsers(prev => prev.map(u => 
            u.userId === message.userId 
              ? { ...u, isEditing: true, lastActivity: message.timestamp }
              : u
          ));
          
          // Show notification
          if (message.userId !== effectiveUserId) {
            addNotification(message);
          }
        });

        client.on('editing_stopped', (message) => {
          console.log('User stopped editing:', message);
          setConnectedUsers(prev => prev.map(u => 
            u.userId === message.userId 
              ? { ...u, isEditing: false, lastActivity: message.timestamp }
              : u
          ));
        });

        client.on('content_updated', (message) => {
          console.log('Content updated:', message);
          setConnectedUsers(prev => prev.map(u => 
            u.userId === message.userId 
              ? { ...u, lastActivity: message.timestamp }
              : u
          ));
          
          // Show notification
          if (message.userId !== effectiveUserId) {
            addNotification(message);
          }
          
          // Call external message handler if provided
          if (onWebSocketMessage) {
            onWebSocketMessage(message);
          }
        });

        client.on('comment_added', (message) => {
          console.log('Comment added:', message);
          
          // Show notification
          if (message.userId !== effectiveUserId) {
            addNotification(message);
          }
          
          // Call external message handler if provided
          if (onWebSocketMessage) {
            onWebSocketMessage(message);
          }
        });

        client.on('approval_added', (message) => {
          console.log('Approval added:', message);
          
          // Show notification
          if (message.userId !== effectiveUserId) {
            addNotification(message);
          }
          
          // Call external message handler if provided
          if (onWebSocketMessage) {
            onWebSocketMessage(message);
          }
        });

        client.on('status_changed', (message) => {
          console.log('Status changed:', message);
          
          // Show notification
          if (message.userId !== effectiveUserId) {
            addNotification(message);
          }
          
          // Call external message handler if provided
          if (onWebSocketMessage) {
            onWebSocketMessage(message);
          }
        });

        client.on('error', (message) => {
          console.error('WebSocket error:', message);
          setConnectionStatus('error');
          addNotification(message);
        });

      } catch (error) {
        console.error('Failed to connect to WebSocket:', error);
        setConnectionStatus('error');
      }
    };

    connectToWebSocket();

    return () => {
      mounted = false;
      if (wsClientRef.current) {
        webSocketManager.disconnectFromSubmission(submissionId, effectiveUserId);
        wsClientRef.current = null;
      }
    };
  }, [submissionId, effectiveUserId, currentUser.name, currentUser.email, onWebSocketMessage]);

  // Add notification and auto-remove after 5 seconds
  const addNotification = (message: WebSocketMessage) => {
    const notificationId = Date.now().toString();
    const notification = { ...message, id: notificationId } as WebSocketMessage & { id: string };
    
    setNotifications(prev => [...prev, notification]);
    
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => (n as any).id !== notificationId));
    }, 5000);
  };

  // Methods to call from parent component
  const notifyEditingStarted = () => {
    if (wsClientRef.current) {
      wsClientRef.current.notifyEditingStarted();
    }
  };

  const notifyEditingStopped = () => {
    if (wsClientRef.current) {
      wsClientRef.current.notifyEditingStopped();
    }
  };

  const notifyContentUpdated = (changes: any) => {
    if (wsClientRef.current) {
      wsClientRef.current.notifyContentUpdated(changes);
    }
  };

  // Debug function to send test message
  const sendTestMessage = () => {
    if (wsClientRef.current) {
      wsClientRef.current.send({
        type: 'editing_started',
        data: { test: true, message: 'Test message from ' + currentUser.name }
      });
    }
  };

  // Expose methods to parent component
  React.useImperativeHandle(ref, () => ({
    notifyEditingStarted,
    notifyEditingStopped,
    notifyContentUpdated
  }));

  const getConnectionStatusColor = () => {
    switch (connectionStatus) {
      case 'connected': return 'text-green-600';
      case 'connecting': return 'text-yellow-600';
      case 'error': return 'text-red-600';
      default: return 'text-gray-600';
    }
  };

  const getConnectionStatusIcon = () => {
    switch (connectionStatus) {
      case 'connected': return '🟢';
      case 'connecting': return '🟡';
      case 'error': return '🔴';
      default: return '⚪';
    }
  };

  const formatRelativeTime = (timestamp: string) => {
    const now = new Date();
    const time = new Date(timestamp);
    const diffMs = now.getTime() - time.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return `${Math.floor(diffMins / 1440)}d ago`;
  };

  const formatMessageText = (message: WebSocketMessage) => {
    switch (message.type) {
      case 'user_joined':
        return `${message.userName} joined the session`;
      case 'user_left':
        return `${message.userName} left the session`;
      case 'editing_started':
        return `${message.userName} started editing`;
      case 'editing_stopped':
        return `${message.userName} stopped editing`;
      case 'content_updated':
        return `${message.userName} updated the content`;
      case 'comment_added':
        return `${message.userName} added a comment`;
      case 'approval_added':
        return `${message.userName} added an approval`;
      case 'status_changed':
        return `${message.userName} changed the status`;
      case 'error':
        return `Error: ${message.data?.error || 'Unknown error'}`;
      default:
        return `${message.userName} performed an action`;
    }
  };

  return (
    <div className="submission-collaborators">
      {/* Connection Status */}
      <div className="flex items-center space-x-2 mb-4">
        <span className={`text-sm ${getConnectionStatusColor()}`}>
          {getConnectionStatusIcon()} {connectionStatus}
        </span>
        <span className="text-sm text-gray-500">
          ({connectedUsers.length} user{connectedUsers.length !== 1 ? 's' : ''} connected)
        </span>
      </div>

      {/* Debug Information - Remove this block when no longer needed */}
      {process.env.NODE_ENV === 'development' && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-xs">
          <div className="font-semibold text-yellow-800 mb-2">Debug Info:</div>
          <div className="space-y-1 text-yellow-700">
            <div><strong>Current User ID:</strong> {effectiveUserId}</div>
            <div><strong>Current User Name:</strong> {currentUser.name}</div>
            <div><strong>Current User Email:</strong> {currentUser.email}</div>
            <div><strong>Submission ID:</strong> {submissionId}</div>
            <div><strong>Connected Users Count:</strong> {connectedUsers.length}</div>
            <div><strong>Connected User IDs:</strong> {connectedUsers.map(u => u.userId).join(', ')}</div>
          </div>
          <button 
            onClick={sendTestMessage}
            className="mt-2 px-3 py-1 bg-yellow-500 hover:bg-yellow-600 text-white text-xs rounded"
          >
            Send Test Message
          </button>
        </div>
      )}

      {/* Connected Users */}
      {connectedUsers.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-gray-700 mb-2">Connected Users</h4>
                     <div className="space-y-2">
             {connectedUsers.map((user, index) => (
               <div
                 key={`${user.userId}-${user.connectedAt}-${index}`}
                 className="flex items-center space-x-2 p-2 bg-gray-50 rounded-lg"
               >
                <div className="flex-shrink-0">
                  <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-sm font-medium">
                    {user.userName.charAt(0).toUpperCase()}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2">
                    <span className="text-sm font-medium text-gray-900 truncate">
                      {user.userName}
                      {user.userId === effectiveUserId && (
                        <span className="text-xs text-gray-500 ml-1">(you)</span>
                      )}
                    </span>
                    {user.isEditing && (
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                        <span className="animate-pulse mr-1">✏️</span>
                        editing
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">
                    {user.lastActivity && formatRelativeTime(user.lastActivity)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Real-time Notifications */}
      {notifications.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700">Recent Activity</h4>
          <div className="space-y-1">
            {notifications.slice(-5).map((notification, index) => (
              <div
                key={index}
                className="flex items-center space-x-2 p-2 bg-blue-50 rounded-lg border-l-4 border-blue-400"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-900">
                    {formatMessageText(notification)}
                  </div>
                  <div className="text-xs text-gray-500">
                    {formatRelativeTime(notification.timestamp)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inline styles for animation - can be moved to CSS file later */}
      <style>{`
        .submission-collaborators {
          background: white;
          border-radius: 8px;
          padding: 16px;
          border: 1px solid #e5e7eb;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }
        
        .animate-pulse {
          animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        
        @keyframes pulse {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.5;
          }
        }
      `}</style>
    </div>
  );
});

export default SubmissionCollaborators; 