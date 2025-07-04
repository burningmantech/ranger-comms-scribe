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
  const [debugMessages, setDebugMessages] = useState<Array<{id: string, type: string, message: WebSocketMessage}>>([]);
  const [connectionHealth, setConnectionHealth] = useState<{
    isHealthy: boolean;
    lastHeartbeat: number;
    missedHeartbeats: number;
    timeSinceLastHeartbeat: number;
  }>({ isHealthy: false, lastHeartbeat: 0, missedHeartbeats: 0, timeSinceLastHeartbeat: 0 });
  const wsClientRef = useRef<SubmissionWebSocketClient | null>(null);

  // Get effective user ID (fallback to email if id is not available)
  const effectiveUserId = currentUser.id || currentUser.email;

  // Helper function to log all received messages for debugging
  const logDebugMessage = (type: string, message: WebSocketMessage) => {
    const debugEntry = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      type,
      message,
      timestamp: new Date().toISOString()
    };
    
    console.log(`📨 WebSocket message received:`, { type, message });
    console.log(`📨 From user:`, message.userId, message.userName);
    console.log(`📨 Current user:`, effectiveUserId);
    console.log(`📨 Is from current user:`, message.userId === effectiveUserId);
    
    setDebugMessages(prev => [...prev.slice(-20), debugEntry]); // Keep last 20 messages
  };

  useEffect(() => {
    let mounted = true;

    const connectToWebSocket = async () => {
      try {
        console.log('🔌 Starting WebSocket connection process...');
        console.log('🔌 Connection details:', {
          submissionId,
          effectiveUserId,
          currentUserName: currentUser.name,
          currentUserEmail: currentUser.email
        });
        
        const client = await webSocketManager.connectToSubmission(
          submissionId,
          effectiveUserId,
          currentUser.name,
          currentUser.email
        );
        
        if (!mounted) {
          console.log('⚠️ Component unmounted, skipping WebSocket setup');
          return;
        }
        
        console.log('✅ WebSocket client created:', client);
        wsClientRef.current = client;
        setConnectionStatus(client.connectionState);

        // Set up event handlers
        client.on('connected', (message) => {
          logDebugMessage('connected', message);
          console.log('🔗 Connected event received:', message);
          setConnectionStatus('connected');
        });

        client.on('room_state', (message) => {
          logDebugMessage('room_state', message);
          console.log('🏠 Room state received:', message);
          console.log('👥 Users in room:', message.users);
          console.log('🔍 Current user ID:', effectiveUserId);
          console.log('🔍 Current user details:', { effectiveUserId, currentUser });
          
          if (message.users) {
            // Log detailed user information
            message.users.forEach((user, index) => {
              console.log(`👤 User ${index + 1}:`, {
                userId: user.userId,
                userName: user.userName,
                userEmail: user.userEmail,
                connectedAt: user.connectedAt,
                isCurrentUser: user.userId === effectiveUserId
              });
            });
            
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
            
            console.log('👥 Final mapped users being set:', mappedUsers);
            setConnectedUsers(mappedUsers);
          } else {
            console.log('⚠️ No users array in room_state message');
          }
        });

        client.on('user_joined', (message) => {
          logDebugMessage('user_joined', message);
          console.log('👋 User joined event received:', message);
          console.log('🔍 Joining user ID:', message.userId, 'vs current user ID:', effectiveUserId);
          console.log('🔍 Is same user?', message.userId === effectiveUserId);
          console.log('🔍 Current connected users before update:', connectedUsers);
          
          setConnectedUsers(prev => {
            console.log('👥 Previous users in state:', prev);
            const existing = prev.find(u => u.userId === message.userId);
            console.log('🔍 User already exists in state?', !!existing);
            
            if (existing) {
              console.log('👥 User already in room, not adding duplicate');
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
            
            console.log('👥 Adding new user to state:', newUser);
            const updatedUsers = [...prev, newUser];
            
            // Deduplicate just in case (extra safety)
            const uniqueUsers = updatedUsers.reduce((acc, user) => {
              if (!acc.find(existing => existing.userId === user.userId)) {
                acc.push(user);
              } else {
                console.log('⚠️ Removing duplicate user during addition:', user.userId);
              }
              return acc;
            }, [] as typeof updatedUsers);
            
            console.log('👥 Final user list after user_joined:', uniqueUsers);
            return uniqueUsers;
          });
          
          // Show notification
          if (message.userId !== effectiveUserId) {
            console.log('🔔 Showing notification for other user joining');
            addNotification(message);
          } else {
            console.log('🔕 Not showing notification for current user joining');
          }
        });

        client.on('user_left', (message) => {
          logDebugMessage('user_left', message);
          console.log('User left:', message);
          setConnectedUsers(prev => prev.filter(u => u.userId !== message.userId));
          
          // Show notification
          if (message.userId !== effectiveUserId) {
            addNotification(message);
          }
        });

        client.on('editing_started', (message) => {
          logDebugMessage('editing_started', message);
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
          logDebugMessage('editing_stopped', message);
          console.log('User stopped editing:', message);
          setConnectedUsers(prev => prev.map(u => 
            u.userId === message.userId 
              ? { ...u, isEditing: false, lastActivity: message.timestamp }
              : u
          ));
        });

        client.on('content_updated', (message) => {
          logDebugMessage('content_updated', message);
          console.log('📝 Content updated event received:', message);
          console.log('📝 Message userId:', message.userId, 'vs effective userId:', effectiveUserId);
          console.log('📝 Is from current user?', message.userId === effectiveUserId);
          console.log('📝 Message data:', message.data);
          
          setConnectedUsers(prev => prev.map(u => 
            u.userId === message.userId 
              ? { ...u, lastActivity: message.timestamp }
              : u
          ));
          
          // Show notification
          if (message.userId !== effectiveUserId) {
            console.log('🔔 Adding notification for content_updated from other user');
            console.log('🔔 Notification will show:', formatMessageText(message));
            addNotification(message);
          } else {
            console.log('🔕 Not showing notification - message from current user');
          }
          
          // Call external message handler if provided
          if (onWebSocketMessage) {
            console.log('📤 Calling external WebSocket message handler');
            onWebSocketMessage(message);
          } else {
            console.log('📤 No external WebSocket message handler provided');
          }
        });

        client.on('comment_added', (message) => {
          logDebugMessage('comment_added', message);
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
          logDebugMessage('approval_added', message);
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
          logDebugMessage('status_changed', message);
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
          logDebugMessage('error', message);
          console.error('WebSocket error:', message);
          setConnectionStatus('error');
          addNotification(message);
        });

        client.on('session_expired', (message) => {
          logDebugMessage('session_expired', message);
          console.error('Session expired:', message);
          setConnectionStatus('session_expired');
          addNotification({
            ...message,
            data: { ...message.data, displayMessage: 'Your session has expired. Please refresh the page to reconnect.' }
          });
        });

      } catch (error) {
        console.error('Failed to connect to WebSocket:', error);
        setConnectionStatus('error');
      }
    };

    connectToWebSocket();

    // Set up periodic health check
    const healthCheckInterval = setInterval(() => {
      if (wsClientRef.current && mounted) {
        const health = wsClientRef.current.connectionHealth;
        setConnectionHealth(health);
        
        if (!health.isHealthy && wsClientRef.current.isConnected) {
          console.log('⚠️ Connection health degraded:', health);
          setConnectionStatus('unhealthy');
        } else if (health.isHealthy && wsClientRef.current.isConnected) {
          setConnectionStatus('connected');
        }
      }
    }, 5000); // Check every 5 seconds

    return () => {
      mounted = false;
      clearInterval(healthCheckInterval);
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
    
    console.log('🔔 Adding notification:', notification);
    console.log('🔔 Notification type:', notification.type);
    console.log('🔔 Notification will display as:', formatMessageText(notification));
    
    setNotifications(prev => {
      const updated = [...prev, notification];
      console.log('🔔 Updated notifications array:', updated);
      console.log('🔔 Total notifications count:', updated.length);
      return updated;
    });
    
    setTimeout(() => {
      console.log('🔔 Removing notification after 5 seconds:', notificationId);
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
      // Send a comprehensive test message with current state
      const testData = {
        test: true, // Flag to identify test messages
        message: `Test message from ${currentUser.name}`,
        timestamp: new Date().toISOString(),
        currentState: {
          submissionId,
          userId: effectiveUserId,
          userName: currentUser.name,
          userEmail: currentUser.email,
          connectionStatus: wsClientRef.current.connectionState,
          connectedUsersCount: connectedUsers.length,
          connectedUserIds: connectedUsers.map(u => u.userId)
        }
      };
      
      const messageToSend = {
        type: 'content_updated' as const,
        data: testData
      };
      
      console.log('🧪 Sending test message:', messageToSend);
      console.log('🧪 Test data:', testData);
      
      wsClientRef.current.send(messageToSend);
      
      // Also add a local notification so the sender can see it worked
      addNotification({
        type: 'content_updated',
        submissionId,
        userId: effectiveUserId,
        userName: currentUser.name,
        userEmail: currentUser.email,
        timestamp: new Date().toISOString(),
        data: { message: 'Test message sent successfully!' }
      } as WebSocketMessage);
    } else {
      console.error('❌ WebSocket client not available');
      // Show an error notification
      addNotification({
        type: 'error',
        submissionId,
        userId: effectiveUserId,
        userName: currentUser.name,
        userEmail: currentUser.email,
        timestamp: new Date().toISOString(),
        data: { error: 'WebSocket connection not available' }
      } as WebSocketMessage);
    }
  };

  // Debug function to manually request room state
  const requestRoomState = () => {
    if (wsClientRef.current) {
      wsClientRef.current.send({
        type: 'content_updated',
        data: { 
          requestRoomState: true,
          message: 'Requesting room state update'
        }
      });
      console.log('🏠 Room state update requested');
    }
  };

  // Debug function to reconnect WebSocket
  const reconnectWebSocket = async () => {
    if (wsClientRef.current) {
      console.log('🔄 Manually reconnecting WebSocket...');
      wsClientRef.current.disconnect();
      wsClientRef.current = null;
      setConnectionStatus('disconnected');
      setConnectedUsers([]);
      
      // Wait a moment then reconnect
      setTimeout(async () => {
        try {
          const client = await webSocketManager.connectToSubmission(
            submissionId,
            effectiveUserId,
            currentUser.name,
            currentUser.email
          );
          wsClientRef.current = client;
          setConnectionStatus(client.connectionState);
          console.log('🔄 Reconnection initiated');
        } catch (error) {
          console.error('❌ Reconnection failed:', error);
          setConnectionStatus('error');
        }
      }, 1000);
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
      case 'unhealthy': return 'text-orange-600';
      case 'session_expired': return 'text-purple-600';
      case 'error': return 'text-red-600';
      default: return 'text-gray-600';
    }
  };

  const getConnectionStatusIcon = () => {
    switch (connectionStatus) {
      case 'connected': return '🟢';
      case 'connecting': return '🟡';
      case 'unhealthy': return '🟠';
      case 'session_expired': return '🟣';
      case 'error': return '🔴';
      default: return '⚪';
    }
  };

  const getConnectionStatusText = () => {
    switch (connectionStatus) {
      case 'connected': return 'Connected';
      case 'connecting': return 'Connecting...';
      case 'unhealthy': return 'Connection Unstable';
      case 'session_expired': return 'Session Expired';
      case 'error': return 'Connection Error';
      default: return 'Disconnected';
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
        if (message.data?.displayMessage) {
          return message.data.displayMessage;
        }
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
          {getConnectionStatusIcon()} {getConnectionStatusText()}
        </span>
        <span className="text-sm text-gray-500">
          ({connectedUsers.length} user{connectedUsers.length !== 1 ? 's' : ''} connected)
        </span>
        {connectionHealth.isHealthy === false && wsClientRef.current?.isConnected && (
          <span className="text-xs text-orange-600" title={`${connectionHealth.missedHeartbeats} missed heartbeats`}>
            ⚠️ Health: {connectionHealth.missedHeartbeats}/3
          </span>
        )}
        {connectionStatus === 'session_expired' && (
          <button 
            onClick={() => window.location.reload()}
            className="px-3 py-1 bg-purple-500 hover:bg-purple-600 text-white text-xs rounded"
          >
            Refresh Page
          </button>
        )}
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
            <div><strong>Connection Status:</strong> {connectionStatus}</div>
            <div><strong>WebSocket State:</strong> {wsClientRef.current?.connectionState || 'not initialized'}</div>
            <div><strong>Is Connected:</strong> {wsClientRef.current?.isConnected ? 'Yes' : 'No'}</div>
            <div><strong>Health Status:</strong> {connectionHealth.isHealthy ? 'Healthy' : 'Unhealthy'}</div>
            <div><strong>Missed Heartbeats:</strong> {connectionHealth.missedHeartbeats}/3</div>
            <div><strong>Last Heartbeat:</strong> {connectionHealth.lastHeartbeat > 0 ? new Date(connectionHealth.lastHeartbeat).toLocaleTimeString() : 'Never'}</div>
            <div><strong>Time Since Last Heartbeat:</strong> {connectionHealth.timeSinceLastHeartbeat > 0 ? `${Math.round(connectionHealth.timeSinceLastHeartbeat / 1000)}s` : 'N/A'}</div>
          </div>
          <div className="mt-2 space-x-2">
            <button 
              onClick={sendTestMessage}
              className="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white text-xs rounded"
            >
              Send Test Message
            </button>
            <button 
              onClick={requestRoomState}
              className="px-3 py-1 bg-green-500 hover:bg-green-600 text-white text-xs rounded"
            >
              Request Room State
            </button>
            <button 
              onClick={reconnectWebSocket}
              className="px-3 py-1 bg-orange-500 hover:bg-orange-600 text-white text-xs rounded"
            >
              Reconnect WebSocket
            </button>
            <button 
              onClick={() => {
                if (wsClientRef.current) {
                  const health = wsClientRef.current.connectionHealth;
                  console.log('📊 Connection Health Check:', health);
                  alert(`Connection Health:\n- Healthy: ${health.isHealthy}\n- Missed Heartbeats: ${health.missedHeartbeats}/3\n- Time Since Last: ${Math.round(health.timeSinceLastHeartbeat / 1000)}s`);
                }
              }}
              className="px-3 py-1 bg-purple-500 hover:bg-purple-600 text-white text-xs rounded"
            >
              Check Health
            </button>
          </div>
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
          <h4 className="text-sm font-medium text-gray-700">Recent Activity ({notifications.length})</h4>
          <div className="space-y-1">
            {notifications.slice(-5).map((notification, index) => {
              console.log('🎨 Rendering notification:', notification);
              console.log('🎨 Notification text:', formatMessageText(notification));
              return (
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
              );
            })}
          </div>
        </div>
      )}

      {/* Debug: Show all notifications in development */}
      {process.env.NODE_ENV === 'development' && (
        <div className="mt-4 p-3 bg-gray-50 border border-gray-200 rounded-lg text-xs">
          <div className="font-semibold text-gray-800 mb-2">All Notifications Debug:</div>
          <div className="space-y-1 text-gray-700">
            <div><strong>Total Notifications:</strong> {notifications.length}</div>
            {notifications.map((notif, index) => (
              <div key={index} className="border-b pb-1 mb-1">
                <div><strong>#{index + 1}:</strong> {notif.type} from {notif.userName}</div>
                <div><strong>Message:</strong> {formatMessageText(notif)}</div>
                <div><strong>Time:</strong> {formatRelativeTime(notif.timestamp)}</div>
                {notif.data && <div><strong>Data:</strong> {JSON.stringify(notif.data)}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Debug: Show all received WebSocket messages */}
      {process.env.NODE_ENV === 'development' && (
        <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs">
          <div className="font-semibold text-blue-800 mb-2">All WebSocket Messages Debug:</div>
          <div className="space-y-1 text-blue-700 max-h-60 overflow-y-auto">
            <div><strong>Total Messages Received:</strong> {debugMessages.length}</div>
            {debugMessages.slice(-10).map((debugMsg, index) => (
              <div key={debugMsg.id} className="border-b pb-1 mb-1">
                <div><strong>#{debugMessages.length - 10 + index + 1}:</strong> {debugMsg.type} from {debugMsg.message.userName || 'Unknown'}</div>
                <div><strong>User ID:</strong> {debugMsg.message.userId}</div>
                <div><strong>Is Current User:</strong> {debugMsg.message.userId === effectiveUserId ? 'Yes' : 'No'}</div>
                <div><strong>Timestamp:</strong> {debugMsg.message.timestamp}</div>
                {debugMsg.message.data && <div><strong>Data:</strong> {JSON.stringify(debugMsg.message.data)}</div>}
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