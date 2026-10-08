import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TrackedChangesEditor } from '../components/TrackedChangesEditor';
import { ContentSubmission, User } from '../types/content';

// Mock the CollaborativeEditor component
jest.mock('../components/CollaborativeEditor', () => {
  // jest.mock factories are hoisted above the imports, so they can't use the imported React
  const mockReact = require('react');
  return {
    CollaborativeEditor: ({ onContentChange, onSave, onWebSocketClientReady }: any) => {
      mockReact.useEffect(() => {
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

// Mock SaveIndicator
jest.mock('../components/SaveIndicator', () => {
  return {
    __esModule: true,
    default: () => <span data-testid="save-indicator">saved</span>
  };
});

// Mock TrackedChangesPlugin exports
jest.mock('../components/editor/plugins/TrackedChangesPlugin', () => ({
  __esModule: true,
  default: () => null,
  removeDecorationsForChange: jest.fn(),
  addDecorationsForChange: jest.fn(),
}));

// Mock window.innerWidth for responsive testing
const mockWindowWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: width,
  });
};

// jsdom has no layout (offsetWidth is 0); the auto-collapse measures the editor container
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const mockEditorWidth = (width: number) => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('editor-content') ? width : 0;
    },
  });
};

// Resize after mount (the component only listens once mounted); the handler is debounced 300 ms
const resizeTo = (windowWidth: number, editorWidth: number) => {
  mockWindowWidth(windowWidth);
  mockEditorWidth(editorWidth);
  window.dispatchEvent(new Event('resize'));
};
const RESIZE_WAIT = { timeout: 2000 };

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
    onApproveProposedVersion: jest.fn(),
    onRejectProposedVersion: jest.fn(),
    onRefreshNeeded: jest.fn()
  };

  beforeAll(() => {
    // jsdom doesn't implement scrollIntoView (expanding the mobile section scrolls to it)
    Element.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset window width to desktop size, with a roomy editor
    mockWindowWidth(1200);
    mockEditorWidth(1400);
  });

  afterEach(() => {
    if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  });

  test('renders sidebar with toggle button', () => {
    render(<TrackedChangesEditor {...mockProps} />);

    // The sidebar is the review panel: Open / History tabs, with the collapse button in its header
    expect(screen.getByRole('tab', { name: /Open/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /History/ })).toBeInTheDocument();
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

    // The review panel is gone; the badge counts the open edits
    expect(screen.queryByRole('tab', { name: /Open/ })).not.toBeInTheDocument();
    expect(screen.getByTitle('1 pending')).toHaveTextContent('1');
  });

  test('auto-collapses the sidebar when the window narrows, and expands it when there is room again', async () => {
    render(<TrackedChangesEditor {...mockProps} />);
    expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument();

    // Editor under 600px beside the sidebar
    resizeTo(1000, 800);
    await waitFor(() => expect(screen.getByTitle('Expand sidebar')).toBeInTheDocument(), RESIZE_WAIT);

    // Room again: an auto-collapsed sidebar opens by itself (after the 500 ms anti-bounce interval)
    await new Promise((resolve) => setTimeout(resolve, 600));
    resizeTo(1600, 1400);
    await waitFor(() => expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument(), RESIZE_WAIT);
  });

  test('on mobile, the sidebar is a collapsible section below the content', () => {
    mockWindowWidth(600); // Mobile width
    render(<TrackedChangesEditor {...mockProps} />);

    // No desktop sidebar toggle; the section starts open
    expect(screen.queryByTitle('Collapse sidebar')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Expand sidebar')).not.toBeInTheDocument();
    expect(screen.getByText('Changes & Comments')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Collapse changes'));
    expect(screen.getByTitle('Expand changes')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Open/ })).not.toBeInTheDocument();
  });

  test('does not show the mobile section toggle on desktop', () => {
    mockWindowWidth(1200); // Desktop width
    render(<TrackedChangesEditor {...mockProps} />);

    expect(screen.queryByText('Changes & Comments')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Expand changes')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Collapse changes')).not.toBeInTheDocument();
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

    const badge = screen.getByTitle('1 pending');
    expect(badge).toHaveTextContent('1');
    expect(badge).toHaveClass('has-pending');
  });
});
