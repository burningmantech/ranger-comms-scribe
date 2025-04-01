import React, { useEffect, useState } from 'react';
import { GOOGLE_CLIENT_ID } from '../config';
import { handleGoogleCredentialResponse } from '../utils/googleAuth';
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

    // Dynamically load the Google Identity Services script
    useEffect(() => {
        const loadGoogleScript = () => {
            const script = document.createElement('script');
            script.src = 'https://accounts.google.com/gsi/client';
            script.async = true;
            script.defer = true;
            script.onload = () => {
                console.log('Google Identity Services script loaded');
                if (!user && window.google) {
                    console.log('Google object is available');
                    // Initialize the Google Identity Services library
                    window.google.accounts.id.initialize({
                        client_id: GOOGLE_CLIENT_ID,
                        callback: (response: any) =>
                            handleGoogleCredentialResponse(response, setUser),
                    });

                    // Show the One Tap Login with debugging
                    window.google.accounts.id.prompt((notification: any) => {
                        if (notification.isNotDisplayed()) {
                            console.error('One Tap Login not displayed:', notification.getNotDisplayedReason());
                        }
                        if (notification.isSkippedMoment()) {
                            console.error('One Tap Login skipped:', notification.getSkippedReason());
                        }
                        if (notification.isDismissedMoment()) {
                            console.error('One Tap Login dismissed:', notification.getDismissedReason());
                        }
                    });

                    // Render the "Sign in with Google" button
                    const buttonContainer = document.getElementById('google-signin-button');
                    if (buttonContainer) {
                        console.log('Button container exists');
                        window.google.accounts.id.renderButton(buttonContainer, {
                            theme: 'filled_blue',
                            size: 'large',
                            shape: 'pill',
                            text: 'signin_with',
                            logo_alignment: 'left',
                        });
                    } else {
                        console.error('Button container does not exist');
                    }
                }
            };
            script.onerror = () => {
                console.error('Failed to load Google Identity Services script');
            };
            document.body.appendChild(script);
        };

        if (!window.google) {
            loadGoogleScript();
        } else {
            console.log('Google script already loaded');
            // Ensure initialization if the script is already loaded
            if (!user) {
                window.google.accounts.id.initialize({
                    client_id: GOOGLE_CLIENT_ID,
                    callback: (response: any) =>
                        handleGoogleCredentialResponse(response, setUser),
                });

                // Show the One Tap Login with debugging
                window.google.accounts.id.prompt((notification: any) => {
                    if (notification.isNotDisplayed()) {
                        console.error('One Tap Login not displayed:', notification.getNotDisplayedReason());
                    }
                    if (notification.isSkippedMoment()) {
                        console.error('One Tap Login skipped:', notification.getSkippedReason());
                    }
                    if (notification.isDismissedMoment()) {
                        console.error('One Tap Login dismissed:', notification.getDismissedReason());
                    }
                });

                // Render the "Sign in with Google" button
                const buttonContainer = document.getElementById('google-signin-button');
                if (buttonContainer) {
                    window.google.accounts.id.renderButton(buttonContainer, {
                        theme: 'filled_blue',
                        size: 'large',
                        shape: 'pill',
                        text: 'signin_with',
                        logo_alignment: 'left',
                    });
                }
            }
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
                <div>
                    <LoggedOutView />
                    <div
                        id="google-signin-button"
                        style={{
                            marginTop: '20px',
                            display: 'flex',
                            justifyContent: 'left',
                        }}
                    ></div>
                </div>
            )}
        </div>
    );
};

export default Login;