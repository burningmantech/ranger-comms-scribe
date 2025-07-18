# WebSocket Collaboration Testing Guide

## 🧪 Testing Multiple Users

To properly test WebSocket collaboration with different users, follow these steps:

### Method 1: Different Browsers
1. **Chrome**: Log in as User A (alexander.young@gmail.com)
2. **Firefox/Safari**: Log in as User B (different email)
3. Navigate both to the same submission URL
4. Watch the "Connected Users" section

### Method 2: Incognito/Private Windows
1. **Regular Chrome**: Log in as User A
2. **Chrome Incognito**: Log in as User B  
3. Navigate both to the same submission
4. Compare the connected users list

### Method 3: Different Devices
1. **Desktop**: Log in as User A
2. **Mobile/Tablet**: Log in as User B
3. Navigate to the same submission URL

## 🔍 What to Look For

### Expected Behavior:
```
Connected Users:
┌─────────────────────────────────────┐
│ 🟢 connected (2 users connected)   │
│                                     │
│ AY  Alex Young                      │
│     just now                        │
│                                     │
│ JD  Jane Doe                        │
│     just now                        │
└─────────────────────────────────────┘
```

### Current Issue Debug:
Open browser console and look for these logs:

```javascript
// Should show different user IDs
🔍 Current user ID: alexander.young@gmail.com
🔍 Joining user ID: jane.doe@gmail.com vs current user ID: alexander.young@gmail.com
🔍 Is same user? false

// Should show multiple users
👥 Users in room: [
  { userId: "alexander.young@gmail.com", userName: "Alex Young", ... },
  { userId: "jane.doe@gmail.com", userName: "Jane Doe", ... }
]
```

## 🐛 Debugging Steps

### 1. Check User Identification
In each browser console, run:
```javascript
// Check current user details
console.log('Current user:', {
  id: window.currentUser?.id,
  email: window.currentUser?.email,
  name: window.currentUser?.name
});

// Check session
console.log('Session ID:', localStorage.getItem('sessionId'));
```

### 2. Test WebSocket Connection
```javascript
// Check WebSocket connection details
const wsConnections = document.querySelector('[data-testid="collaboration"]');
console.log('WebSocket status:', wsConnections);
```

### 3. Manual WebSocket Test
Test WebSocket with different user parameters:

**Browser 1 (User A):**
```javascript
const submissionId = '825b0eda-75d0-4840-9dfb-267f6e121af7';
const sessionId = localStorage.getItem('sessionId');
const wsUrl = `wss://scrivenly.com/api/ws/submissions/${submissionId}?submissionId=${submissionId}&userId=user-a@example.com&userName=User+A&userEmail=user-a@example.com&sessionId=${sessionId}`;

const ws1 = new WebSocket(wsUrl);
ws1.onmessage = (e) => console.log('User A received:', JSON.parse(e.data));
```

**Browser 2 (User B):**
```javascript
const submissionId = '825b0eda-75d0-4840-9dfb-267f6e121af7';
const sessionId = localStorage.getItem('sessionId');
const wsUrl = `wss://scrivenly.com/api/ws/submissions/${submissionId}?submissionId=${submissionId}&userId=user-b@example.com&userName=User+B&userEmail=user-b@example.com&sessionId=${sessionId}`;

const ws2 = new WebSocket(wsUrl);
ws2.onmessage = (e) => console.log('User B received:', JSON.parse(e.data));
```

## 🎯 Testing Scenarios

### Scenario 1: User Presence
1. User A opens submission
2. User B opens same submission  
3. **Expected**: Both users see each other in "Connected Users"

### Scenario 2: Editing Notifications
1. User A clicks "Edit Content"
2. **Expected**: User B sees "User A started editing" notification
3. User A makes changes and saves
4. **Expected**: User B sees "User A updated the content" notification

### Scenario 3: Comments
1. User A adds a comment
2. **Expected**: User B sees "User A added a comment" notification in real-time

### Scenario 4: Approvals
1. User A (with approval permissions) approves submission
2. **Expected**: User B sees "User A added an approval" notification

## 🔧 Common Issues & Solutions

### Issue: Seeing Same User Twice
**Possible Causes:**
1. Same session being used (same browser, different tabs)
2. User ID collision (both users have same effective ID)
3. Room logic bug

**Debug:**
```javascript
// Check if users have different IDs
console.log('Effective User ID:', currentUser.id || currentUser.email);
```

### Issue: Users Not Seeing Each Other
**Possible Causes:**
1. Different submission IDs
2. Session authentication issues
3. Durable Object not properly routing

**Debug:**
```javascript
// Verify same submission ID
console.log('Submission ID:', window.location.pathname.split('/').pop());

// Check WebSocket URL
console.log('WebSocket URL being used:', wsUrl);
```

### Issue: No Real-time Updates
**Possible Causes:**
1. WebSocket connection dropped
2. Event handlers not properly set up
3. Backend broadcasting not working

**Debug:**
```javascript
// Check connection status
console.log('WebSocket status:', ws.readyState);
// 0: CONNECTING, 1: OPEN, 2: CLOSING, 3: CLOSED
```

## 🚀 Quick Test Commands

### Test Infrastructure
```bash
# Test WebSocket endpoint
curl https://scrivenly.com/api/ws/test

# Check logs
wrangler tail
```

### Test User Access
```bash
# Test if both users can access the submission
curl "https://scrivenly.com/api/content/submissions/825b0eda-75d0-4840-9dfb-267f6e121af7" \
  -H "Authorization: Bearer USER_A_SESSION"

curl "https://scrivenly.com/api/content/submissions/825b0eda-75d0-4840-9dfb-267f6e121af7" \
  -H "Authorization: Bearer USER_B_SESSION"
```

## 📝 Test Results Template

Document your test results:

```
Date: ___________
Submission ID: 825b0eda-75d0-4840-9dfb-267f6e121af7

User A:
- Browser: ___________
- Email: ___________
- Session ID (last 8 chars): ___________
- Can access submission: Y/N
- WebSocket connects: Y/N

User B:
- Browser: ___________  
- Email: ___________
- Session ID (last 8 chars): ___________
- Can access submission: Y/N
- WebSocket connects: Y/N

Results:
- Users see each other: Y/N
- Real-time notifications work: Y/N
- Editing indicators work: Y/N

Console Logs:
[Paste relevant console output here]
```

## 🎯 Next Steps

After testing, if you still see issues:

1. **Share console logs** from both browsers
2. **Check wrangler tail** output during testing  
3. **Verify user details** are different between sessions
4. **Test with the manual WebSocket commands** above

The enhanced debugging should show exactly what's happening with user identification and room management! 