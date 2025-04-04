import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GOOGLE_CLIENT_ID } from '../config';
import { handleGoogleCredentialResponse } from '../utils/googleAuth';
import { fetchBlogContent, LogoutUserReact } from '../utils/userActions';
import LoggedOutView from './LoggedOutView';
import Home from './Home';
import { User } from '../types';

declare global {
    interface Window {
        google: any;
    }
}

const Login: React.FC = () => {
    const [user, setUser] = useState<User | null>(null);
    const [blogContent, setBlogContent] = useState<string | null>(null);
    const navigate = useNavigate();

    // Load user and session from localStorage on component mount
    useEffect(() => {
        const storedUser = localStorage.getItem('user');
        console.log('Checking localStorage for user:', storedUser);
        if (storedUser) {
            const parsedUser = JSON.parse(storedUser);
            console.log('User found in localStorage:', parsedUser);
            setUser(parsedUser);
        } else {
            console.log('No user found in localStorage');
        }
    }, []);

    // Dynamically load the Google Identity Services script
    useEffect(() => {
        // Only proceed with Google Sign-In if user is not logged in
        if (user) {
            // Cancel the One Tap prompt if it's showing and user is logged in
            if (window.google && window.google.accounts) {
                window.google.accounts.id.cancel();
                console.log('Google One Tap canceled because user is logged in');
            }
            return;
        }

        const loadGoogleScript = () => {
            const script = document.createElement('script');
            script.src = 'https://accounts.google.com/gsi/client';
            script.async = true;
            script.defer = true;
            script.onload = () => {
                console.log('Google Identity Services script loaded');
                if (window.google) {
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
            window.google.accounts.id.initialize({
                client_id: GOOGLE_CLIENT_ID,
                callback: (response: any) =>
                    handleGoogleCredentialResponse(response, setUser),
            });

            // Only show the One Tap Login if the user is not logged in
            if (!user) {
                console.log('User not logged in, showing One Tap Login');
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
            } else {
                console.log('User already logged in, not showing One Tap Login');
                // Cancel any existing One Tap prompt
                window.google.accounts.id.cancel();
            }

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
    }, [user]); // Dependency on user ensures this effect re-runs when user changes

    // Fetch blog content if the user is signed in
    useEffect(() => {
        if (user) {
            navigate('/blog');
        }
    }, [user]);

    // Logout function
    const handleLogout = () => {
        LogoutUserReact(navigate);
    };

    return (
        <div>
            <h2>Login</h2>
            {user ? (
                <><Home /></>
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
