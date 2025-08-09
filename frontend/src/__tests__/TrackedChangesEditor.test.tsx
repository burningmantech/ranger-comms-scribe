import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrackedChangesEditor } from '../components/TrackedChangesEditor';
import { ContentSubmission, User } from '../types/content';

// Mock the CollaborativeEditor component
jest.mock('../components/CollaborativeEditor', () => {
  return {
    CollaborativeEditor: ({ onContentChange, onSave, onWebSocketClientReady }: any) => {
      React.useEffect(() => {
        // Simulate WebSocket client ready
        if (onWebSocketClientReady) {
          onWebSocketClientReady({
            on: jest.fn(),
            send: jest.fn(),
            applyRealTimeUpdate: jest.fn()
          });
        }
      }, [onWebSocketClientReady]);

      return (
        <div data-testid="collaborative-editor">
          <textarea
            data-testid="editor-textarea"
            onChange={(e) => onContentChange && onContentChange(null, e.target.value)}
            onBlur={(e) => onSave && onSave(e.target.value)}
          />
        </div>
      );
    }
  };
});

// Mock the LexicalEditorComponent
jest.mock('../components/editor/LexicalEditor', () => {
  return {
    __esModule: true,
    default: () => <div data-testid="lexical-editor" />
  };
});

// Mock window.innerWidth for responsive testing
const mockWindowWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: width,
  });
};

describe('TrackedChangesEditor - Collapsible Sidebar', () => {
  const mockSubmission: ContentSubmission = {
    id: 'test-submission',
    title: 'Test Submission',
    content: 'Original content',
    richTextContent: 'Original rich text content',
    submittedBy: 'test@example.com',
    submittedAt: new Date(),
    status: 'submitted',
    formFields: [],
    assignedReviewers: [],
    assignedCouncilManagers: [],
    suggestedEdits: [],
    requiredApprovers: [],
    changes: [
      {
        id: 'change-1',
        field: 'content',
        oldValue: 'old text',
        newValue: 'new text',
        changedBy: 'user1@example.com',
        timestamp: new Date(),
        isIncremental: true
      }
    ],
    comments: [],
    approvals: [],
    proposedVersions: {
      content: 'Proposed content',
      richTextContent: 'Proposed rich text content',
      lastModified: new Date().toISOString(),
      lastModifiedBy: 'user1@example.com'
    }
  };

  const mockUser: User = {
    id: 'user1',
    email: 'user1@example.com',
    name: 'Test User',
    roles: ['CommsCadre']
  };

  const mockProps = {
    submission: mockSubmission,
    currentUser: mockUser,
    onSave: jest.fn(),
    onComment: jest.fn(),
    onApprove: jest.fn(),
    onReject: jest.fn(),
    onSuggestion: jest.fn(),
    onUndo: jest.fn(),
    onApproveProposedVersion: jest.fn(),
    onRejectProposedVersion: jest.fn(),
    onRefreshNeeded: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset window width to desktop size
    mockWindowWidth(1200);
  });

  test('renders sidebar with toggle button', () => {
    render(<TrackedChangesEditor {...mockProps} />);
    
    expect(screen.getByText('Changes & Comments')).toBeInTheDocument();
    expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument();
  });

  test('toggles sidebar collapse state when toggle button is clicked', () => {
    render(<TrackedChangesEditor {...mockProps} />);
    
    const toggleButton = screen.getByTitle('Collapse sidebar');
    fireEvent.click(toggleButton);
    
    expect(screen.getByTitle('Expand sidebar')).toBeInTheDocument();
  });

  test('shows change count badge when sidebar is collapsed on desktop', () => {
    render(<TrackedChangesEditor {...mockProps} />);
    
    const toggleButton = screen.getByTitle('Collapse sidebar');
    fireEvent.click(toggleButton);
    
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('changes')).toBeInTheDocument();
  });

  test('auto-collapses sidebar on small screens', () => {
    mockWindowWidth(600); // Mobile width
    render(<TrackedChangesEditor {...mockProps} />);
    
    // Should show expand button (sidebar is collapsed)
    expect(screen.getByTitle('Expand sidebar')).toBeInTheDocument();
  });

  test('shows floating toggle button on mobile when collapsed', () => {
    mockWindowWidth(600); // Mobile width
    render(<TrackedChangesEditor {...mockProps} />);
    
    // Should show floating toggle button
    expect(screen.getByTitle('Show Changes & Comments')).toBeInTheDocument();
  });

  test('does not show floating toggle button on desktop', () => {
    mockWindowWidth(1200); // Desktop width
    render(<TrackedChangesEditor {...mockProps} />);
    
    // Should not show floating toggle button initially
    expect(screen.queryByTitle('Show Changes & Comments')).not.toBeInTheDocument();
  });

  test('shows pending changes count in badge when there are pending changes', () => {
    const submissionWithPendingChanges = {
      ...mockSubmission,
      changes: [
        {
          id: 'change-1',
          field: 'content',
          oldValue: 'old text',
          newValue: 'new text',
          changedBy: 'user1@example.com',
          timestamp: new Date(),
          isIncremental: true,
          status: 'pending' as const
        }
      ]
    };

    render(<TrackedChangesEditor {...mockProps} submission={submissionWithPendingChanges} />);
    
    const toggleButton = screen.getByTitle('Collapse sidebar');
    fireEvent.click(toggleButton);
    
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });
}); 