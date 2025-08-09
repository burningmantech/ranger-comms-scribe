import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TrackedChangesEditor } from './TrackedChangesEditor';
import { ContentSubmission, User, Comment, UserRole } from '../types/content';

// Mock the dependencies
jest.mock('./CollaborativeEditor', () => {
  return function MockCollaborativeEditor({ onContentChange, onSave }: any) {
    return (
      <div data-testid="collaborative-editor">
        <button onClick={() => onContentChange('test content', { x: 0, y: 0 })}>
          Change Content
        </button>
        <button onClick={() => onSave('saved content')}>
          Save
        </button>
      </div>
    );
  };
});

jest.mock('./editor/LexicalEditor', () => {
  return function MockLexicalEditor() {
    return <div data-testid="lexical-editor">Lexical Editor</div>;
  };
});

// Mock window resize
const mockResizeWindow = (width: number) => {
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event('resize'));
};

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
    onUndo: jest.fn(),
    onApproveProposedVersion: jest.fn(),
    onRejectProposedVersion: jest.fn(),
    onRefreshNeeded: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset window size to desktop
    mockResizeWindow(1200);
  });

  describe('Desktop Layout', () => {
    it('should show desktop sidebar on large screens', () => {
      mockResizeWindow(1200);
      render(<TrackedChangesEditor {...mockProps} />);
      
      // Desktop sidebar should be visible
      expect(screen.getByText('Changes & Comments')).toBeInTheDocument();
      expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument();
    });

    it('should auto-collapse sidebar when editor space is limited', async () => {
      // Mock a narrow container width
      mockResizeWindow(800);
      
      render(<TrackedChangesEditor {...mockProps} />);
      
      // Wait for resize handler to process
      await waitFor(() => {
        expect(screen.getByTitle('Expand sidebar')).toBeInTheDocument();
      });
    });

    it('should allow manual toggle of sidebar', () => {
      mockResizeWindow(1200);
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
      mockResizeWindow(768);
      render(<TrackedChangesEditor {...mockProps} />);
      
      // Desktop sidebar should be hidden
      expect(screen.queryByTitle('Collapse sidebar')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Expand sidebar')).not.toBeInTheDocument();
    });

    it('should show mobile sidebar section on small screens', () => {
      mockResizeWindow(768);
      render(<TrackedChangesEditor {...mockProps} />);
      
      // Mobile sidebar section should be visible
      expect(screen.getByText('Changes & Comments')).toBeInTheDocument();
      expect(screen.getByTitle('Expand changes')).toBeInTheDocument();
    });

    it('should allow toggle of mobile sidebar section', () => {
      mockResizeWindow(768);
      render(<TrackedChangesEditor {...mockProps} />);
      
      const toggleButton = screen.getByTitle('Expand changes');
      fireEvent.click(toggleButton);
      
      expect(screen.getByTitle('Collapse changes')).toBeInTheDocument();
      
      fireEvent.click(screen.getByTitle('Collapse changes'));
      expect(screen.getByTitle('Expand changes')).toBeInTheDocument();
    });

    it('should show changes list when mobile sidebar is expanded', () => {
      mockResizeWindow(768);
      render(<TrackedChangesEditor {...mockProps} />);
      
      const toggleButton = screen.getByTitle('Expand changes');
      fireEvent.click(toggleButton);
      
      // Should show the change item
      expect(screen.getByText('test-user')).toBeInTheDocument();
      expect(screen.getByText('Incremental Change')).toBeInTheDocument();
    });
  });

  describe('Responsive Behavior', () => {
    it('should switch between desktop and mobile layouts on resize', async () => {
      // Start with desktop
      mockResizeWindow(1200);
      const { rerender } = render(<TrackedChangesEditor {...mockProps} />);
      
      expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument();
      
      // Switch to mobile
      mockResizeWindow(768);
      rerender(<TrackedChangesEditor {...mockProps} />);
      
      await waitFor(() => {
        expect(screen.queryByTitle('Collapse sidebar')).not.toBeInTheDocument();
        expect(screen.getByTitle('Expand changes')).toBeInTheDocument();
      });
      
      // Switch back to desktop
      mockResizeWindow(1200);
      rerender(<TrackedChangesEditor {...mockProps} />);
      
      await waitFor(() => {
        expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument();
        expect(screen.queryByTitle('Expand changes')).not.toBeInTheDocument();
      });
    });
  });

  describe('Sidebar Content', () => {
    it('should display tracked changes in sidebar', () => {
      mockResizeWindow(1200);
      render(<TrackedChangesEditor {...mockProps} />);
      
      expect(screen.getByText('test-user')).toBeInTheDocument();
      expect(screen.getByText('Incremental Change')).toBeInTheDocument();
      expect(screen.getByText(/Removed:/)).toBeInTheDocument();
      expect(screen.getByText(/Added:/)).toBeInTheDocument();
    });

    it('should show action buttons for changes', () => {
      mockResizeWindow(1200);
      render(<TrackedChangesEditor {...mockProps} />);
      
      expect(screen.getByTitle('Approve this change')).toBeInTheDocument();
      expect(screen.getByTitle('Reject this change')).toBeInTheDocument();
      expect(screen.getByTitle('Add comment')).toBeInTheDocument();
    });
  });
}); 