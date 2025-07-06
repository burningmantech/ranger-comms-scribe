import { AutoRouter, json } from 'itty-router';
import { withAuth } from '../authWrappers';
import { User } from '../types';
import { WebSocketMessage } from '../services/websocketService';

export const router = AutoRouter({ base: '/ws' });

// Test endpoint to verify WebSocket infrastructure
router.get('/test', async (request: Request, env: any) => {
  console.log('🧪 WebSocket test endpoint called');
  
  try {
    // Test if Durable Object binding exists
    if (!env.SUBMISSION_WEBSOCKET) {
      return json({ 
        error: 'SUBMISSION_WEBSOCKET binding not found',
        available_bindings: Object.keys(env)
      }, { status: 500 });
    }
    
    // Test creating a Durable Object ID
    const testSubmissionId = 'test-submission-123';
    const durableObjectId = env.SUBMISSION_WEBSOCKET.idFromName(testSubmissionId);
    
    console.log('✅ Durable Object ID created successfully');
    
    return json({ 
      status: 'ok', 
      message: 'WebSocket infrastructure test passed',
      durableObjectId: durableObjectId.toString(),
      bindings: Object.keys(env)
    });
  } catch (error) {
    console.error('❌ WebSocket test failed:', error);
    return json({ 
      error: 'WebSocket infrastructure test failed', 
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
});

// WebSocket upgrade endpoint
router.get('/submissions/:submissionId', async (request: Request, env: any) => {
  console.log('🔌 WebSocket connection attempt for submission:', (request as any).params.submissionId);
  
  const { submissionId } = (request as any).params;
  const url = new URL(request.url);
  
  // Check if this is a WebSocket upgrade request
  const upgradeHeader = request.headers.get('Upgrade');
  console.log('🔍 Upgrade header:', upgradeHeader);
  
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    console.log('❌ Not a WebSocket upgrade request');
    return json(
      { error: 'Expected WebSocket upgrade request' },
      { status: 426, headers: { 'Upgrade': 'websocket' } }
    );
  }

  // Get sessionId from query parameters for WebSocket authentication
  const sessionId = url.searchParams.get('sessionId');
  console.log('🔑 Session ID provided:', sessionId ? '***' + sessionId.slice(-8) : 'none');
  
  if (!sessionId) {
    console.log('❌ No session ID provided');
    return json({ error: 'Session ID is required' }, { status: 400 });
  }

  // Validate the session
  const { GetSession } = await import('../utils/sessionManager');
  const { getUser } = await import('../services/userService');
  
  console.log('🔍 Validating session...');
  const session = await GetSession(sessionId, env);
  if (!session) {
    console.log('❌ Session not found or expired');
    return json({ error: 'Session not found or expired' }, { status: 403 });
  }

  const userData = session.data as { email: string; name: string };
  console.log('👤 Session user:', userData.email);
  
  const user = await getUser(userData.email, env);
  if (!user) {
    console.log('❌ User not found in database');
    return json({ error: 'User not found' }, { status: 403 });
  }

  console.log('✅ User authenticated:', user.email);

  // Check if user has access to this submission
  const { getObject } = await import('../services/cacheService');
  const { UserType } = await import('../types');
  
  const submission = await getObject(`content_submissions/${submissionId}`, env) as any;
  if (!submission) {
    return json({ error: 'Submission not found' }, { status: 404 });
  }

  // Check if user has access to this submission
  const hasAccess = user.userType === UserType.Admin ||
                   submission.submittedBy === user.id ||
                   (submission.requiredApprovers && submission.requiredApprovers.includes(user.email));

  if (!hasAccess) {
    return json({ error: 'Access denied' }, { status: 403 });
  }
  
  // Get the WebSocket Durable Object
  console.log('🏗️ Getting Durable Object for submission:', submissionId);
  
  try {
    const durableObjectId = env.SUBMISSION_WEBSOCKET.idFromName(submissionId);
    const stub = env.SUBMISSION_WEBSOCKET.get(durableObjectId);
    
    console.log('📡 Durable Object obtained, forwarding request');
    
    // Create the WebSocket URL with user information
    const wsUrl = new URL(request.url);
    wsUrl.searchParams.set('submissionId', submissionId);
    wsUrl.searchParams.set('userId', user.id || user.email);
    wsUrl.searchParams.set('userName', user.name);
    wsUrl.searchParams.set('userEmail', user.email);
    
    console.log('🔄 Forwarding to Durable Object with URL:', wsUrl.toString());
    
    // Create a new request with the updated URL
    const wsRequest = new Request(wsUrl.toString(), {
      headers: request.headers,
      method: request.method,
    });
    
    // Forward the request to the Durable Object
    const response = await stub.fetch(wsRequest);
    console.log('📨 Durable Object response status:', response.status);
    
    return response;
  } catch (error) {
    console.error('❌ Error with Durable Object:', error);
    return json({ error: 'Failed to connect to WebSocket service' }, { status: 500 });
  }
});

// HTTP API for broadcasting messages to WebSocket rooms
router.post('/submissions/:submissionId/broadcast', withAuth, async (request: Request, env: any) => {
  const { submissionId } = (request as any).params;
  const user = (request as any).user as User;
  const message = await request.json();
  
  // Get the WebSocket Durable Object
  const durableObjectId = env.SUBMISSION_WEBSOCKET.idFromName(submissionId);
  const stub = env.SUBMISSION_WEBSOCKET.get(durableObjectId);
  
  // Create the broadcast message
  const broadcastMessage: WebSocketMessage = {
    ...message,
    submissionId,
    userId: user.id || user.email,
    userName: user.name,
    userEmail: user.email,
    timestamp: new Date().toISOString()
  };
  
  // Send the broadcast request to the Durable Object
  const broadcastUrl = new URL(`http://localhost/api/rooms/${submissionId}`);
  const broadcastRequest = new Request(broadcastUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(broadcastMessage)
  });
  
  const response = await stub.fetch(broadcastRequest);
  
  if (response.ok) {
    return json({ success: true });
  } else {
    return json({ error: 'Failed to broadcast message' }, { status: 500 });
  }
});

// Get room information (connected users)
router.get('/submissions/:submissionId/room', withAuth, async (request: Request, env: any) => {
  const { submissionId } = (request as any).params;
  
  // Get the WebSocket Durable Object
  const durableObjectId = env.SUBMISSION_WEBSOCKET.idFromName(submissionId);
  const stub = env.SUBMISSION_WEBSOCKET.get(durableObjectId);
  
  // Get room information from the Durable Object
  const roomUrl = new URL(`http://localhost/api/rooms/${submissionId}`);
  const roomRequest = new Request(roomUrl.toString(), {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  });
  
  const response = await stub.fetch(roomRequest);
  
  if (response.ok) {
    const roomData = await response.json();
    return json(roomData);
  } else {
    return json({ error: 'Failed to get room information' }, { status: 500 });
  }
});

// Document-level collaboration endpoints
// WebSocket upgrade endpoint for documents
router.get('/documents/:documentId', async (request: Request, env: any) => {
  console.log('🔌 WebSocket connection attempt for document:', (request as any).params.documentId);
  
  const { documentId } = (request as any).params;
  const url = new URL(request.url);
  
  // Check if this is a WebSocket upgrade request
  const upgradeHeader = request.headers.get('Upgrade');
  console.log('🔍 Upgrade header:', upgradeHeader);
  
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    console.log('❌ Not a WebSocket upgrade request');
    return json(
      { error: 'Expected WebSocket upgrade request' },
      { status: 426, headers: { 'Upgrade': 'websocket' } }
    );
  }

  // Get sessionId from query parameters for WebSocket authentication
  const sessionId = url.searchParams.get('sessionId');
  console.log('🔑 Session ID provided:', sessionId ? '***' + sessionId.slice(-8) : 'none');
  
  if (!sessionId) {
    console.log('❌ No session ID provided');
    return json({ error: 'Session ID is required' }, { status: 400 });
  }

  // Validate the session
  const { GetSession } = await import('../utils/sessionManager');
  const { getUser } = await import('../services/userService');
  
  console.log('🔍 Validating session...');
  const session = await GetSession(sessionId, env);
  if (!session) {
    console.log('❌ Session not found or expired');
    return json({ error: 'Session not found or expired' }, { status: 403 });
  }

  const userData = session.data as { email: string; name: string };
  console.log('👤 Session user:', userData.email);
  
  const user = await getUser(userData.email, env);
  if (!user) {
    console.log('❌ User not found in database');
    return json({ error: 'User not found' }, { status: 403 });
  }

  console.log('✅ User authenticated:', user.email);

  // For document-level collaboration, we'll use the DOCUMENT_WEBSOCKET binding
  // (we'll need to add this to wrangler.toml)
  console.log('🏗️ Getting Durable Object for document:', documentId);
  
  try {
    // Use the same SUBMISSION_WEBSOCKET binding for now, but with document- prefix
    const durableObjectId = env.SUBMISSION_WEBSOCKET.idFromName(`document-${documentId}`);
    const stub = env.SUBMISSION_WEBSOCKET.get(durableObjectId);
    
    console.log('📡 Durable Object obtained, forwarding request');
    
    // Create the WebSocket URL with user information
    const wsUrl = new URL(request.url);
    wsUrl.searchParams.set('documentId', documentId);
    wsUrl.searchParams.set('userId', user.id || user.email);
    wsUrl.searchParams.set('userName', user.name);
    wsUrl.searchParams.set('userEmail', user.email);
    
    console.log('🔄 Forwarding to Durable Object with URL:', wsUrl.toString());
    
    // Create a new request with the updated URL
    const wsRequest = new Request(wsUrl.toString(), {
      headers: request.headers,
      method: request.method,
    });
    
    // Forward the request to the Durable Object
    const response = await stub.fetch(wsRequest);
    console.log('📨 Durable Object response status:', response.status);
    
    return response;
  } catch (error) {
    console.error('❌ Error with Durable Object:', error);
    return json({ error: 'Failed to connect to WebSocket service' }, { status: 500 });
  }
});

