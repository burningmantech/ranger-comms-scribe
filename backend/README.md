# Comms Scribe - Backend API

This is the backend for the Comms Scribe collaborative content management platform, built using Cloudflare Workers and TypeScript. It provides a comprehensive API for user authentication, content management, real-time collaboration, and administrative functions.

## Features

### Core API Functionality
- **User Authentication**: Google OAuth integration with session management and role-based access control
- **Content Management**: Comprehensive content submission, review, and approval workflows
- **Real-time Collaboration**: WebSocket-based real-time editing, user presence, and cursor tracking
- **Tracked Changes**: Advanced change tracking with diff algorithms and operational transforms
- **Blog Management**: Blog post creation, editing, approval, and publishing workflows
- **Media Gallery**: Photo and video upload, management, and commenting system

### Administrative Features
- **User Management**: Bulk user operations, role assignments, and group management
- **Council Management**: Specialized management of council managers and communications cadre members
- **Approval Workflows**: Automated approval processes with reminder systems
- **Email Integration**: Built-in email functionality for notifications and group communications
- **Document Management**: Advanced document handling with version control

### Technical Features
- **Role-Based Access Control**: Multi-level user roles (Admin, Council Manager, Comms Cadre, User, Public)
- **Caching System**: Intelligent caching for improved performance
- **Notification Service**: Automated notification system for workflow events
- **Migration System**: Database migration management for schema updates
- **Comprehensive Testing**: Jest-based test suite with mocking utilities

## Project Structure

```
backend/
├── src/
│   ├── handlers/                     # API route handlers
│   │   ├── admin.ts                  # Administrative functions and user management
│   │   ├── auth.ts                   # Authentication, session management, and OAuth
│   │   ├── blog.ts                   # Blog post CRUD operations and approval workflows
│   │   ├── commsCadre.ts             # Communications cadre management
│   │   ├── contentSubmission.ts      # Content submission processing and workflows
│   │   ├── councilMembers.ts         # Council member management and role assignments
│   │   ├── document.ts               # Document management and version control
│   │   ├── gallery.ts                # Media gallery management and uploads
│   │   ├── page.ts                   # Page management and content serving
│   │   ├── reminders.ts              # Approval reminder system and notifications
│   │   ├── trackedChanges.ts         # Change tracking API and diff management
│   │   ├── user.ts                   # User profile management and settings
│   │   ├── userManagement.ts         # Bulk user operations and group management
│   │   └── websocket.ts              # Real-time WebSocket communication
│   ├── services/                     # Business logic and service layer
│   │   ├── blogService.ts            # Blog service with approval workflows
│   │   ├── cacheService.ts           # Intelligent caching and performance optimization
│   │   ├── councilManagerService.ts  # Council manager business logic
│   │   ├── documentService.ts        # Document handling and version control
│   │   ├── galleryCommentService.ts  # Gallery comment management
│   │   ├── mediaService.ts           # Media upload, processing, and management
│   │   ├── notificationService.ts    # Notification system and email integration
│   │   ├── pageService.ts            # Page management and content serving
│   │   ├── roleService.ts            # Role management and permission system
│   │   ├── trackedChangesService.ts  # Change tracking and diff algorithms
│   │   ├── userService.ts            # User management and authentication
│   │   └── websocketService.ts       # WebSocket connection and real-time features
│   ├── migrations/                   # Database migration scripts
│   │   ├── ensureUserGroups.ts       # User group initialization
│   │   └── setExistingContentPublic.ts # Content visibility migration
│   ├── utils/                        # Utility functions and helpers
│   │   ├── email.ts                  # Email sending and template management
│   │   ├── password.ts               # Password hashing and validation
│   │   ├── sessionManager.ts         # Session management utilities
│   │   └── turnstile.ts              # Cloudflare Turnstile integration
│   ├── authWrappers.ts               # Authentication middleware and route protection
│   ├── config.ts                     # Configuration management
│   ├── types.ts                      # TypeScript type definitions
│   └── index.ts                      # Cloudflare Worker entry point
├── test/                             # Comprehensive test suite
│   ├── services/                     # Service layer tests
│   │   ├── blogService.test.ts       # Blog service tests
│   │   ├── cacheService.test.ts      # Cache service tests
│   │   ├── galleryCommentService.test.ts # Gallery comment tests
│   │   ├── mediaService.test.ts      # Media service tests
│   │   ├── pageService.test.ts       # Page service tests
│   │   ├── trackedChangesService.test.ts # Change tracking tests
│   │   └── userService.test.ts       # User service tests
│   └── utils/                        # Utility function tests
│       ├── email.test.ts             # Email utility tests
│       ├── password.test.ts          # Password utility tests
│       └── sessionManager.test.ts    # Session management tests
├── wrangler.toml                     # Cloudflare Worker configuration
├── package.json                      # Dependencies and scripts
├── tsconfig.json                     # TypeScript configuration
└── README.md                         # This file
```

