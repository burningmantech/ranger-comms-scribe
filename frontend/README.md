# Comms Scribe Website - Frontend

Welcome to the Comms Scribe Website frontend! This project is built with TypeScript and React, providing a platform for the Comms Scribe theme camp to host a blog and gallery for user-generated content.

## Project Structure

- **src/**: Contains the source code for the frontend application.
  - **components/**: Contains React components for the application.
    - **Blog.tsx**: Displays blog posts fetched from the backend.
    - **Gallery.tsx**: Displays user-uploaded photos and videos.
    - **Login.tsx**: Integrates Google One Tap for user authentication.
  - **App.tsx**: Main application component that sets up routing.
  - **index.tsx**: Entry point of the application that renders the App component.

- **public/**: Contains static files for the frontend application.
  - **index.html**: Main HTML file where the React app is mounted.

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

4. **Open your browser** and navigate to `http://localhost:3000` to see the application in action.

## Features

- **Blog**: Users can read and interact with blog posts related to the Comms Scribe.
- **Gallery**: Users can upload and view photos and videos, creating a vibrant community space.
- **Authentication**: Google One Tap integration for seamless user login.

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for any enhancements or bug fixes.