// HTTP API for broadcasting messages to document rooms
router.post('/documents/:documentId/broadcast', withAuth, async (request: Request, env: any) => {
  const { documentId } = (request as any).params;
  const user = (request as any).user as User;
  const message = await request.json();
  
  // Get the WebSocket Durable Object
  const durableObjectId = env.SUBMISSION_WEBSOCKET.idFromName(`document-${documentId}`);
  const stub = env.SUBMISSION_WEBSOCKET.get(durableObjectId);
  
  // Create the broadcast message
  const broadcastMessage: WebSocketMessage = {
    ...message,
    documentId,
    userId: user.id || user.email,
    userName: user.name,
    userEmail: user.email,
    timestamp: new Date().toISOString()
  };
  
  // Send the broadcast request to the Durable Object
  const broadcastUrl = new URL(`http://localhost/api/rooms/document-${documentId}`);
  const broadcastRequest = new Request(broadcastUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(broadcastMessage)
  });
  
  const response = await stub.fetch(broadcastRequest);
  
  if (response.ok) {
    return json({ success: true });
  } else {
    return json({ error: 'Failed to broadcast message' }, { status: 500 });
  }
});

// Get document room information (connected users)
router.get('/documents/:documentId/room', withAuth, async (request: Request, env: any) => {
  const { documentId } = (request as any).params;
  
  // Get the WebSocket Durable Object
  const durableObjectId = env.SUBMISSION_WEBSOCKET.idFromName(`document-${documentId}`);
  const stub = env.SUBMISSION_WEBSOCKET.get(durableObjectId);
  
  // Get room information from the Durable Object
  const roomUrl = new URL(`http://localhost/api/rooms/document-${documentId}`);
  const roomRequest = new Request(roomUrl.toString(), {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  });
  
  const response = await stub.fetch(roomRequest);
  
  if (response.ok) {
    const roomData = await response.json();
    return json(roomData);
  } else {
    return json({ error: 'Failed to get room information' }, { status: 500 });
  }
});

