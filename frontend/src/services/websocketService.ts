import { API_URL } from '../config';

export interface WebSocketMessage {
  type: 'user_joined' | 'user_left' | 'editing_started' | 'editing_stopped' | 'content_updated' | 'comment_added' | 'approval_added' | 'status_changed' | 'error' | 'room_state' | 'connected';
  submissionId: string;
  userId: string;
  userName: string;
  userEmail: string;
  data?: any;
  timestamp: string;
  users?: Array<{ userId: string; userName: string; userEmail: string; connectedAt: string }>;
}

export type WebSocketEventHandler = (message: WebSocketMessage) => void;

export class SubmissionWebSocketClient {
  private ws: WebSocket | null = null;
  private submissionId: string;
  private userId: string;
  private userName: string;
  private userEmail: string;
  private eventHandlers: Map<string, Set<WebSocketEventHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private isIntentionallyClosed = false;

  constructor(
    submissionId: string,
    userId: string,
    userName: string,
    userEmail: string
  ) {
    this.submissionId = submissionId;
    this.userId = userId;
    this.userName = userName;
    this.userEmail = userEmail;
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    this.isIntentionallyClosed = false;
    
    try {
      // Create WebSocket URL
      const wsUrl = new URL(`${API_URL}/ws/submissions/${this.submissionId}`);
      
      // Convert HTTP/HTTPS to WS/WSS
      if (wsUrl.protocol === 'https:') {
        wsUrl.protocol = 'wss:';
      } else {
        wsUrl.protocol = 'ws:';
      }
      
      // Get session token for authentication
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) {
        throw new Error('No session ID found');
      }

      // Add user information and authentication as query parameters
      wsUrl.searchParams.set('submissionId', this.submissionId);
      wsUrl.searchParams.set('userId', this.userId);
      wsUrl.searchParams.set('userName', this.userName);
      wsUrl.searchParams.set('userEmail', this.userEmail);
      wsUrl.searchParams.set('sessionId', sessionId);

      // Create WebSocket connection
      console.log('🔌 Attempting WebSocket connection to:', wsUrl.toString());
      this.ws = new WebSocket(wsUrl.toString());

      // Set up event handlers
      this.ws.onopen = () => {
        console.log('✅ WebSocket connected to submission room:', this.submissionId);
        this.reconnectAttempts = 0;
        this.emit('connected', {
          type: 'connected',
          submissionId: this.submissionId,
          userId: this.userId,
          userName: this.userName,
          userEmail: this.userEmail,
          timestamp: new Date().toISOString()
        } as WebSocketMessage);
      };

      this.ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          this.emit(message.type, message);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      this.ws.onclose = (event) => {
        console.log('❌ WebSocket connection closed:', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          submissionId: this.submissionId
        });
        this.ws = null;
        
        if (!this.isIntentionallyClosed && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
          console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
          setTimeout(() => this.connect(), delay);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error('❌ Max reconnection attempts reached. WebSocket connection failed permanently.');
        }
      };

      this.ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
        console.error('❌ WebSocket error details:', {
          readyState: this.ws?.readyState,
          url: wsUrl.toString(),
          submissionId: this.submissionId,
          userId: this.userId
        });
        this.emit('error', {
          type: 'error',
          submissionId: this.submissionId,
          userId: this.userId,
          userName: this.userName,
          userEmail: this.userEmail,
          data: { error: 'WebSocket connection error' },
          timestamp: new Date().toISOString()
        } as WebSocketMessage);
      };

    } catch (error) {
      console.error('Failed to connect to WebSocket:', error);
      throw error;
    }
  }

  disconnect(): void {
    this.isIntentionallyClosed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(message: Omit<WebSocketMessage, 'submissionId' | 'userId' | 'userName' | 'userEmail' | 'timestamp'>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket is not connected');
      return;
    }

    const fullMessage: WebSocketMessage = {
      ...message,
      submissionId: this.submissionId,
      userId: this.userId,
      userName: this.userName,
      userEmail: this.userEmail,
      timestamp: new Date().toISOString()
    };

    this.ws.send(JSON.stringify(fullMessage));
  }

  // Event handling methods
  on(event: string, handler: WebSocketEventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: WebSocketEventHandler): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.eventHandlers.delete(event);
      }
    }
  }

  private emit(event: string, message: WebSocketMessage): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(message);
        } catch (error) {
          console.error('Error in WebSocket event handler:', error);
        }
      });
    }
  }

  // Convenience methods for common actions
  notifyEditingStarted(): void {
    this.send({ type: 'editing_started', data: { field: 'content' } });
  }

  notifyEditingStopped(): void {
    this.send({ type: 'editing_stopped', data: { field: 'content' } });
  }

  notifyContentUpdated(changes: any): void {
    this.send({ type: 'content_updated', data: { changes } });
  }

  // Get current connection status
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get connectionState(): string {
    if (!this.ws) return 'disconnected';
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING: return 'connecting';
      case WebSocket.OPEN: return 'connected';
      case WebSocket.CLOSING: return 'closing';
      case WebSocket.CLOSED: return 'closed';
      default: return 'unknown';
    }
  }
}

// Global WebSocket client manager
export class WebSocketManager {
  private clients: Map<string, SubmissionWebSocketClient> = new Map();

  getClient(submissionId: string, userId: string, userName: string, userEmail: string): SubmissionWebSocketClient {
    const clientKey = `${submissionId}-${userId}`;
    
    if (!this.clients.has(clientKey)) {
      const client = new SubmissionWebSocketClient(submissionId, userId, userName, userEmail);
      this.clients.set(clientKey, client);
    }
    
    return this.clients.get(clientKey)!;
  }

  async connectToSubmission(submissionId: string, userId: string, userName: string, userEmail: string): Promise<SubmissionWebSocketClient> {
    const client = this.getClient(submissionId, userId, userName, userEmail);
    
    if (!client.isConnected) {
      await client.connect();
    }
    
    return client;
  }

  disconnectFromSubmission(submissionId: string, userId: string): void {
    const clientKey = `${submissionId}-${userId}`;
    const client = this.clients.get(clientKey);
    
    if (client) {
      client.disconnect();
      this.clients.delete(clientKey);
    }
  }

  disconnectAll(): void {
    this.clients.forEach(client => client.disconnect());
    this.clients.clear();
  }
}

// Export singleton instance
export const webSocketManager = new WebSocketManager(); 