# Dancing Cats Website

Welcome to the Dancing Cats website project! This project is designed to serve as a blog and media sharing platform for the Burning Man theme camp, Dancing Cat Wine Bar. The website features user-generated content, including blog posts, photos, and videos, and integrates Google One Tap for user authentication.

## Project Structure

The project is divided into two main parts: the frontend and the backend.

### Frontend

The frontend is built with TypeScript and React. It includes the following components:

- **Blog**: Displays blog posts fetched from the backend.
- **Gallery**: Shows user-uploaded photos and videos.
- **Login**: Integrates Google One Tap for user authentication.

The frontend files are located in the `frontend` directory:

```
frontend/
├── src/
│   ├── components/
│   │   ├── Blog.tsx
│   │   ├── Gallery.tsx
│   │   └── Login.tsx
│   ├── App.tsx
│   └── index.tsx
├── public/
│   └── index.html
├── package.json
├── tsconfig.json
└── README.md
```

### Backend

The backend is implemented as a Cloudflare Worker using TypeScript. It handles user authentication, blog post management, and media uploads. The backend files are located in the `backend` directory:

```
backend/
├── src/
│   ├── handlers/
│   │   ├── auth.ts
│   │   ├── blog.ts
│   │   └── gallery.ts
│   └── index.ts
├── wrangler.toml
├── package.json
├── tsconfig.json
└── README.md
```

## Features

- **User Authentication**: Users can log in using Google One Tap.
- **Blog Management**: Admin users can create, fetch, and approve blog posts.
- **Media Gallery**: Users can upload and view photos and videos.
- **Admin Controls**: Admin users can manage user accounts and approve new user requests.

## Deployment

The website is hosted at [dancingcats.org](https://dancingcats.org) and utilizes Cloudflare Workers for the backend functionality. Ensure that your DNS settings are correctly configured to point to the Cloudflare Worker.

## Getting Started

To get started with the project, clone the repository and install the necessary dependencies for both the frontend and backend:

1. Clone the repository:
   ```
   git clone <repository-url>
   cd dancing-cats-website
   ```

2. Install frontend dependencies:
   ```
   cd frontend
   npm install
   ```

3. Install backend dependencies:
   ```
   cd backend
   npm install
   ```

4. Run the frontend and backend applications locally for development.

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for any suggestions or improvements.