// Utility function to broadcast messages from other parts of the application
export async function broadcastToSubmissionRoom(
  submissionId: string,
  message: Omit<WebSocketMessage, 'submissionId' | 'timestamp'>,
  env: any
): Promise<void> {
  try {
    const durableObjectId = env.SUBMISSION_WEBSOCKET.idFromName(submissionId);
    const stub = env.SUBMISSION_WEBSOCKET.get(durableObjectId);
    
    const broadcastMessage: WebSocketMessage = {
      ...message,
      submissionId,
      timestamp: new Date().toISOString()
    };
    
    const broadcastUrl = new URL(`http://localhost/api/rooms/${submissionId}`);
    const broadcastRequest = new Request(broadcastUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(broadcastMessage)
    });
    
    await stub.fetch(broadcastRequest);
  } catch (error) {
    console.error('Failed to broadcast message to submission room:', error);
  }
}

// Utility function to broadcast messages to document rooms
export async function broadcastToDocumentRoom(
  documentId: string,
  message: Omit<WebSocketMessage, 'documentId' | 'timestamp'>,
  env: any
): Promise<void> {
  try {
    const durableObjectId = env.SUBMISSION_WEBSOCKET.idFromName(`document-${documentId}`);
    const stub = env.SUBMISSION_WEBSOCKET.get(durableObjectId);
    
    const broadcastMessage: WebSocketMessage = {
      ...message,
      documentId,
      timestamp: new Date().toISOString()
    };
    
    const broadcastUrl = new URL(`http://localhost/api/rooms/document-${documentId}`);
    const broadcastRequest = new Request(broadcastUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(broadcastMessage)
    });
    
    await stub.fetch(broadcastRequest);
  } catch (error) {
    console.error('Failed to broadcast message to document room:', error);
  }
} 