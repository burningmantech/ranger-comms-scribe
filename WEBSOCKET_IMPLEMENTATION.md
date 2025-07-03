# WebSocket Implementation for Real-time Collaboration

This document describes the WebSocket implementation for real-time collaboration on content submissions using Cloudflare's Durable Objects with hibernation support.

## Architecture Overview

The WebSocket system consists of:

1. **Backend WebSocket Durable Object** (`backend/src/services/websocketService.ts`)
   - Manages WebSocket connections with hibernation support
   - Organizes users into submission-specific rooms
   - Handles real-time message broadcasting

2. **Backend WebSocket Handler** (`backend/src/handlers/websocket.ts`)
   - Routes WebSocket connections to appropriate Durable Objects
   - Handles authentication and user validation
   - Provides HTTP APIs for broadcasting messages

3. **Frontend WebSocket Service** (`frontend/src/services/websocketService.ts`)
   - Manages WebSocket connections from the browser
   - Handles automatic reconnection
   - Provides event-based API for real-time updates

4. **Frontend Collaboration Component** (`frontend/src/components/SubmissionCollaborators.tsx`)
   - Displays connected users and real-time activity
   - Shows editing indicators and notifications
   - Integrates with the content submission form

## Features

### Real-time Collaboration
- **User Presence**: See who is currently viewing each submission
- **Editing Indicators**: Know when someone is actively editing
- **Live Updates**: Receive notifications when content is updated
- **Comment Broadcasting**: See new comments in real-time
- **Approval Notifications**: Get notified when approvals are added
- **Status Changes**: Stay informed about submission status updates

### WebSocket Hibernation
- Uses Cloudflare's hibernation API to reduce resource usage
- Maintains persistent connections efficiently
- Automatically handles connection lifecycle

### Robust Connection Management
- Automatic reconnection with exponential backoff
- Graceful handling of connection errors
- Clean disconnection on navigation/page close

## Configuration

### Backend Configuration (wrangler.toml)
```toml
[[durable_objects.bindings]]
name = "SUBMISSION_WEBSOCKET"
class_name = "SubmissionWebSocketServer"

[[migrations]]
tag = "v1"
new_classes = ["SubmissionWebSocketServer"]
```

### Frontend Configuration
The WebSocket URL is automatically derived from the API URL in `config.ts`.

## Usage

### Backend Broadcasting
When submissions are updated, the backend automatically broadcasts messages:

```typescript
import { broadcastToSubmissionRoom } from './websocket';

// Broadcast content update
await broadcastToSubmissionRoom(submissionId, {
  type: 'content_updated',
  userId: user.id,
  userName: user.name,
  userEmail: user.email,
  data: { title: submission.title, status: submission.status }
}, env);
```

### Frontend Integration
The `SubmissionCollaborators` component is integrated into the `ContentSubmission` component:

```tsx
<SubmissionCollaborators
  ref={collaboratorsRef}
  submissionId={submission.id}
  currentUser={currentUser}
  onWebSocketMessage={handleWebSocketMessage}
/>
```

## Message Types

The WebSocket system supports the following message types:

- `user_joined`: When a user joins a submission room
- `user_left`: When a user leaves a submission room
- `editing_started`: When a user starts editing
- `editing_stopped`: When a user stops editing
- `content_updated`: When submission content is updated
- `comment_added`: When a new comment is added
- `approval_added`: When a new approval is added
- `status_changed`: When submission status changes
- `error`: When an error occurs

## API Endpoints

### WebSocket Connection
- `GET /ws/submissions/:submissionId` - Establish WebSocket connection
- Authentication required via session token

### HTTP Broadcasting
- `POST /ws/submissions/:submissionId/broadcast` - Send message to room
- `GET /ws/submissions/:submissionId/room` - Get room information

## Development

### Testing WebSocket Connections
1. Open browser developer tools
2. Navigate to a submission page
3. Check Network tab for WebSocket connections
4. Monitor Console for connection logs

### Debugging
- WebSocket connections are logged to browser console
- Backend logs show Durable Object activity
- Connection status is displayed in the UI

## Deployment

### Development
```bash
cd backend
wrangler dev
```

### Production
```bash
cd backend
wrangler publish
```

The Durable Objects are automatically deployed with the worker.

## Error Handling

- Connection failures trigger automatic reconnection
- Invalid sessions are rejected with 403 status
- Missing parameters return 400 status
- WebSocket errors are displayed in the UI

## Security

- All WebSocket connections require valid session authentication
- Users can only join rooms for submissions they have access to
- Message broadcasting respects user permissions

## Performance

- WebSocket hibernation reduces memory usage
- Connection pooling minimizes resource consumption
- Automatic cleanup of inactive connections
- Efficient message broadcasting to room members

## Future Enhancements

- Cursor position sharing for real-time editing
- Conflict resolution for simultaneous edits
- File sharing during collaboration
- Voice/video integration for remote sessions
- Enhanced notifications and alerts 