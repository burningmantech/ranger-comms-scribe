import { API_URL } from '../config';

export interface CursorPosition {
  userId: string;
  userName: string;
  userEmail: string;
  position: {
    key: string;
    offset: number;
    type: 'cursor' | 'selection';
    anchor?: { key: string; offset: number };
    focus?: { key: string; offset: number };
  };
  timestamp: string;
}

export interface TextOperation {
  type: 'insert' | 'delete' | 'format' | 'retain';
  position: number;
  content?: string;
  length?: number;
  attributes?: Record<string, any>;
  version: number; // For operational transforms
}

export interface CollaborativeDocumentState {
  content: string;
  version: number;
  users: Array<{ userId: string; userName: string; userEmail: string; connectedAt: string; cursor?: CursorPosition }>;
}

export interface WebSocketMessage {
  type: 'user_joined' | 'user_left' | 'editing_started' | 'editing_stopped' | 'content_updated' | 'comment_added' | 'approval_added' | 'status_changed' | 'error' | 'room_state' | 'connected' | 'heartbeat_response' | 'cursor_position' | 'text_operation' | 'user_presence' | 'typing_start' | 'typing_stop' | 'realtime_content_update';
  submissionId?: string; // Made optional to support document-level collaboration
  documentId?: string; // Added for document-level collaboration
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
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatTimeoutId: NodeJS.Timeout | null = null;
  private lastHeartbeatResponse: number = 0;
  private readonly HEARTBEAT_INTERVAL = 15000; // 15 seconds (more frequent)
  private readonly HEARTBEAT_TIMEOUT = 5000; // 5 seconds to wait for response
  private connectionHealthChecks = 0;
  private readonly MAX_MISSED_HEARTBEATS = 2; // Fail faster
  private messageQueue: Array<Omit<WebSocketMessage, 'submissionId' | 'userId' | 'userName' | 'userEmail' | 'timestamp'>> = [];
  private isConnecting = false;
  public applyRealTimeUpdate?: (content: string) => void;

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

    if (this.isConnecting) {
      console.log('⏳ WebSocket connection already in progress');
      return;
    }

