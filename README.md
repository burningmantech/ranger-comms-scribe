# Comms Scribe - Collaborative Content Management Platform

Welcome to the Comms Scribe project! This is a sophisticated collaborative content management platform designed to allow Ranger teams to submit new content, and help the Comms Cadre and other reviewers process submissions through an advanced workflow system.

## Project Structure

The project is divided into two main parts: the frontend and the backend.

### Frontend

The frontend is built with TypeScript and React, providing a modern collaborative content management interface. It includes the following key features:

- **Collaborative Editing**: Real-time collaborative rich text editing with Lexical
- **Content Management**: Comprehensive content submission, review, and approval system
- **Tracked Changes**: Advanced change tracking and review capabilities
- **User Management**: Role-based access control with admin interface
- **Real-time Communication**: WebSocket-based real-time updates and user presence

The frontend files are located in the `frontend` directory:

```
frontend/
├── src/
│   ├── components/
│   │   ├── Admin.tsx                 # Comprehensive administrative interface
│   │   ├── CollaborativeEditor.tsx   # Real-time collaborative editor
│   │   ├── CommsRequest.tsx          # Communication request management
│   │   ├── ContentSubmission.tsx     # Content submission system
│   │   ├── Login.tsx                 # Google OAuth authentication
│   │   ├── TrackedChangesEditor.tsx  # Change tracking and review
│   │   ├── UserPresence.tsx          # Real-time user presence
│   │   ├── editor/                   # Lexical editor components
│   │   └── styles/                   # Component-specific CSS
│   ├── pages/
│   │   ├── ContentManagement.tsx     # Content management interface
│   │   ├── MySubmissions.tsx         # User submissions view
│   │   └── TrackedChangesView.tsx    # Tracked changes review
│   ├── services/
│   │   ├── trackedChangesService.ts  # Tracked changes API
│   │   └── websocketService.ts       # Real-time communication
│   ├── types/                        # TypeScript definitions
│   ├── utils/                        # Utility functions
│   ├── contexts/                     # React context providers
│   ├── App.tsx                       # Main application component
│   └── index.tsx                     # Application entry point
├── public/
│   ├── index.html
│   ├── test-login.html
│   └── websocket-test.html
├── package.json
├── tsconfig.json
└── README.md
```

### Backend

The backend is implemented as a Cloudflare Worker using TypeScript, providing a robust API for the collaborative content management system. It handles user authentication, content management, real-time collaboration, and administrative functions.

The backend files are located in the `backend` directory:

```
backend/
├── src/
│   ├── handlers/
│   │   ├── admin.ts                  # Administrative functions
│   │   ├── auth.ts                   # Authentication and session management
│   │   ├── blog.ts                   # Blog post management
│   │   ├── commsCadre.ts             # Communications cadre management
│   │   ├── contentSubmission.ts      # Content submission processing
│   │   ├── councilMembers.ts         # Council member management
│   │   ├── document.ts               # Document management
│   │   ├── gallery.ts                # Media gallery management
│   │   ├── page.ts                   # Page management
│   │   ├── reminders.ts              # Approval reminder system
│   │   ├── trackedChanges.ts         # Change tracking API
│   │   ├── user.ts                   # User management
│   │   ├── userManagement.ts         # Bulk user operations
│   │   └── websocket.ts              # Real-time WebSocket handling
│   ├── services/
│   │   ├── blogService.ts            # Blog service layer
│   │   ├── cacheService.ts           # Caching service
│   │   ├── councilManagerService.ts  # Council manager service
│   │   ├── documentService.ts        # Document service
│   │   ├── galleryCommentService.ts  # Gallery comment service
│   │   ├── mediaService.ts           # Media handling service
│   │   ├── notificationService.ts    # Notification service
│   │   ├── pageService.ts            # Page service
│   │   ├── roleService.ts            # Role management service
│   │   ├── trackedChangesService.ts  # Change tracking service
│   │   ├── userService.ts            # User service
│   │   └── websocketService.ts       # WebSocket service
│   ├── migrations/                   # Database migrations
│   ├── utils/                        # Utility functions
│   ├── authWrappers.ts               # Authentication middleware
│   ├── config.ts                     # Configuration
│   ├── types.ts                      # TypeScript definitions
│   └── index.ts                      # Worker entry point
├── test/                             # Test files
├── wrangler.toml                     # Cloudflare Worker configuration
├── package.json
├── tsconfig.json
└── README.md
```

## Features

### Core Functionality
- **Collaborative Content Editing**: Real-time collaborative rich text editing with operational transforms
- **Content Workflow Management**: Comprehensive submission, review, and approval system
- **Tracked Changes**: Advanced change tracking with diff visualization and acceptance/rejection workflows
- **Role-Based Access Control**: Multi-level user roles (Admin, Council Manager, Comms Cadre, User, Public)
- **Real-time Collaboration**: WebSocket-based real-time updates, user presence, and cursor tracking

### Administrative Features
- **User Management**: Bulk user operations, role assignments, and group management
- **Council Management**: Specialized interfaces for managing council managers and communications cadre
- **Approval Workflows**: Automated approval processes with reminder systems
- **Email Integration**: Built-in email functionality for notifications and communications

### Technical Features
- **Google OAuth Authentication**: Secure user authentication with session management
- **Rich Text Editor**: Feature-rich Lexical editor with tables, images, formatting, and custom plugins
- **Form Validation**: Comprehensive validation using Zod schemas and React Hook Form
- **Responsive Design**: Modern, responsive UI built with React Bootstrap
- **Type Safety**: Full TypeScript implementation for both frontend and backend

## Technology Stack

### Frontend
- **React 18** with TypeScript
- **Lexical** rich text editor framework
- **React Router** for navigation
- **React Bootstrap** for UI components
- **WebSocket** for real-time communication
- **Zod** for schema validation
- **React Hook Form** for form management

### Backend
- **Cloudflare Workers** with TypeScript
- **itty-router** for routing
- **Google Auth Library** for authentication
- **WebSocket** for real-time communication
- **Jest** for testing
- **Wrangler** for deployment

## Deployment

The website is hosted at [scrivenly.com](https://scrivenly.com) and utilizes Cloudflare Workers for the backend functionality. The frontend is deployed as a static site, while the backend runs as a Cloudflare Worker.

## Getting Started

To get started with the project, clone the repository and install the necessary dependencies for both the frontend and backend:

1. **Clone the repository**:
   ```
   git clone <repository-url>
   cd vox-machina
   ```

2. **Install frontend dependencies**:
   ```
   cd frontend
   npm install
   ```

3. **Install backend dependencies**:
   ```
   cd backend
   npm install
   ```

4. **Run the applications locally**:
   ```
   # Terminal 1 - Backend
   cd backend
   npm run dev
   
   # Terminal 2 - Frontend
   cd frontend
   npm run start:local-backend
   ```

5. **Open your browser** and navigate to `http://localhost:3000` to see the application in action.

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for any suggestions or improvements.