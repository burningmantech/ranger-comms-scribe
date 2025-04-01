import React, { useEffect, useState } from 'react';
import { GOOGLE_CLIENT_ID } from '../config';
import { loadGoogleOneTap, handleGoogleCredentialResponse } from '../utils/googleAuth';
import { fetchBlogContent, logoutUser } from '../utils/userActions';
import LoggedInView from './LoggedInView';
import LoggedOutView from './LoggedOutView';

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
                <LoggedInView
                    user={user}
                    blogContent={blogContent}
                    handleLogout={handleLogout}
                />
            ) : (
                <LoggedOutView />
            )}
        </div>
    );
};

export default Login;