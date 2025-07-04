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
  type: 'user_joined' | 'user_left' | 'editing_started' | 'editing_stopped' | 'content_updated' | 'comment_added' | 'approval_added' | 'status_changed' | 'error' | 'room_state' | 'connected' | 'heartbeat' | 'heartbeat_response';
  submissionId: string;
  userId: string;
  userName: string;
  userEmail: string;
  data?: any;
  timestamp: string;
  users?: Array<{ userId: string; userName: string; userEmail: string; connectedAt: string }>;
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
    console.log('🏗️ SubmissionWebSocketServer instance created');
  }

  async fetch(request: Request): Promise<Response> {
    console.log('🎯 Durable Object received request:', request.url);
    console.log('🎯 Request method:', request.method);
    console.log('🎯 Upgrade header:', request.headers.get('Upgrade'));
    console.log('🎯 Current rooms:', Array.from(this.submissionRooms.keys()));
    console.log('🎯 Total connections:', this.connections.size);
    
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
    
    console.log('❌ No matching handler in Durable Object for path:', url.pathname);
    return new Response("Not found", { status: 404 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const submissionId = url.searchParams.get("submissionId");
    const userId = url.searchParams.get("userId");
    const userName = url.searchParams.get("userName");
    const userEmail = url.searchParams.get("userEmail");

    console.log('🔌 WebSocket upgrade parameters:', {
      submissionId,
      userId,
      userName,
      userEmail
    });

    if (!submissionId || !userId || !userName || !userEmail) {
      console.log('❌ Missing required parameters for WebSocket upgrade');
      return new Response("Missing required parameters", { status: 400 });
    }

    // Create WebSocket pair
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    console.log('🔗 WebSocket pair created');

    // Accept the WebSocket connection with hibernation support
    this.ctx.acceptWebSocket(server);
    console.log('✅ WebSocket accepted by Durable Object');

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
    console.log('🔍 Existing connections for user', userId, 'in room', submissionId, ':', existingUserConnections);
    
    this.connections.set(server, metadata);
    console.log('💾 Connection metadata stored. Total connections:', this.connections.size);

    // Add to submission room
    if (!this.submissionRooms.has(submissionId)) {
      this.submissionRooms.set(submissionId, new Set());
      console.log('🏠 Created new room for submission:', submissionId);
    }
    this.submissionRooms.get(submissionId)!.add(server);
    
    const roomSize = this.submissionRooms.get(submissionId)!.size;
    console.log('👥 Room size after adding user:', roomSize);
    console.log('🏠 Current room states:', Array.from(this.submissionRooms.entries()).map(([id, room]) => ({
      submissionId: id,
      connectionCount: room.size,
      users: Array.from(room).map(ws => this.connections.get(ws)?.userId).filter(Boolean)
    })));

    // Get current room state BEFORE broadcasting
    const roomUsers = this.getRoomUsers(submissionId);
    console.log('👥 Room users before broadcast:', roomUsers);

    // Notify other users in the room that someone joined
    const joinMessage = {
      type: 'user_joined' as const,
      submissionId,
      userId,
      userName,
      userEmail,
      timestamp: new Date().toISOString()
    };

    console.log('📢 Broadcasting user_joined message:', joinMessage);
    this.broadcastToRoom(submissionId, joinMessage, server);

    // Send current room state to the new user
    const roomStateMessage = {
      type: 'room_state' as const,
      submissionId,
      users: roomUsers,
      timestamp: new Date().toISOString()
    };

    console.log('📤 Sending room state to new user:', roomStateMessage);
    
    try {
      server.send(JSON.stringify(roomStateMessage));
      console.log('✅ Room state sent successfully');
    } catch (error) {
      console.error('❌ Error sending room state:', error);
    }

    // Also send a connected confirmation
    const connectedMessage = {
      type: 'connected' as const,
      submissionId,
      userId,
      userName,
      userEmail,
      timestamp: new Date().toISOString()
    };

    try {
      server.send(JSON.stringify(connectedMessage));
      console.log('✅ Connected confirmation sent');
    } catch (error) {
      console.error('❌ Error sending connected confirmation:', error);
    }

    console.log('🎉 WebSocket upgrade completed successfully');
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleRoomAPI(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const submissionId = pathParts[3]; // /api/rooms/{submissionId}
    
    console.log('🏠 Room API request for submission:', submissionId);
    console.log('🏠 Method:', request.method);
    
    if (!submissionId) {
      console.log('❌ Missing submission ID in room API request');
      return new Response("Missing submission ID", { status: 400 });
    }

    if (request.method === 'GET') {
      // Get room information
      const roomUsers = this.getRoomUsers(submissionId);
      console.log('🏠 Room API GET response:', { submissionId, users: roomUsers, userCount: roomUsers.length });
      
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
      console.log('🏠 Room API POST - broadcasting message:', message);
      
      this.broadcastToRoom(submissionId, message);
      return new Response(JSON.stringify({ success: true }));
    }

    return new Response("Method not allowed", { status: 405 });
  }

  // WebSocket hibernation handlers
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    console.log('📨 WebSocket message received in hibernation handler');
    
    try {
      const metadata = this.connections.get(ws);
      if (!metadata) {
        console.log('❌ No metadata found for WebSocket connection');
        ws.close(1008, "Connection metadata not found");
        return;
      }

      console.log('👤 Message from user:', metadata.userId, 'in submission:', metadata.submissionId);

      const parsedMessage = JSON.parse(message as string) as WebSocketMessage;
      console.log('📝 Parsed message:', parsedMessage);
      
      // Add metadata to the message
      parsedMessage.userId = metadata.userId;
      parsedMessage.userName = metadata.userName;
      parsedMessage.userEmail = metadata.userEmail;
      parsedMessage.submissionId = metadata.submissionId;
      parsedMessage.timestamp = new Date().toISOString();

      // Handle heartbeat messages
      if (parsedMessage.type === 'heartbeat') {
        console.log('💓 Heartbeat received from user:', metadata.userId);
        
        // Send heartbeat response directly to the sender
        const heartbeatResponse: WebSocketMessage = {
          type: 'heartbeat_response',
          submissionId: metadata.submissionId,
          userId: metadata.userId,
          userName: metadata.userName,
          userEmail: metadata.userEmail,
          timestamp: new Date().toISOString()
        };
        
        try {
          ws.send(JSON.stringify(heartbeatResponse));
          console.log('💓 Heartbeat response sent to user:', metadata.userId);
        } catch (error) {
          console.error('❌ Failed to send heartbeat response:', error);
        }
        
        return; // Don't broadcast heartbeat messages to other users
      }

      // Special debugging for test messages
      if (parsedMessage.type === 'content_updated' && parsedMessage.data?.test) {
        console.log('🧪 TEST MESSAGE DETECTED!');
        console.log('🧪 Test message data:', parsedMessage.data);
        console.log('🧪 Will broadcast to room:', metadata.submissionId);
        console.log('🧪 Sender will be excluded:', metadata.userId);
      }

      console.log('📤 Broadcasting message to room:', parsedMessage);
      
      // Broadcast to room (excluding sender)
      this.broadcastToRoom(metadata.submissionId, parsedMessage, ws);

      console.log('✅ Message broadcast completed');

    } catch (error) {
      console.error('❌ Error handling WebSocket message:', error);
      try {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Failed to process message',
          timestamp: new Date().toISOString()
        }));
      } catch (sendError) {
        console.error('❌ Error sending error message:', sendError);
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    console.log('🔌 WebSocket connection closed:', { code, reason, wasClean });
    
    const metadata = this.connections.get(ws);
    if (metadata) {
      console.log('👤 User disconnected:', metadata.userId, 'from submission:', metadata.submissionId);
      
      // Remove from connections
      this.connections.delete(ws);
      console.log('💾 Connection removed. Total connections:', this.connections.size);
      
      // Remove from room
      const room = this.submissionRooms.get(metadata.submissionId);
      if (room) {
        room.delete(ws);
        const newRoomSize = room.size;
        console.log('🏠 Room size after removal:', newRoomSize);
        
        if (newRoomSize === 0) {
          this.submissionRooms.delete(metadata.submissionId);
          console.log('🏠 Room deleted (empty):', metadata.submissionId);
        }
      }

      // Notify other users in the room
      const leaveMessage = {
        type: 'user_left' as const,
        submissionId: metadata.submissionId,
        userId: metadata.userId,
        userName: metadata.userName,
        userEmail: metadata.userEmail,
        timestamp: new Date().toISOString()
      };

      console.log('📢 Broadcasting user_left message:', leaveMessage);
      this.broadcastToRoom(metadata.submissionId, leaveMessage);
    } else {
      console.log('⚠️ No metadata found for closing WebSocket connection');
    }
  }

  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    console.error('❌ WebSocket error in hibernation handler:', error);
    
    const metadata = this.connections.get(ws);
    if (metadata) {
      console.log('👤 WebSocket error for user:', metadata.userId, 'in submission:', metadata.submissionId);
      
      try {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'WebSocket error occurred',
          timestamp: new Date().toISOString()
        }));
      } catch (sendError) {
        console.error('❌ Error sending error message:', sendError);
      }
    }
  }

  // Helper methods
  private broadcastToRoom(submissionId: string, message: WebSocketMessage, excludeWs?: WebSocket): void {
    const room = this.submissionRooms.get(submissionId);
    if (!room) {
      console.log('⚠️ No room found for submission:', submissionId);
      return;
    }

    const messageStr = JSON.stringify(message);
    console.log('📢 Broadcasting to room', submissionId, 'with', room.size, 'connections');
    console.log('📢 Message being broadcast:', message);
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const ws of room) {
      if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(messageStr);
          successCount++;
          
          const metadata = this.connections.get(ws);
          if (metadata) {
            console.log('✅ Message sent to user:', metadata.userId);
          }
        } catch (error) {
          console.error('❌ Error sending message to WebSocket:', error);
          errorCount++;
          
          // Remove failed connection
          this.connections.delete(ws);
          room.delete(ws);
          
          const metadata = this.connections.get(ws);
          if (metadata) {
            console.log('🗑️ Removed failed connection for user:', metadata.userId);
          }
        }
      } else {
        const metadata = this.connections.get(ws);
        if (metadata) {
          console.log('⏭️ Skipping message to user:', metadata.userId, 
            ws === excludeWs ? '(excluded sender)' : '(connection not open)');
        }
      }
    }
    
    console.log('📊 Broadcast results:', { successCount, errorCount, totalConnections: room.size });
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

    console.log('👥 Final deduplicated users being returned:', uniqueUsers);
    return uniqueUsers;
  }

  // Public method to broadcast messages from external sources
  async broadcastMessage(submissionId: string, message: WebSocketMessage): Promise<void> {
    console.log('📢 External broadcast request for submission:', submissionId);
    console.log('📢 External message:', message);
    
    this.broadcastToRoom(submissionId, message);
  }
} 