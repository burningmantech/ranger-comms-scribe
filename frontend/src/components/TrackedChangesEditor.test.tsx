import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TrackedChangesEditor } from './TrackedChangesEditor';
import { ContentSubmission, User, Comment, UserRole } from '../types/content';

// Mock the dependencies
jest.mock('./CollaborativeEditor', () => {
  // TrackedChangesEditor imports the named export
  const MockCollaborativeEditor = ({ onContentChange, onSave }: any) => (
    <div data-testid="collaborative-editor">
      <button onClick={() => onContentChange('test content', { x: 0, y: 0 })}>
        Change Content
      </button>
      <button onClick={() => onSave('saved content')}>
        Save
      </button>
    </div>
  );
  return { __esModule: true, CollaborativeEditor: MockCollaborativeEditor, default: MockCollaborativeEditor };
});

jest.mock('./editor/LexicalEditor', () => {
  return function MockLexicalEditor() {
    return <div data-testid="lexical-editor">Lexical Editor</div>;
  };
});

jest.mock('./SaveIndicator', () => {
  return function MockSaveIndicator() {
    return <span data-testid="save-indicator">saved</span>;
  };
});

jest.mock('./editor/plugins/TrackedChangesPlugin', () => ({
  __esModule: true,
  default: () => null,
  removeDecorationsForChange: jest.fn(),
  addDecorationsForChange: jest.fn(),
}));

// Set the window width; with `dispatch`, also fire a resize (the component listens only after mount)
const mockResizeWindow = (width: number, dispatch = true) => {
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: width,
  });
  if (dispatch) window.dispatchEvent(new Event('resize'));
};

// jsdom has no layout, so offsetWidth is 0 everywhere. The sidebar's auto-collapse measures the
// editor container (.editor-content), so give it a width.
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const mockEditorWidth = (width: number) => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('editor-content') ? width : 0;
    },
  });
};

// The resize handler is debounced (300 ms)
const RESIZE_WAIT = { timeout: 2000 };

