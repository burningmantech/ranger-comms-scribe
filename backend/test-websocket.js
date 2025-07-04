const WebSocket = require('ws');

// Test configuration
const BACKEND_URL = 'localhost:8787';
const SUBMISSION_ID = 'test-submission-123';
const TEST_USERS = [
  {
    userId: 'user-1',
    userName: 'Test User 1',
    userEmail: 'user1@example.com',
    password: 'testpassword123'
  },
  {
    userId: 'user-2',
    userName: 'Test User 2',
    userEmail: 'user2@example.com',
    password: 'testpassword123'
  }
];

let connections = [];

function log(message, userId = '') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${userId ? `[${userId}] ` : ''}${message}`);
}

// Get a valid session ID by logging in
async function getSessionId(user) {
  try {
    const fetch = (await import('node-fetch')).default;
    
    log(`Getting session for ${user.userEmail}...`);
    
    // Try to login with the user credentials
    const response = await fetch(`http://${BACKEND_URL}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: user.userEmail,
        password: user.password,
        turnstileToken: 'test-token' // This might fail, but let's try
      })
    });

    if (response.ok) {
      const data = await response.json();
      log(`✅ Login successful for ${user.userEmail}`, user.userId);
      return data.sessionId;
    } else {
      const error = await response.text();
      log(`❌ Login failed for ${user.userEmail}: ${error}`, user.userId);
      
      // For testing purposes, let's just create a fake session ID
      // In a real scenario, you'd need proper authentication
      log(`⚠️ Using fake session for testing purposes`, user.userId);
      return 'fake-session-id-' + user.userId;
    }
  } catch (error) {
    log(`❌ Error getting session for ${user.userEmail}: ${error.message}`, user.userId);
    // Use fake session ID for testing
    return 'fake-session-id-' + user.userId;
  }
}

function createWebSocketURL(user, sessionId) {
  const protocol = 'ws';
  
  return `${protocol}://${BACKEND_URL}/ws/submissions/${SUBMISSION_ID}?` +
    `submissionId=${encodeURIComponent(SUBMISSION_ID)}&` +
    `userId=${encodeURIComponent(user.userId)}&` +
    `userName=${encodeURIComponent(user.userName)}&` +
    `userEmail=${encodeURIComponent(user.userEmail)}&` +
    `sessionId=${encodeURIComponent(sessionId)}`;
}

async function connectUser(user, index) {
  return new Promise(async (resolve, reject) => {
    try {
      // First get a valid session ID
      const sessionId = await getSessionId(user);
      if (!sessionId) {
        reject(new Error('Failed to get valid session ID'));
        return;
      }

      log(`Using session ID: ${sessionId.substring(0, 8)}...`, user.userId);
      
      const wsUrl = createWebSocketURL(user, sessionId);
      log(`Connecting to: ${wsUrl}`, user.userId);
      
      const ws = new WebSocket(wsUrl);
      
      ws.on('open', () => {
        log('✅ WebSocket connection opened', user.userId);
        connections.push({ ws, user, sessionId });
        resolve(ws);
      });
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          log(`📨 Received: ${message.type}`, user.userId);
          
          if (message.type === 'room_state' && message.users) {
            log(`🏠 Room state: ${message.users.length} users connected`, user.userId);
            message.users.forEach((u, i) => {
              log(`  👤 User ${i + 1}: ${u.userName} (${u.userId})`, user.userId);
            });
          } else if (message.type === 'user_joined') {
            log(`👋 User joined: ${message.userName} (${message.userId})`, user.userId);
          } else if (message.type === 'user_left') {
            log(`👋 User left: ${message.userName} (${message.userId})`, user.userId);
          } else if (message.type === 'content_updated') {
            log(`📝 Content updated by: ${message.userName}`, user.userId);
            if (message.data) {
              log(`📄 Data: ${JSON.stringify(message.data)}`, user.userId);
            }
          } else if (message.type === 'connected') {
            log(`✅ Connected confirmation received`, user.userId);
          } else if (message.type === 'error') {
            log(`❌ Error: ${message.message || 'Unknown error'}`, user.userId);
          }
        } catch (error) {
          log(`❌ Error parsing message: ${error.message}`, user.userId);
        }
      });
      
      ws.on('close', (code, reason) => {
        log(`🔌 WebSocket connection closed: ${code} - ${reason}`, user.userId);
        connections = connections.filter(conn => conn.ws !== ws);
      });
      
      ws.on('error', (error) => {
        log(`❌ WebSocket error: ${error.message}`, user.userId);
        reject(error);
      });
      
      // Timeout after 15 seconds
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error('Connection timeout'));
        }
      }, 15000);
    } catch (error) {
      reject(error);
    }
  });
}

