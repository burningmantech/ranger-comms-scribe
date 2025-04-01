import React, { useEffect, useState } from 'react';
import { API_URL, GOOGLE_CLIENT_ID } from '../config';
import { loadGoogleOneTap, handleGoogleCredentialResponse } from '../utils/googleAuth';
import { fetchBlogContent, logoutUser } from '../utils/userActions';

declare global {
    interface Window {
        google: any;
    }
}

const Login: React.FC = () => {
    const [user, setUser] = useState<{ email: string; name: string } | null>(null);
    const [blogContent, setBlogContent] = useState<string | null>(null);

    // Load user and session from localStorage on component mount
    useEffect(() => {
        const storedUser = localStorage.getItem('user');
        if (storedUser) {
            setUser(JSON.parse(storedUser));
        }
    }, []);

    // Initialize Google One Tap if the user is not logged in
    useEffect(() => {
        if (!user && !localStorage.getItem('user')) {
            loadGoogleOneTap(GOOGLE_CLIENT_ID, (response: any) =>
                handleGoogleCredentialResponse(response, setUser)
            );
        }
    }, [user]);

    // Fetch blog content if the user is signed in
    useEffect(() => {
        if (user) {
            fetchBlogContent(setBlogContent);
        }
    }, [user]);

    // Logout function
    const handleLogout = () => {
        logoutUser(setUser, setBlogContent);
    };

    return (
        <div>
            <h2>Login</h2>
            {user ? (
                <div>
                    <p>Welcome, {user.name}!</p> {/* Display the user's name */}
                    <button onClick={handleLogout}>Logout</button> {/* Logout button */}
                    {blogContent ? (
                        <div>
                            <h3>Blog</h3>
                            <div dangerouslySetInnerHTML={{ __html: blogContent }} /> {/* Render blog content */}
                        </div>
                    ) : (
                        <p>Loading blog content...</p>
                    )}
                </div>
            ) : (
                <p>Google One Tap will appear automatically if you're eligible.</p>
            )}
        </div>
    );
};

export default Login;