describe('TrackedChangesEditor - Collapsible Sidebar', () => {
  const mockSubmission: ContentSubmission = {
    id: 'test-submission',
    title: 'Test Submission',
    content: 'Original content',
    richTextContent: 'Original rich text content',
    submittedBy: 'test-user',
    submittedAt: new Date(),
    status: 'submitted',
    formFields: [],
    proposedVersions: {
      richTextContent: 'Proposed content',
      timestamp: new Date().toISOString(),
      submittedBy: 'test-user'
    },
    approvals: [],
    changes: [
      {
        id: 'change-1',
        field: 'content',
        oldValue: 'old text',
        newValue: 'new text',
        changedBy: 'test-user',
        timestamp: new Date(),
        isIncremental: true,
        status: 'pending'
      }
    ],
    comments: [],
    assignedReviewers: [],
    assignedCouncilManagers: [],
    suggestedEdits: [],
    requiredApprovers: []
  };

  const mockUser: User = {
    id: 'test-user',
    email: 'test@example.com',
    name: 'Test User',
    roles: ['REVIEWER' as UserRole]
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
    // Reset window size to desktop, with a roomy editor
    mockResizeWindow(1200, false);
    mockEditorWidth(1400);
  });

  afterEach(() => {
    if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  });

  describe('Desktop Layout', () => {
    it('should show desktop sidebar on large screens', () => {
      render(<TrackedChangesEditor {...mockProps} />);

      // The desktop sidebar is the review panel (Open / History tabs) with a collapse button
      expect(screen.getByRole('tab', { name: /Open/ })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /History/ })).toBeInTheDocument();
      expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument();
      // The mobile section is not rendered
      expect(screen.queryByText('Changes & Comments')).not.toBeInTheDocument();
    });

    it('should auto-collapse sidebar when editor space is limited', async () => {
      // Starts expanded even when narrow: there is no auto-collapse on first render
      mockEditorWidth(800);
      render(<TrackedChangesEditor {...mockProps} />);
      expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument();

      // A resize that leaves the editor under 600px beside the sidebar collapses it
      mockResizeWindow(900);
      await waitFor(() => {
        expect(screen.getByTitle('Expand sidebar')).toBeInTheDocument();
      }, RESIZE_WAIT);
    });

    it('should allow manual toggle of sidebar', () => {
      render(<TrackedChangesEditor {...mockProps} />);

      const toggleButton = screen.getByTitle('Collapse sidebar');
      fireEvent.click(toggleButton);

      expect(screen.getByTitle('Expand sidebar')).toBeInTheDocument();

      fireEvent.click(screen.getByTitle('Expand sidebar'));
      expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument();
    });
  });

  describe('Mobile Layout', () => {
    it('should hide desktop sidebar on mobile screens', () => {
      mockResizeWindow(768, false);
      render(<TrackedChangesEditor {...mockProps} />);

      // Desktop sidebar should be hidden
      expect(screen.queryByTitle('Collapse sidebar')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Expand sidebar')).not.toBeInTheDocument();
    });

    it('should show mobile sidebar section on small screens, expanded at first', () => {
      mockResizeWindow(768, false);
      render(<TrackedChangesEditor {...mockProps} />);

      // Mobile section below the content, open by default
      expect(screen.getByText('Changes & Comments')).toBeInTheDocument();
      expect(screen.getByTitle('Collapse changes')).toBeInTheDocument();
    });

    it('should allow toggle of mobile sidebar section', () => {
      mockResizeWindow(768, false);
      render(<TrackedChangesEditor {...mockProps} />);

      fireEvent.click(screen.getByTitle('Collapse changes'));
      expect(screen.getByTitle('Expand changes')).toBeInTheDocument();

      fireEvent.click(screen.getByTitle('Expand changes'));
      expect(screen.getByTitle('Collapse changes')).toBeInTheDocument();
    });

    it('should show changes list when mobile sidebar is expanded', () => {
      mockResizeWindow(768, false);
      const { container } = render(<TrackedChangesEditor {...mockProps} />);
      const section = container.querySelector('.mobile-sidebar-section') as HTMLElement;

      // Expanded: the change card is in the mobile section
      expect(within(section).getAllByText('test-user').length).toBeGreaterThan(0);
      expect(within(section).getByText('Replaced')).toBeInTheDocument();

      // Collapsed: the list is hidden
      fireEvent.click(screen.getByTitle('Collapse changes'));
      expect(within(section).queryByText('Replaced')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTitle('Expand changes'));
      expect(within(section).getByText('Replaced')).toBeInTheDocument();
    });
  });

  describe('Responsive Behavior', () => {
    it('should switch between desktop and mobile layouts on resize', async () => {
      // Start with desktop
      render(<TrackedChangesEditor {...mockProps} />);

      expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument();

      // Switch to mobile: the mobile section replaces the sidebar, still expanded
      mockResizeWindow(768);

      await waitFor(() => {
        expect(screen.queryByTitle('Collapse sidebar')).not.toBeInTheDocument();
        expect(screen.getByTitle('Collapse changes')).toBeInTheDocument();
      }, RESIZE_WAIT);

      // Switch back to desktop (the editor has room, so the sidebar stays open)
      mockResizeWindow(1200);

      await waitFor(() => {
        expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument();
        expect(screen.queryByTitle('Collapse changes')).not.toBeInTheDocument();
        expect(screen.queryByTitle('Expand changes')).not.toBeInTheDocument();
      }, RESIZE_WAIT);
    });
  });

  describe('Sidebar Content', () => {
    it('should display tracked changes in sidebar, in plain language', () => {
      mockResizeWindow(1200);
      render(<TrackedChangesEditor {...mockProps} />);

      expect(screen.getAllByText('test-user').length).toBeGreaterThan(0);
      expect(screen.queryByText(/Incremental Change/i)).not.toBeInTheDocument();
      expect(screen.getByText('Replaced')).toBeInTheDocument();
      expect(screen.getByText('old')).toBeInTheDocument();
      expect(screen.getByText('new')).toBeInTheDocument();
    });

    it('should show action buttons for changes', () => {
      mockResizeWindow(1200);
      render(<TrackedChangesEditor {...mockProps} />);

      expect(screen.getByTitle('Accept')).toBeInTheDocument();
      expect(screen.getByTitle('Reject')).toBeInTheDocument();
      expect(screen.getByTitle('Add comment')).toBeInTheDocument();
      // No per-card checkboxes or "Select all"
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(screen.queryByText(/Select all/i)).not.toBeInTheDocument();
    });

    it('shows only pending changes; resolved ones are in History with who decided', () => {
      mockResizeWindow(1200);
      const lexical = (text: string) => JSON.stringify({ root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text }] }] } });
      const submission = {
        ...mockSubmission,
        changes: [
          {
            id: 'change-2', field: 'content', oldValue: 'a b', newValue: 'a big b', changedBy: 'test-user', timestamp: new Date(),
            status: 'rejected' as const, rejectedBy: 'helpdesk@x', rejectedByName: 'HelpDesk', rejectedAt: new Date(),
            richTextOldValue: lexical('a b'), richTextNewValue: lexical('a big b'),
          },
        ],
      };
      render(<TrackedChangesEditor {...mockProps} submission={submission} />);

      expect(screen.getByText('All caught up')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: /History/ }));
      expect(screen.getByText(/Rejected by/)).toBeInTheDocument();
      expect(screen.getByText('HelpDesk')).toBeInTheDocument();
      expect(screen.getByText('big')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Undo/ })).toBeInTheDocument();
    });

    it('puts Accept all / Reject all in the menu', () => {
      mockResizeWindow(1200);
      render(<TrackedChangesEditor {...mockProps} />);

      expect(screen.queryByText('Accept all')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTitle('More actions'));
      expect(screen.getByText('Accept all')).toBeInTheDocument();
      expect(screen.getByText('Reject all')).toBeInTheDocument();
      expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument();
    });
  });
});
