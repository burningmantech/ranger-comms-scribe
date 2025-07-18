# Comms Scribe - Frontend

Welcome to the Comms Scribe frontend! This project is built with TypeScript and React, providing a collaborative content management platform for the Comms Scribe application.

## Project Structure

- **src/**: Contains the source code for the frontend application.
  - **components/**: Contains React components for the application.
    - **Admin.tsx**: Comprehensive administrative interface with user management, group management, bulk user operations, role assignments, and email functionality
    - **CollaborativeEditor.tsx**: Advanced real-time collaborative rich text editor with cursor tracking, operational transforms, and WebSocket integration
    - **CommsRequest.tsx**: Communication request form with rich text editing, approver selection, and council manager integration
    - **ContentSubmission.tsx**: Content submission and review system with collaborative editing capabilities
    - **Login.tsx**: User authentication with Google OAuth integration and session management
    - **Navbar.tsx**: Navigation component with role-based menu items
    - **RoleManagement.tsx**: User role and permission management interface
    - **TrackedChangesEditor.tsx**: Advanced editor for reviewing, accepting, and rejecting tracked changes with diff visualization
    - **UserPresence.tsx**: Real-time user presence indicators with cursor tracking and activity status
    - **UserSettings.tsx**: User profile and settings management with password reset functionality
    - **ApprovalReminders.tsx**: System for sending approval reminders to users
    - **CouncilManagerManagement.tsx**: Interface for managing council manager roles and permissions
    - **CommsCadreManagement.tsx**: Interface for managing communications cadre members
    - **editor/**: Lexical-based rich text editor components and plugins
      - **LexicalEditor.tsx**: Core Lexical editor component
      - **plugins/**: Rich text editing plugins (tables, images, formatting, etc.)
      - **nodes/**: Custom Lexical nodes (images, checkboxes, suggestions)
      - **utils/**: Editor utility functions
    - **styles/**: Component-specific CSS files
  - **pages/**: Page-level components
    - **ContentManagement.tsx**: Content management interface for administrators
    - **MySubmissions.tsx**: User's content submissions view with status tracking
    - **TrackedChangesView.tsx**: Comprehensive tracked changes review interface with diff visualization
  - **services/**: API and service layer
    - **trackedChangesService.ts**: Tracked changes API integration with diff algorithms
    - **websocketService.ts**: Real-time WebSocket communication for collaborative editing and presence
  - **types/**: TypeScript type definitions
    - **content.ts**: Content-related type definitions including submissions, forms, and user roles
    - **index.ts**: Core application types for users, sessions, and authentication
  - **utils/**: Utility functions and helpers
    - **diffAlgorithm.ts**: Text diffing algorithms for change tracking
    - **googleAuth.ts**: Google authentication utilities and OAuth integration
    - **lexicalUtils.ts**: Lexical editor utilities for content manipulation
    - **operationalTransforms.ts**: Operational transformation functions for conflict resolution
    - **userActions.ts**: User action utilities and session management
    - **logger.ts**: Logging utilities for debugging
  - **contexts/**: React context providers
    - **ContentContext.tsx**: Global content state management for submissions and user data
  - **examples/**: Example and test components
    - **SuggestedEditsExample.tsx**: Example implementation of suggested edits
  - **App.tsx**: Main application component with routing and authentication guards
  - **index.tsx**: Entry point of the application

- **public/**: Contains static files for the frontend application.
  - **index.html**: Main HTML file where the React app is mounted
  - **test-login.html**: Login testing page
  - **websocket-test.html**: WebSocket testing page

## Getting Started

To get started with the frontend development, follow these steps:

1. **Clone the repository**:
   ```
   git clone https://github.com/your-repo/comms-scribe-website.git
   cd comms-scribe-website/frontend
   ```

2. **Install dependencies**:
   ```
   npm install
   ```

3. **Run the development server**:
   ```
   npm start
   ```

4. **For local backend development**:
   ```
   npm run start:local-backend
   ```

5. **Open your browser** and navigate to `http://localhost:3000` to see the application in action.

## Features

- **Collaborative Editing**: Real-time collaborative rich text editing with Lexical, featuring cursor tracking, operational transforms, and conflict resolution
- **Content Management**: Comprehensive content submission, review, and approval system with role-based workflows
- **Tracked Changes**: Advanced change tracking and review capabilities with diff visualization and acceptance/rejection workflows
- **User Management**: Role-based access control with admin interface for user management, group management, and bulk operations
- **Real-time Communication**: WebSocket-based real-time updates, user presence indicators, and live collaboration features
- **Authentication**: Google OAuth integration for secure user login with session management
- **Responsive Design**: Modern, responsive UI built with React Bootstrap and custom CSS
- **Rich Text Editor**: Feature-rich Lexical editor with tables, images, formatting, checkboxes, and custom plugins
- **Council Management**: Specialized interfaces for managing council managers and communications cadre members
- **Approval Workflows**: Automated approval processes with reminder systems and status tracking
- **Form Validation**: Comprehensive form validation using Zod schemas and React Hook Form
- **Email Integration**: Built-in email functionality for notifications and group communications

## Technology Stack

- **React 18** with TypeScript for type-safe development
- **Lexical** rich text editor framework with custom plugins and nodes
- **React Router** for client-side navigation and route protection
- **React Bootstrap** for responsive UI components and styling
- **WebSocket** for real-time communication and collaborative editing
- **Google OAuth** for secure authentication and user management
- **Operational Transforms** for conflict resolution in collaborative editing
- **Zod** for schema validation and type safety
- **React Hook Form** for form management and validation
- **Draft.js** for content import/export capabilities
- **Yjs** for operational transformation algorithms

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for any enhancements or bug fixes.

