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

The backend is a single Node 24 server written in TypeScript. One process serves the REST API under `/api/*` and the real-time WebSocket rooms under `/api/ws/*`. Data is stored as JSON objects in S3 (MinIO locally), with an in-memory cache in front. It handles user authentication, content management, real-time collaboration and administrative functions.

The backend files are in the `backend` directory:

```
backend/
├── src/
│   ├── server.ts                     # Entry point: config, startup, HTTP server, shutdown
│   ├── httpServer.ts                 # itty-router app + WebSocket upgrades
│   ├── index.ts                      # Router and route mounting
│   ├── config/env.ts                 # Environment variables (see the contracts doc)
│   ├── handlers/                     # HTTP route handlers (auth, content, gallery, admin, ...)
│   ├── services/                     # Business logic (cacheService, mediaService, userService, ...)
│   ├── realtime/rooms.ts             # WebSocket rooms (presence, cursors, live updates)
│   ├── storage/                      # ObjectStore interface + S3 and in-memory implementations
│   ├── utils/                        # Email (SES), sessions, Google token check, Turnstile, ...
│   ├── authWrappers.ts               # Authentication middleware
│   └── types.ts                      # TypeScript definitions
├── test/                             # Jest tests
├── Dockerfile                        # Production image (node:24-alpine)
├── package.json
└── tsconfig.json
```

Infrastructure lives in `infra/` (AWS CDK), deploy scripts in `bin/`, and CI in `.github/workflows/`.

## Features

### Core Functionality
- **Collaborative Content Editing**: Real-time collaborative rich text editing with live updates, presence and cursors
- **Content Workflow Management**: Comprehensive submission, review, and approval system
- **Tracked Changes**: Advanced change tracking with diff visualization and acceptance/rejection workflows
- **Role-Based Access Control**: Multi-level user roles (Admin, Council Manager, Comms Cadre, User, Public)
- **Real-time Collaboration**: WebSocket-based real-time updates, user presence, and cursor tracking

### Administrative Features
- **User Management**: Bulk user operations, role assignments, and group management
- **Council Management**: Specialized interfaces for managing council managers and communications cadre
- **Approval Workflows**: Multi-stage approval processes
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
- **Node 24** with TypeScript, **itty-router** served through `@whatwg-node/server`
- **Amazon S3** for storage (MinIO locally), in-memory cache
- **ws** for real-time WebSocket rooms
- **Amazon SES** for email
- **Jest** for testing

### Infrastructure
- **AWS CDK**: CloudFront, S3, an Application Load Balancer and ECS Fargate
- **ranger-deploy** and GitHub Actions for deploys, matching other Ranger services

## Deployment

Production runs at [scrivenly.com](https://scrivenly.com), currently still on Cloudflare (from the `master` branch). The `feature/aws-migration` branch moves it to AWS:

- **Container:** one Node container on ECS Fargate behind an Application Load Balancer.
- **Routing:** CloudFront serves the SPA from S3 and sends `/api/*` to the load balancer.
- **Plan and contracts:** `docs/plans/2026-10-04-aws-migration-prd.md` and `docs/plans/2026-10-04-aws-migration-contracts.md`.
- **Setup and deploy steps:** `infra/README.md`. There are two environment profiles: a low-cost dev environment that can sleep, and the standard Ranger setup with staging and production.

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
   # Terminal 1 - MinIO + backend in Docker (API on http://localhost:8080/api)
   docker compose up -d --build

   # Terminal 2 - Frontend
   cd frontend
   npm run start:local-backend
   ```
   For a quick backend without Docker, see "Quick local run" in `CLAUDE.md` or `backend/README.md`.

5. **Open your browser** and navigate to `http://localhost:3000` to see the application in action.

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for any suggestions or improvements.