    this.isIntentionallyClosed = false;
    this.isConnecting = true;
    
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) {
        throw new Error('No session ID found');
      }

      const sessionValid = await this.validateSession(sessionId);
      if (!sessionValid) {
        throw new Error('Session expired or invalid');
      }

      const wsUrl = new URL(`${API_URL}/ws/submissions/${this.submissionId}`);
      
      if (wsUrl.protocol === 'https:') {
        wsUrl.protocol = 'wss:';
      } else {
        wsUrl.protocol = 'ws:';
      }

      wsUrl.searchParams.set('submissionId', this.submissionId);
      wsUrl.searchParams.set('userId', this.userId);
      wsUrl.searchParams.set('userName', this.userName);
      wsUrl.searchParams.set('userEmail', this.userEmail);
      wsUrl.searchParams.set('sessionId', sessionId);

      console.log('🔌 Attempting WebSocket connection to:', wsUrl.toString());
      this.ws = new WebSocket(wsUrl.toString());

      this.ws.onopen = () => {
        console.log('✅ WebSocket connected to submission room:', this.submissionId);
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.connectionHealthChecks = 0;
        this.lastHeartbeatResponse = Date.now();
        this.startHeartbeat();
        
        // Process queued messages
        this.processMessageQueue();
        
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
          
          if (message.type === 'heartbeat_response') {
            this.handleHeartbeatResponse();
            return;
          }
          
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
        
        this.stopHeartbeat();
        this.ws = null;
        this.isConnecting = false;
        
        if (!this.isIntentionallyClosed && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 10000); // Cap at 10 seconds
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
      this.isConnecting = false;
      
      if (error instanceof Error && error.message.includes('Session')) {
        console.log('🔄 Session issue detected, attempting to refresh...');
        this.emit('session_expired', {
          type: 'error',
          submissionId: this.submissionId,
          userId: this.userId,
          userName: this.userName,
          userEmail: this.userEmail,
          data: { error: 'Session expired', needsRefresh: true },
          timestamp: new Date().toISOString()
        } as WebSocketMessage);
      }
      
      throw error;
    }
  }

  private processMessageQueue(): void {
    if (this.messageQueue.length === 0) return;
    
    console.log(`📤 Processing ${this.messageQueue.length} queued messages`);
    
    const messages = [...this.messageQueue];
    this.messageQueue = [];
    
    messages.forEach(message => {
      try {
        this.send(message);
      } catch (error) {
        console.error('Failed to send queued message:', error);
        // Re-queue the message if it fails
        this.messageQueue.push(message);
      }
    });
  }

  private async validateSession(sessionId: string): Promise<boolean> {
    try {
      const response = await fetch(`${API_URL}/auth/session`, {
        headers: {
          'Authorization': `Bearer ${sessionId}`
        }
      });
      return response.ok;
    } catch (error) {
      console.error('Session validation failed:', error);
      return false;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.heartbeatTimeoutId) {
      clearTimeout(this.heartbeatTimeoutId);
      this.heartbeatTimeoutId = null;
    }
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('⚠️ Cannot send heartbeat - WebSocket not open');
      return;
    }

    const heartbeatMessage = {
      type: 'heartbeat',
      submissionId: this.submissionId,
      userId: this.userId,
      userName: this.userName,
      userEmail: this.userEmail,
      timestamp: new Date().toISOString()
    };

    try {
      this.ws.send(JSON.stringify(heartbeatMessage));
      console.log('💓 Heartbeat sent');
      
      this.heartbeatTimeoutId = setTimeout(() => {
        this.handleHeartbeatTimeout();
      }, this.HEARTBEAT_TIMEOUT);
      
    } catch (error) {
      console.error('❌ Failed to send heartbeat:', error);
      this.handleHeartbeatTimeout();
    }
  }

  private handleHeartbeatResponse(): void {
    console.log('💓 Heartbeat response received');
    this.lastHeartbeatResponse = Date.now();
    this.connectionHealthChecks = 0;
    
    if (this.heartbeatTimeoutId) {
      clearTimeout(this.heartbeatTimeoutId);
      this.heartbeatTimeoutId = null;
    }
  }

  private handleHeartbeatTimeout(): void {
    this.connectionHealthChecks++;
    console.log(`⚠️ Heartbeat timeout (${this.connectionHealthChecks}/${this.MAX_MISSED_HEARTBEATS})`);
    
    if (this.connectionHealthChecks >= this.MAX_MISSED_HEARTBEATS) {
      console.log('💔 Connection appears stale, forcing reconnection');
      this.forceReconnect();
    }
  }

  private forceReconnect(): void {
    console.log('🔄 Forcing WebSocket reconnection due to stale connection');
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close(1000, 'Stale connection detected');
    }
    
    this.ws = null;
    this.isConnecting = false;
    this.connectionHealthChecks = 0;
    
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 1000;
    setTimeout(() => {
      if (!this.isIntentionallyClosed) {
        this.connect();
      }
    }, 1000 + jitter);
  }

  disconnect(): void {
    this.isIntentionallyClosed = true;
    this.isConnecting = false;
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close(1000, 'Intentional disconnect');
      this.ws = null;
    }
    
    // Clear message queue on intentional disconnect
    this.messageQueue = [];
  }

  send(message: Omit<WebSocketMessage, 'submissionId' | 'userId' | 'userName' | 'userEmail' | 'timestamp'>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket is not connected, queuing message');
      this.messageQueue.push(message);
      
      // Try to reconnect if not already connecting
      if (!this.isConnecting && !this.isIntentionallyClosed) {
        this.connect().catch(error => {
          console.error('Failed to reconnect for message sending:', error);
        });
      }
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

    try {
      this.ws.send(JSON.stringify(fullMessage));
    } catch (error) {
      console.error('Failed to send message:', error);
      // Queue the message for retry
      this.messageQueue.push(message);
    }
  }

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

  notifyEditingStarted(): void {
    this.send({ type: 'editing_started', data: { field: 'content' } });
  }

  notifyEditingStopped(): void {
    this.send({ type: 'editing_stopped', data: { field: 'content' } });
  }

  notifyContentUpdated(changes: any): void {
    this.send({ type: 'content_updated', data: changes });
  }

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

  get connectionHealth(): { 
    isHealthy: boolean; 
    lastHeartbeat: number; 
    missedHeartbeats: number;
    timeSinceLastHeartbeat: number;
    queuedMessages: number;
    reconnectAttempts: number;
    isConnecting: boolean;
  } {
    const now = Date.now();
    const timeSinceLastHeartbeat = now - this.lastHeartbeatResponse;
    const isHealthy = this.connectionHealthChecks < this.MAX_MISSED_HEARTBEATS && 
                     timeSinceLastHeartbeat < this.HEARTBEAT_INTERVAL * 2 &&
                     this.isConnected;
    
    return {
      isHealthy,
      lastHeartbeat: this.lastHeartbeatResponse,
      missedHeartbeats: this.connectionHealthChecks,
      timeSinceLastHeartbeat,
      queuedMessages: this.messageQueue.length,
      reconnectAttempts: this.reconnectAttempts,
      isConnecting: this.isConnecting
    };
  }
}