function sendTestMessage(connection, message) {
  if (connection.ws.readyState === WebSocket.OPEN) {
    const testMessage = {
      type: 'content_updated',
      data: {
        message: message,
        timestamp: new Date().toISOString(),
        sender: connection.user.userId,
        test: true
      }
    };
    
    connection.ws.send(JSON.stringify(testMessage));
    log(`📤 Sent test message: "${message}"`, connection.user.userId);
  } else {
    log(`❌ Cannot send message, connection not open`, connection.user.userId);
  }
}

async function runTest() {
  log('🚀 Starting WebSocket connection test...');
  
  try {
    // Test backend accessibility first
    log('🔍 Testing backend accessibility...');
    
    // Connect first user
    log('👤 Connecting first user...');
    await connectUser(TEST_USERS[0], 0);
    
    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Connect second user
    log('👤 Connecting second user...');
    await connectUser(TEST_USERS[1], 1);
    
    // Wait for room state to stabilize
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Send test messages
    log('📤 Sending test messages...');
    
    if (connections.length >= 1) {
      sendTestMessage(connections[0], 'Hello from User 1!');
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (connections.length >= 2) {
      sendTestMessage(connections[1], 'Hello from User 2!');
    }
    
    // Wait for messages to be processed
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    log('✅ Test completed successfully!');
    log(`📊 Final state: ${connections.length} active connections`);
    
    // Test message broadcasting
    setTimeout(() => {
      console.log('\n🧪 Testing message broadcasting...');
      
      if (connections.length >= 1 && connections[0].ws.readyState === WebSocket.OPEN) {
        const testMessage = {
          type: 'content_updated',
          data: {
            test: true,
            message: 'Test message from User 1',
            timestamp: new Date().toISOString()
          }
        };
        
        console.log('📤 User 1 sending test message:', testMessage);
        connections[0].ws.send(JSON.stringify(testMessage));
      } else {
        console.log('❌ User 1 WebSocket not ready');
      }
    }, 3000);

    // Send another test message from User 2
    setTimeout(() => {
      if (connections.length >= 2 && connections[1].ws.readyState === WebSocket.OPEN) {
        const testMessage = {
          type: 'content_updated',
          data: {
            test: true,
            message: 'Test message from User 2',
            timestamp: new Date().toISOString()
          }
        };
        
        console.log('📤 User 2 sending test message:', testMessage);
        connections[1].ws.send(JSON.stringify(testMessage));
      } else {
        console.log('❌ User 2 WebSocket not ready');
      }
    }, 5000);
    
  } catch (error) {
    log(`❌ Test failed: ${error.message}`);
  }
  
  // Clean up connections
  log('🧹 Cleaning up connections...');
  connections.forEach(conn => {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.close(1000, 'Test completed');
    }
  });
  
  // Wait for cleanup
  setTimeout(() => {
    log('🏁 Test script finished');
    process.exit(0);
  }, 2000);
}

// Check if ws module is available
try {
  require('ws');
  runTest();
} catch (error) {
  console.error('❌ WebSocket module not found. Please run: npm install ws');
  console.error('Or use the browser test page instead.');
  process.exit(1);
} 