## Technology Stack

### Core Technologies
- **Cloudflare Workers**: Serverless edge computing platform
- **TypeScript**: Type-safe development with comprehensive type definitions
- **itty-router**: Lightweight routing for Cloudflare Workers
- **Google Auth Library**: OAuth authentication and user management

### Real-time Communication
- **WebSocket**: Real-time bidirectional communication
- **Operational Transforms**: Conflict resolution for collaborative editing
- **User Presence**: Real-time user activity tracking

### Data Management
- **Cloudflare KV**: Key-value storage for user data and sessions
- **Cloudflare R2**: Object storage for media files and documents
- **Cloudflare D1**: SQL database for structured data

### Security & Validation
- **Google OAuth**: Secure authentication with Google accounts
- **Session Management**: Secure session handling and validation
- **Role-Based Access Control**: Multi-level permission system
- **Input Validation**: Comprehensive request validation and sanitization

### Development & Testing
- **Jest**: Comprehensive testing framework
- **Wrangler**: Cloudflare Workers development and deployment tool
- **TypeScript**: Static type checking and modern JavaScript features

## API Endpoints

### Authentication
- `POST /auth/login` - Google OAuth login
- `POST /auth/logout` - User logout
- `GET /auth/check` - Session validation
- `POST /auth/reset-password` - Password reset

### User Management
- `GET /admin/users` - Get all users
- `POST /admin/users` - Create new user
- `PUT /admin/users/:id` - Update user
- `DELETE /admin/users/:id` - Delete user
- `POST /admin/bulk-users` - Bulk user operations

### Content Management
- `POST /content/submit` - Submit new content
- `GET /content/submissions` - Get user submissions
- `PUT /content/submissions/:id` - Update submission
- `GET /content/submissions/:id/tracked-changes` - Get tracked changes

### Blog Management
- `GET /blog/posts` - Get blog posts
- `POST /blog/posts` - Create blog post
- `PUT /blog/posts/:id` - Update blog post
- `DELETE /blog/posts/:id` - Delete blog post

### Real-time Communication
- `WebSocket /ws` - Real-time collaboration and presence

## Setup

1. **Clone the repository**:
   ```
   git clone <repository-url>
   cd vox-machina/backend
   ```

2. **Install dependencies**:
   ```
   npm install
   ```

3. **Configure environment variables**:
   - Set up Google OAuth credentials
   - Configure Cloudflare KV, R2, and D1 bindings
   - Set up email service configuration

4. **Run migrations**:
   ```
   npm run migrate
   ```

5. **Start development server**:
   ```
   npm run dev
   ```

## Development

### Local Development
```bash
# Start development server with local backend
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

### Testing
The project includes comprehensive tests for all services and utilities:
```bash
# Run all tests
npm test

# Run specific test file
npm test -- blogService.test.ts

# Run tests with coverage
npm test -- --coverage
```

### Deployment
```bash
# Deploy to Cloudflare Workers
npm run deploy

# Deploy to specific environment
wrangler deploy --env production
```

## Environment Variables

Required environment variables for the backend:

```env
# Google OAuth
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Cloudflare Bindings (configured in wrangler.toml)
# - KV namespaces for user data and sessions
# - R2 bucket for media storage
# - D1 database for structured data

# Email Configuration
SMTP_HOST=your_smtp_host
SMTP_PORT=587
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_password

# Security
JWT_SECRET=your_jwt_secret
TURNSTILE_SECRET_KEY=your_turnstile_secret
```

## Contributing

Contributions are welcome! Please submit a pull request or open an issue for any enhancements or bug fixes.

### Development Guidelines
- Follow TypeScript best practices
- Write comprehensive tests for new features
- Use proper error handling and validation
- Follow the existing code structure and patterns
- Update documentation for new API endpoints
