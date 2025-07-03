// Types for Cloudflare Workers WebSocket API
declare global {
  interface WebSocketPair {
    0: WebSocket;
    1: WebSocket;
  }
  
  interface DurableObjectState {
    acceptWebSocket(ws: WebSocket): void;
  }
  
  interface ResponseInit {
    webSocket?: WebSocket;
  }
  
  var WebSocketPair: {
    new(): WebSocketPair;
  };
}

export interface WebSocketMessage {
  type: 'user_joined' | 'user_left' | 'editing_started' | 'editing_stopped' | 'content_updated' | 'comment_added' | 'approval_added' | 'status_changed' | 'error';
  submissionId: string;
  userId: string;
  userName: string;
  userEmail: string;
  data?: any;
  timestamp: string;
}

export interface ConnectionMetadata {
  submissionId: string;
  userId: string;
  userName: string;
  userEmail: string;
  connectedAt: string;
}

export class SubmissionWebSocketServer {
  private connections: Map<WebSocket, ConnectionMetadata> = new Map();
  private submissionRooms: Map<string, Set<WebSocket>> = new Map();
  protected ctx: DurableObjectState;
  protected env: any;

  constructor(ctx: DurableObjectState, env: any) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    console.log('🎯 Durable Object received request:', request.url);
    console.log('🎯 Upgrade header:', request.headers.get('Upgrade'));
    
    const url = new URL(request.url);
    
    // Handle WebSocket upgrade requests
    if (request.headers.get("Upgrade") === "websocket") {
      console.log('🔌 Handling WebSocket upgrade in Durable Object');
      return this.handleWebSocketUpgrade(request);
    }
    
    // Handle HTTP requests for room management
    if (url.pathname.startsWith("/api/rooms/")) {
      console.log('🏠 Handling room API request');
      return this.handleRoomAPI(request);
    }
    
