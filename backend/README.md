# Vox Quietus Website Backend

This is the backend for the Vox Quietus website, which serves as a blog and media gallery for the Burning Man theme camp, Vox Quietus. The backend is built using Cloudflare Workers and TypeScript.

## Features

- **User Authentication**: Integrates Google One Tap for seamless user login.
- **Blog Management**: Allows users to create, fetch, and approve blog posts.
- **Media Gallery**: Users can upload and view photos and videos.

## Project Structure

- `src/handlers/auth.ts`: Functions for user authentication and session management.
- `src/handlers/blog.ts`: Functions for managing blog posts.
- `src/handlers/gallery.ts`: Functions for handling media uploads and retrieval.
- `index.ts`: Entry point for the backend application, setting up the Cloudflare Worker.

## Setup

1. Clone the repository.
2. Install dependencies:
   ```
   npm install
   ```
3. Configure your environment variables for Google authentication and any other necessary settings.
4. Deploy the worker using Wrangler:
   ```
   wrangler publish
   ```

## Development

To run the backend locally, use the following command:
```
wrangler dev
```

## Contributing

Contributions are welcome! Please submit a pull request or open an issue for any enhancements or bug fixes.
