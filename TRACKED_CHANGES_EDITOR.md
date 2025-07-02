# Tracked Changes Editor

A Google Docs-style tracked changes editor for communications requests that allows collaborative editing with change tracking, approval workflows, and commenting.

## Features

### Core Functionality
- **Real-time change tracking**: All edits are tracked with author, timestamp, and content changes
- **Inline change visualization**: Changes are displayed with color-coded additions and deletions
- **Multi-level approval workflow**: Changes can be approved or rejected by authorized users
- **Commenting system**: Users can comment on specific changes for discussion
- **Version comparison**: Toggle between original and edited versions
- **Edit mode**: Direct editing with automatic change tracking

### User Permissions
The following users can make editorial decisions (approve/reject changes):
- Communications Cadre members
- Council Managers
- Reviewers
- Original requester

### Visual Design
- Modern, clean interface inspired by Google Docs
- Color-coded changes:
  - **Green**: Approved additions
  - **Red**: Deletions or rejections
  - **Yellow**: Pending changes
- Sidebar for change management and comments
- Responsive design for mobile and desktop

## Technical Implementation

### Frontend Components

#### TrackedChangesEditor Component
Main editor component located at `frontend/src/components/TrackedChangesEditor.tsx`

**Props:**
```typescript
interface TrackedChangesEditorProps {
  submission: ContentSubmission;
  currentUser: User;
  onSave: (submission: ContentSubmission) => void;
  onComment: (comment: Comment) => void;
  onApprove: (changeId: string) => void;
  onReject: (changeId: string) => void;
  onSuggestion: (suggestion: Change) => void;
}
```

**Key Features:**
- Text selection for suggestions
- Real-time diff visualization
- Edit mode with textarea
- Comment dialogs
- Change approval/rejection interface

#### Diff Algorithm
Located at `frontend/src/utils/diffAlgorithm.ts`

Implements Myers' diff algorithm with enhancements for:
- Word-level diffs
- Line-level diffs
- Character-level diffs
- Smart diff selection based on text size

### Backend API

#### Endpoints
All endpoints require authentication via session token.

- `GET /tracked-changes/submission/:submissionId` - Get all changes for a submission
- `POST /tracked-changes/submission/:submissionId` - Create a new change/suggestion
- `PUT /tracked-changes/change/:changeId/status` - Approve or reject a change
- `POST /tracked-changes/change/:changeId/comment` - Add comment to a change
- `GET /tracked-changes/history` - Get change history with analytics

#### Database Schema

**tracked_changes table:**
```sql
CREATE TABLE tracked_changes (
  id TEXT PRIMARY KEY,
  submissionId TEXT NOT NULL,
  field TEXT NOT NULL,
  oldValue TEXT NOT NULL,
  newValue TEXT NOT NULL,
  changedBy TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  approvedBy TEXT,
  approvedAt TEXT,
  rejectedBy TEXT,
  rejectedAt TEXT
);
```

**change_comments table:**
```sql
CREATE TABLE change_comments (
  id TEXT PRIMARY KEY,
  changeId TEXT NOT NULL,
  submissionId TEXT NOT NULL,
  content TEXT NOT NULL,
  authorId TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
```

### Services

#### TrackedChangesService
Located at `frontend/src/services/trackedChangesService.ts`

Provides methods for:
- Fetching tracked changes
- Creating new changes
- Updating change status
- Adding comments
- Getting change history with statistics

## Usage Example

```typescript
import { TrackedChangesEditor } from './components/TrackedChangesEditor';

function MyComponent() {
  const submission = {
    id: 'submission-1',
    title: 'Communications Request',
    content: 'Original content...',
    // ... other fields
  };

  const currentUser = {
    id: 'user-1',
    name: 'John Doe',
    roles: ['COMMS_CADRE']
  };

  return (
    <TrackedChangesEditor
      submission={submission}
      currentUser={currentUser}
      onSave={handleSave}
      onComment={handleComment}
      onApprove={handleApprove}
      onReject={handleReject}
      onSuggestion={handleSuggestion}
    />
  );
}
```

## Styling

The component uses a comprehensive CSS file (`TrackedChangesEditor.css`) with:
- Google Docs-inspired design
- Responsive layouts
- Smooth animations
- Accessibility considerations

## Future Enhancements

1. **Real-time collaboration**: WebSocket support for live updates
2. **Conflict resolution**: Handle simultaneous edits
3. **Advanced permissions**: More granular control over who can edit what
4. **Export functionality**: Export documents with tracked changes
5. **Revision history**: Complete timeline of all changes
6. **Keyboard shortcuts**: Improve efficiency for power users
7. **Rich text support**: Integration with existing Lexical editor
8. **Batch operations**: Approve/reject multiple changes at once

## Integration

To integrate the tracked changes editor into your application:

1. Ensure the backend migration has been run to create necessary tables
2. Import the component and required types
3. Implement the callback handlers for save, comment, approve, reject, and suggestion
4. Style adjustments can be made by modifying `TrackedChangesEditor.css`

## Performance Considerations

- The diff algorithm is optimized for different text sizes
- Changes are loaded on-demand to avoid overwhelming the UI
- Comments are grouped by change to reduce API calls
- The component uses React's useMemo and useCallback for optimization