    console.log('❌ No matching handler in Durable Object');
    return new Response("Not found", { status: 404 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const submissionId = url.searchParams.get("submissionId");
    const userId = url.searchParams.get("userId");
    const userName = url.searchParams.get("userName");
    const userEmail = url.searchParams.get("userEmail");

    if (!submissionId || !userId || !userName || !userEmail) {
      return new Response("Missing required parameters", { status: 400 });
    }

    // Create WebSocket pair
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Accept the WebSocket connection with hibernation support
    this.ctx.acceptWebSocket(server);

    // Store connection metadata
    const metadata: ConnectionMetadata = {
      submissionId,
      userId,
      userName,
      userEmail,
      connectedAt: new Date().toISOString()
    };

    console.log('👤 Storing connection metadata:', metadata);
    
    // Check if user is already in the room
    const room = this.submissionRooms.get(submissionId);
    let existingUserConnections = 0;
    if (room) {
      for (const ws of room) {
        const existingMetadata = this.connections.get(ws);
        if (existingMetadata && existingMetadata.userId === userId) {
          existingUserConnections++;
        }
      }
    }
    console.log('🔍 Existing connections for user', userId, ':', existingUserConnections);
    
    this.connections.set(server, metadata);

    // Add to submission room
    if (!this.submissionRooms.has(submissionId)) {
      this.submissionRooms.set(submissionId, new Set());
      console.log('🏠 Created new room for submission:', submissionId);
    }
    this.submissionRooms.get(submissionId)!.add(server);
    
    const roomSize = this.submissionRooms.get(submissionId)!.size;
    console.log('👥 Room size after adding user:', roomSize);

    // Notify other users in the room that someone joined
    this.broadcastToRoom(submissionId, {
      type: 'user_joined',
      submissionId,
      userId,
      userName,
      userEmail,
      timestamp: new Date().toISOString()
    }, server);

    // Send current room state to the new user
    const roomUsers = this.getRoomUsers(submissionId);
    server.send(JSON.stringify({
      type: 'room_state',
      submissionId,
      users: roomUsers,
      timestamp: new Date().toISOString()
    }));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleRoomAPI(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const submissionId = pathParts[3]; // /api/rooms/{submissionId}
    
    if (!submissionId) {
      return new Response("Missing submission ID", { status: 400 });
    }

    if (request.method === 'GET') {
      // Get room information
      const roomUsers = this.getRoomUsers(submissionId);
      return new Response(JSON.stringify({
        submissionId,
        users: roomUsers,
        userCount: roomUsers.length
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'POST') {
      // Broadcast message to room
      const message = await request.json();
      this.broadcastToRoom(submissionId, message);
      return new Response(JSON.stringify({ success: true }));
    }

    return new Response("Method not allowed", { status: 405 });
  }

  // WebSocket hibernation handlers
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const metadata = this.connections.get(ws);
      if (!metadata) {
        ws.close(1008, "Connection metadata not found");
        return;
      }

      const parsedMessage = JSON.parse(message as string) as WebSocketMessage;
      
      // Add metadata to the message
      parsedMessage.userId = metadata.userId;
      parsedMessage.userName = metadata.userName;
      parsedMessage.userEmail = metadata.userEmail;
      parsedMessage.submissionId = metadata.submissionId;
      parsedMessage.timestamp = new Date().toISOString();

      // Broadcast to room (excluding sender)
      this.broadcastToRoom(metadata.submissionId, parsedMessage, ws);

    } catch (error) {
      console.error('Error handling WebSocket message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to process message',
        timestamp: new Date().toISOString()
      }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const metadata = this.connections.get(ws);
    if (metadata) {
      // Remove from connections
      this.connections.delete(ws);
      
      // Remove from room
      const room = this.submissionRooms.get(metadata.submissionId);
      if (room) {
        room.delete(ws);
        if (room.size === 0) {
          this.submissionRooms.delete(metadata.submissionId);
        }
      }

      // Notify other users in the room
      this.broadcastToRoom(metadata.submissionId, {
        type: 'user_left',
        submissionId: metadata.submissionId,
        userId: metadata.userId,
        userName: metadata.userName,
        userEmail: metadata.userEmail,
        timestamp: new Date().toISOString()
      });
    }
  }

  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    console.error('WebSocket error:', error);
    const metadata = this.connections.get(ws);
    if (metadata) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'WebSocket error occurred',
        timestamp: new Date().toISOString()
      }));
    }
  }

  // Helper methods
  private broadcastToRoom(submissionId: string, message: WebSocketMessage, excludeWs?: WebSocket): void {
    const room = this.submissionRooms.get(submissionId);
    if (!room) return;

    const messageStr = JSON.stringify(message);
    
    for (const ws of room) {
      if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(messageStr);
        } catch (error) {
          console.error('Error sending message to WebSocket:', error);
          // Remove failed connection
          this.connections.delete(ws);
          room.delete(ws);
        }
      }
    }
  }

  private getRoomUsers(submissionId: string): Array<{ userId: string; userName: string; userEmail: string; connectedAt: string }> {
    const room = this.submissionRooms.get(submissionId);
    if (!room) {
      console.log('🏠 No room found for submission:', submissionId);
      return [];
    }

    console.log('🏠 Room has', room.size, 'connections for submission:', submissionId);
    const users: Array<{ userId: string; userName: string; userEmail: string; connectedAt: string }> = [];
    
    for (const ws of room) {
      const metadata = this.connections.get(ws);
      if (metadata) {
        console.log('👤 Found user in room:', metadata);
        users.push({
          userId: metadata.userId,
          userName: metadata.userName,
          userEmail: metadata.userEmail,
          connectedAt: metadata.connectedAt
        });
      } else {
        console.log('⚠️ WebSocket in room has no metadata');
      }
    }

    // Deduplicate users by userId to prevent frontend issues
    const uniqueUsers = users.reduce((acc, user) => {
      if (!acc.find(existing => existing.userId === user.userId)) {
        acc.push(user);
      } else {
        console.log('⚠️ Backend: Duplicate user found, skipping:', user.userId);
      }
      return acc;
    }, [] as typeof users);

    console.log('👥 Deduplicated users being returned:', uniqueUsers);
    return uniqueUsers;
  }

  // Public method to broadcast messages from external sources
  async broadcastMessage(submissionId: string, message: WebSocketMessage): Promise<void> {
    this.broadcastToRoom(submissionId, message);
  }
} 