export class CollaborativeWebSocketClient {
  private ws: WebSocket | null = null;
  private documentId: string;
  private userId: string;
  private userName: string;
  private userEmail: string;
  private eventHandlers: Map<string, Set<WebSocketEventHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private isIntentionallyClosed = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatTimeoutId: NodeJS.Timeout | null = null;
  private lastHeartbeatResponse: number = 0;
  private readonly HEARTBEAT_INTERVAL = 15000;
  private readonly HEARTBEAT_TIMEOUT = 5000;
  private connectionHealthChecks = 0;
  private readonly MAX_MISSED_HEARTBEATS = 2;
  private messageQueue: Array<Omit<WebSocketMessage, 'userId' | 'userName' | 'userEmail' | 'timestamp'>> = [];
  private isConnecting = false;
  private documentVersion = 0;
  private pendingOperations: TextOperation[] = [];
  public applyRealTimeUpdate?: (content: string) => void;

  constructor(
    documentId: string,
    userId: string,
    userName: string,
    userEmail: string
  ) {
    this.documentId = documentId;
    this.userId = userId;
    this.userName = userName;
    this.userEmail = userEmail;
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.isConnecting) {
      console.log('⏳ WebSocket connection already in progress');
      return;
    }

    this.isIntentionallyClosed = false;
    this.isConnecting = true;
    
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) {
        throw new Error('No session ID found');
      }

      const sessionValid = await this.validateSession(sessionId);
      if (!sessionValid) {
        throw new Error('Session expired or invalid');
      }

      const wsUrl = new URL(`${API_URL}/ws/documents/${this.documentId}`);
      
      if (wsUrl.protocol === 'https:') {
        wsUrl.protocol = 'wss:';
      } else {
        wsUrl.protocol = 'ws:';
      }

      wsUrl.searchParams.set('documentId', this.documentId);
      wsUrl.searchParams.set('userId', this.userId);
      wsUrl.searchParams.set('userName', this.userName);
      wsUrl.searchParams.set('userEmail', this.userEmail);
      wsUrl.searchParams.set('sessionId', sessionId);

      console.log('🔌 Attempting WebSocket connection to document:', wsUrl.toString());
      this.ws = new WebSocket(wsUrl.toString());

      this.ws.onopen = () => {
        console.log('✅ WebSocket connected to document:', this.documentId);
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.connectionHealthChecks = 0;
        this.lastHeartbeatResponse = Date.now();
        this.startHeartbeat();
        
        this.processMessageQueue();
        
        this.emit('connected', {
          type: 'connected',
          documentId: this.documentId,
          userId: this.userId,
          userName: this.userName,
          userEmail: this.userEmail,
          timestamp: new Date().toISOString()
        } as WebSocketMessage);
      };

      this.ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          
          if (message.type === 'heartbeat_response') {
            this.handleHeartbeatResponse();
            return;
          }

          // Handle text operations for operational transforms
          if (message.type === 'text_operation' && message.data) {
            this.handleTextOperation(message.data);
          }
          
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
          documentId: this.documentId
        });
        
        this.stopHeartbeat();
        this.ws = null;
        this.isConnecting = false;
        
        if (!this.isIntentionallyClosed && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 10000);
          console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
          setTimeout(() => this.connect(), delay);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error('❌ Max reconnection attempts reached. WebSocket connection failed permanently.');
        }
      };

      this.ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
        this.isConnecting = false;
      };

    } catch (error) {
      console.error('❌ Error connecting to WebSocket:', error);
      this.isConnecting = false;
      throw error;
    }
  }

  private async validateSession(sessionId: string): Promise<boolean> {
    try {
      const response = await fetch(`${API_URL}/auth/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionId }),
      });
      return response.ok;
    } catch (error) {
      console.error('Session validation error:', error);
      return false;
    }
  }

  private handleTextOperation(operation: TextOperation): void {
    // Transform pending operations based on received operation
    this.pendingOperations = this.pendingOperations.map(pendingOp => 
      this.transformOperation(pendingOp, operation)
    );
    
    // Update document version
    this.documentVersion = Math.max(this.documentVersion, operation.version);
  }

  private transformOperation(op1: TextOperation, op2: TextOperation): TextOperation {
    // Basic operational transform - for production, use a more sophisticated OT library
    if (op1.type === 'insert' && op2.type === 'insert') {
      if (op1.position <= op2.position) {
        return op1;
      } else {
        return { ...op1, position: op1.position + (op2.content?.length || 0) };
      }
    } else if (op1.type === 'delete' && op2.type === 'insert') {
      if (op1.position <= op2.position) {
        return op1;
      } else {
        return { ...op1, position: op1.position + (op2.content?.length || 0) };
      }
    } else if (op1.type === 'insert' && op2.type === 'delete') {
      if (op1.position <= op2.position) {
        return op1;
      } else {
        return { ...op1, position: Math.max(op1.position - (op2.length || 0), op2.position) };
      }
    } else if (op1.type === 'delete' && op2.type === 'delete') {
      if (op1.position <= op2.position) {
        return op1;
      } else {
        return { ...op1, position: Math.max(op1.position - (op2.length || 0), op2.position) };
      }
    }
    
    return op1;
  }

  private processMessageQueue(): void {
    if (this.messageQueue.length === 0) return;
    
    console.log(`📤 Processing ${this.messageQueue.length} queued messages`);
    
    const messages = [...this.messageQueue];
    this.messageQueue = [];
    
    messages.forEach(message => {
      try {
        this.send(message);
      } catch (error) {
        console.error('Failed to send queued message:', error);
        this.messageQueue.push(message);
      }
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.heartbeatTimeoutId) {
      clearTimeout(this.heartbeatTimeoutId);
      this.heartbeatTimeoutId = null;
    }
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('⚠️ Cannot send heartbeat - WebSocket not open');
      return;
    }

    const heartbeatMessage = {
      type: 'heartbeat',
      documentId: this.documentId,
      userId: this.userId,
      userName: this.userName,
      userEmail: this.userEmail,
      timestamp: new Date().toISOString()
    };

    try {
      this.ws.send(JSON.stringify(heartbeatMessage));
      console.log('💓 Heartbeat sent');
      
      this.heartbeatTimeoutId = setTimeout(() => {
        this.handleHeartbeatTimeout();
      }, this.HEARTBEAT_TIMEOUT);
      
    } catch (error) {
      console.error('❌ Failed to send heartbeat:', error);
      this.handleHeartbeatTimeout();
    }
  }

  private handleHeartbeatResponse(): void {
    console.log('💓 Heartbeat response received');
    this.lastHeartbeatResponse = Date.now();
    this.connectionHealthChecks = 0;
    
    if (this.heartbeatTimeoutId) {
      clearTimeout(this.heartbeatTimeoutId);
      this.heartbeatTimeoutId = null;
    }
  }

  private handleHeartbeatTimeout(): void {
    console.log('⚠️ Heartbeat timeout - missed response');
    this.connectionHealthChecks++;
    
    if (this.connectionHealthChecks >= this.MAX_MISSED_HEARTBEATS) {
      console.log('💀 Too many missed heartbeats - forcing reconnection');
      this.forceReconnect();
    }
  }

  private forceReconnect(): void {
    console.log('🔄 Forcing WebSocket reconnection due to stale connection');
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close(1000, 'Stale connection detected');
    }
    
    this.ws = null;
    this.isConnecting = false;
    this.connectionHealthChecks = 0;
    
    const jitter = Math.random() * 1000;
    setTimeout(() => {
      if (!this.isIntentionallyClosed) {
        this.connect();
      }
    }, 1000 + jitter);
  }

  disconnect(): void {
    this.isIntentionallyClosed = true;
    this.isConnecting = false;
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close(1000, 'Intentional disconnect');
      this.ws = null;
    }
    
    this.messageQueue = [];
  }

  send(message: Omit<WebSocketMessage, 'userId' | 'userName' | 'userEmail' | 'timestamp'>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket is not connected, queuing message');
      this.messageQueue.push(message);
      
      if (!this.isConnecting && !this.isIntentionallyClosed) {
        this.connect().catch(error => {
          console.error('Failed to reconnect for message sending:', error);
        });
      }
      return;
    }

    const fullMessage: WebSocketMessage = {
      ...message,
      documentId: this.documentId,
      userId: this.userId,
      userName: this.userName,
      userEmail: this.userEmail,
      timestamp: new Date().toISOString()
    };

    try {
      this.ws.send(JSON.stringify(fullMessage));
    } catch (error) {
      console.error('Failed to send message:', error);
      this.messageQueue.push(message);
    }
  }

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

  sendCursorPosition(position: CursorPosition): void {
    this.send({
      type: 'cursor_position',
      data: position
    });
  }

  sendTextOperation(operation: TextOperation): void {
    operation.version = this.documentVersion + 1;
    this.pendingOperations.push(operation);
    
    this.send({
      type: 'text_operation',
      data: operation
    });
  }

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

export class WebSocketManager {
  private submissionClients: Map<string, SubmissionWebSocketClient> = new Map();
  private documentClients: Map<string, CollaborativeWebSocketClient> = new Map();

  getSubmissionClient(submissionId: string, userId: string, userName: string, userEmail: string): SubmissionWebSocketClient {
    const clientKey = `${submissionId}-${userId}`;
    
    if (!this.submissionClients.has(clientKey)) {
      const client = new SubmissionWebSocketClient(submissionId, userId, userName, userEmail);
      this.submissionClients.set(clientKey, client);
    }
    
    return this.submissionClients.get(clientKey)!;
  }

  getDocumentClient(documentId: string, userId: string, userName: string, userEmail: string): CollaborativeWebSocketClient {
    const clientKey = `${documentId}-${userId}`;
    
    if (!this.documentClients.has(clientKey)) {
      const client = new CollaborativeWebSocketClient(documentId, userId, userName, userEmail);
      this.documentClients.set(clientKey, client);
    }
    
    return this.documentClients.get(clientKey)!;
  }

  async connectToSubmission(submissionId: string, userId: string, userName: string, userEmail: string): Promise<SubmissionWebSocketClient> {
    const client = this.getSubmissionClient(submissionId, userId, userName, userEmail);
    
    if (!client.isConnected) {
      await client.connect();
    }
    
    return client;
  }

  async connectToDocument(documentId: string, userId: string, userName: string, userEmail: string): Promise<CollaborativeWebSocketClient> {
    const client = this.getDocumentClient(documentId, userId, userName, userEmail);
    
    if (!client.isConnected) {
      await client.connect();
    }
    
    return client;
  }

  disconnectFromSubmission(submissionId: string, userId: string): void {
    const clientKey = `${submissionId}-${userId}`;
    const client = this.submissionClients.get(clientKey);
    
    if (client) {
      client.disconnect();
      this.submissionClients.delete(clientKey);
    }
  }

  disconnectFromDocument(documentId: string, userId: string): void {
    const clientKey = `${documentId}-${userId}`;
    const client = this.documentClients.get(clientKey);
    
    if (client) {
      client.disconnect();
      this.documentClients.delete(clientKey);
    }
  }

  disconnectAll(): void {
    this.submissionClients.forEach(client => client.disconnect());
    this.submissionClients.clear();
    
    this.documentClients.forEach(client => client.disconnect());
    this.documentClients.clear();
  }
}

export const webSocketManager = new WebSocketManager(); 