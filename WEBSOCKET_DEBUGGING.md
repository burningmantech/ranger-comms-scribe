# WebSocket Debugging Guide

## Overview

This guide explains the debugging improvements made to the WebSocket collaboration system and how to troubleshoot connection issues.

## 🔧 **New Comprehensive Debugging Features**

### Backend Debugging Improvements

The WebSocket Durable Object now includes **extensive logging** to help identify connection issues:

- **Connection lifecycle tracking** with emoji-tagged logs
- **Room state management** with detailed user tracking  
- **Message broadcasting** with success/failure counts
- **WebSocket hibernation** event logging
- **Error handling** with comprehensive error messages

### Frontend Debugging Enhancements

1. **Enhanced Debug Panel** - Shows connection status, WebSocket state, and user counts
2. **New Debug Buttons**:
   - **Send Test Message** - Comprehensive test with current state data
   - **Request Room State** - Manually requests room state update
   - **Reconnect WebSocket** - Forces fresh connection
3. **Improved Console Logging** - Detailed logs for all WebSocket events

## 🧪 **Testing Tools**

### 1. Enhanced WebSocket Test Page

Location: `/websocket-test.html`

**New Features:**
- **Real-time debug info** showing connection URL, WebSocket state, and last message
- **Auto-reconnection** with exponential backoff
- **Better user management** with current user highlighting
- **Configurable backend URL** (defaults to `localhost:8787`)
- **Enhanced logging** with emoji indicators

**How to Use:**
1. Navigate to `http://localhost:3000/websocket-test.html`
2. Adjust backend URL if needed (default: `localhost:8787`)
3. Open multiple tabs with different user IDs
4. Test connections and messaging between tabs

### 2. Node.js Test Script

Location: `backend/test-websocket.js`

**Features:**
- Tests WebSocket connections from command line
- Simulates multiple users connecting to the same room
- Sends test messages between users
- Comprehensive logging of all events

**How to Use:**
```bash
cd backend
npm install ws  # If not already installed
node test-websocket.js
```

## 🔍 **Debugging Your Connection Issue**

Based on your description that users can see themselves but not others, here's how to debug:

### Step 1: Check Backend Logs

Start your backend with logging and look for these patterns when users connect:

```
🏗️ SubmissionWebSocketServer instance created
🔌 WebSocket upgrade parameters: { submissionId, userId, userName, userEmail }
👤 Storing connection metadata: [metadata object]
🏠 Room size after adding user: [number]
📢 Broadcasting user_joined message: [message object]
📤 Sending room state to new user: [room state object]
```

**Key Things to Check:**
- Are both users connecting to the **same submissionId**?
- Are they getting **different userIds**?
- Is the **room size increasing** when the second user connects?
- Are **broadcast messages being sent**?

### Step 2: Use the Enhanced Test Page

1. Open `http://localhost:3000/websocket-test.html` in two different browser tabs
2. Use the **same Submission ID** in both tabs
3. Use **different User IDs** (the page generates these automatically)
4. Connect both tabs and watch the logs

**What to Look For:**
- Both tabs should show "Connected" status
- User count should show 2 when both are connected
- Each tab should list both users in the "Connected Users" section
- Test messages should appear in both tabs

### Step 3: Check Frontend Logs

In your main application, check the browser console for:

```
🔌 Starting WebSocket connection process...
✅ WebSocket client created
🏠 Room state received: [room state object]
👋 User joined event received: [join message]
👥 Final mapped users being set: [users array]
```

**Key Indicators:**
- **Room state message** should contain all connected users
- **User joined events** should be received by other users
- **Connected users array** should be updated after each event

## 🔧 **Common Issues and Solutions**

### Issue: Users Not Seeing Each Other

**Most Likely Causes:**

1. **Different Submission IDs**: Users connecting to different rooms
   ```javascript
   // Check in console:
   console.log('Submission ID:', submissionId);
   ```

2. **Same User ID**: Both users using the same identifier
   ```javascript
   // Check in console:
   console.log('Effective User ID:', effectiveUserId);
   ```

3. **Durable Object Not Shared**: Backend creating separate instances
   - Check backend logs for room creation messages
   - Verify `env.SUBMISSION_WEBSOCKET.idFromName(submissionId)` is consistent

4. **WebSocket Hibernation Issues**: Messages not being processed
   - Look for hibernation handler logs in backend
   - Check if `webSocketMessage` events are being triggered

### Issue: Backend Connection Errors

**Debugging Steps:**

1. **Test Backend Accessibility:**
   ```bash
   curl http://localhost:8787/ws/test
   ```
   Should return WebSocket infrastructure test results.

2. **Check Durable Object Binding:**
   Look for `SUBMISSION_WEBSOCKET binding not found` errors.

3. **Verify Session Authentication:**
   Check if WebSocket requests are failing due to invalid session IDs.

### Issue: Frontend State Not Updating

**Debugging Steps:**

1. **Use Debug Buttons:**
   - Click "Request Room State" to force an update
   - Click "Reconnect WebSocket" to establish fresh connection

2. **Check Event Handlers:**
   Verify all WebSocket event handlers are properly set up and not being overridden.

3. **Check React State:**
   ```javascript
   // In browser console:
   console.log('Connected users state:', connectedUsers);
   ```

## 🔧 **Advanced Debugging Commands**

### Backend Console (if accessible):
```javascript
// Check active rooms
console.log('Active rooms:', Array.from(submissionRooms.keys()));

// Check connections per room  
console.log('Room connections:', submissionRooms.get('your-submission-id')?.size);
```

### Frontend Console:
```javascript
// Check WebSocket state
console.log('WebSocket state:', wsClientRef.current?.connectionState);

// Force room state request
wsClientRef.current?.send({ type: 'content_updated', data: { requestRoomState: true } });

// Check connected users
console.log('Connected users:', connectedUsers);
```

## 🏁 **Next Steps**

1. **Run the test page** with multiple tabs to verify the backend is working
2. **Check backend logs** when connecting multiple users
3. **Use the debug buttons** in your main application
4. **Compare console logs** between the test page and main application
5. **Run the Node.js test script** to verify from command line

The comprehensive logging should help identify exactly where the connection pooling is failing. Let me know what the logs show and I can help diagnose the specific issue!

## 🆘 **If You're Still Stuck**

Share these specific debug outputs:

1. **Backend logs** when two users connect
2. **Frontend console logs** from both browser tabs
3. **Test page results** showing whether it works there
4. **Network tab** showing WebSocket connection details

The enhanced debugging tools should provide enough information to identify and fix the root cause of the connection pooling issue. 