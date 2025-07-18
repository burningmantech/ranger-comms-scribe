# WebSocket Troubleshooting Guide

## Current Issue Analysis

Based on the error logs you're seeing:

```
WebSocket connection to 'wss://scrivenly.com/api/ws/submissions/...' failed
WebSocket connection closed: 1006
```

Error code **1006** indicates "Abnormal Closure" - the connection was terminated without a proper close frame.

## Troubleshooting Steps

### 1. Test WebSocket Infrastructure

First, test if the basic WebSocket infrastructure is working:

```bash
# Test the WebSocket test endpoint
curl https://scrivenly.com/api/ws/test
```

This should return a JSON response indicating if the Durable Object binding is working.

### 2. Check Deployment Status

Verify the backend is properly deployed with Durable Objects:

```bash
cd backend
wrangler publish --dry-run
```

Look for any errors related to Durable Objects in the output.

### 3. Verify Durable Object Configuration

Check your `wrangler.toml` configuration:

```toml
[[durable_objects.bindings]]
name = "SUBMISSION_WEBSOCKET"
class_name = "SubmissionWebSocketServer"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SubmissionWebSocketServer"]  # ✅ Correct syntax
```

### 4. Check Session Authentication

The WebSocket connection requires a valid session. Test this in browser console:

```javascript
// Check if sessionId exists
console.log('Session ID:', localStorage.getItem('sessionId'));

// Test API access with current session
fetch('https://scrivenly.com/api/user/profile', {
  headers: {
    'Authorization': `Bearer ${localStorage.getItem('sessionId')}`
  }
}).then(r => r.json()).then(console.log);
```

### 5. Test WebSocket Connection Manually

Test the WebSocket connection manually in browser console:

```javascript
// Test WebSocket connection
const submissionId = '825b0eda-75d0-4840-9dfb-267f6e121af7';
const sessionId = localStorage.getItem('sessionId');
const wsUrl = `wss://scrivenly.com/api/ws/submissions/${submissionId}?submissionId=${submissionId}&userId=test&userName=Test&userEmail=test@example.com&sessionId=${sessionId}`;

const ws = new WebSocket(wsUrl);
ws.onopen = () => console.log('✅ Connected');
ws.onclose = (e) => console.log('❌ Closed:', e.code, e.reason);
ws.onerror = (e) => console.log('❌ Error:', e);
```

## Common Issues and Solutions

### Issue 1: Durable Object Not Deployed

**Symptoms:** Error 500, "binding not found"

**Solution:**
```bash
cd backend
wrangler publish
```

Wait for deployment to complete, then test again.

### Issue 2: Session Expired/Invalid

**Symptoms:** Error 403, connection closes immediately

**Solution:**
1. Log out and log back in to get a fresh session
2. Check if session is valid with API calls
3. Verify session format (should be a UUID)

### Issue 3: CORS Issues

**Symptoms:** Connection fails in browser but works in tools

**Solution:** WebSocket connections should not have CORS issues, but verify the API URL is correct.

### Issue 4: Wrangler Configuration Issues

**Symptoms:** Deployment succeeds but WebSocket doesn't work

**Solution:**
1. Update Wrangler CLI: `npm install -g wrangler@latest`
2. Verify syntax in `wrangler.toml`
3. Check for migration conflicts

### Issue 5: Local Development vs Production

**For Local Development:**
```bash
cd backend
wrangler dev --local
```

The WebSocket URL should be `ws://localhost:8787` instead of `wss://scrivenly.com/api`.

## Debug Commands

### Check Logs
```bash
# View worker logs
wrangler tail

# View specific submission logs
wrangler tail --grep "825b0eda-75d0-4840-9dfb-267f6e121af7"
```

### Test API Endpoints
```bash
# Test WebSocket infrastructure
curl https://scrivenly.com/api/ws/test

# Test submission access (with valid session)
curl https://scrivenly.com/api/content/submissions/825b0eda-75d0-4840-9dfb-267f6e121af7 \
  -H "Authorization: Bearer YOUR_SESSION_ID"

# Test WebSocket room info
curl https://scrivenly.com/api/ws/submissions/825b0eda-75d0-4840-9dfb-267f6e121af7/room \
  -H "Authorization: Bearer YOUR_SESSION_ID"
```

## Expected Console Output

When working correctly, you should see:

```
🔌 Attempting WebSocket connection to: wss://scrivenly.com/api/ws/submissions/...
✅ WebSocket connected to submission room: 825b0eda-75d0-4840-9dfb-267f6e121af7
```

## Immediate Actions

1. **Test the infrastructure endpoint:**
   ```bash
   curl https://scrivenly.com/api/ws/test
   ```

2. **Check if you can access the submission via API:**
   ```bash
   curl https://scrivenly.com/api/content/submissions/825b0eda-75d0-4840-9dfb-267f6e121af7 \
     -H "Authorization: Bearer $(localStorage.getItem('sessionId'))"
   ```

3. **Redeploy the backend:**
   ```bash
   cd backend
   wrangler publish
   ```

4. **Check Wrangler logs:**
   ```bash
   wrangler tail
   ```

If the issue persists after these steps, the problem is likely in the Durable Object deployment or configuration. Let me know the results of the test endpoint and we can debug further. 