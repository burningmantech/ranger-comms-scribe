import React, { useEffect, useState } from 'react';
import { API_URL, GOOGLE_CLIENT_ID } from '../config';

declare global {
    interface Window {
        google: any;
    }
}

const Login: React.FC = () => {
    const [user, setUser] = useState<{ email: string; name: string } | null>(null);

    useEffect(() => {
        const storedUser = localStorage.getItem('user');
        if (storedUser) {
            setUser(JSON.parse(storedUser));
        }
    }, []);

    useEffect(() => {
        const handleCredentialResponse = (response: any) => {
            console.log('Encoded JWT ID token:', response.credential);

            // Send the token to your backend for verification
            fetch(`${API_URL}/auth/loginGoogleToken`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ token: response.credential }),
            })
                .then((res) => {
                    if (!res.ok) {
                        throw new Error('Failed to log in');
                    }
                    return res.json();
                })
                .then((data) => {
                    console.log('Response from backend:', data);
                
                    // Persist the user's email and name in localStorage
                    localStorage.setItem('user', JSON.stringify({ email: data.email, name: data.name }));
                
                    // Update state
                    setUser({ email: data.email, name: data.name });
                })
                .catch((error) => {
                    console.error('Error during login:', error);
                });
        };

        const loadGoogleScript = () => {
            const script = document.createElement('script');
            script.src = 'https://accounts.google.com/gsi/client';
            script.async = true;
            script.defer = true;
            script.onload = () => {
                console.log('Google One Tap script loaded');
                window.google.accounts.id.initialize({
                    client_id: GOOGLE_CLIENT_ID,
                    callback: handleCredentialResponse,
                    auto_select: true,
                });
                window.google.accounts.id.prompt();
            };
            script.onerror = () => {
                console.error('Failed to load Google One Tap script');
            };
            document.body.appendChild(script);
        };

        if (!document.getElementById('google-one-tap-script')) {
            loadGoogleScript();
        }
    }, []);

    return (
        <div>
            <h2>Login</h2>
            {user ? (
                <p>Welcome, {user.name}!</p> // Display the user's name
            ) : (
                <p>Google One Tap will appear automatically if you're eligible.</p>
            )}
        </div>
    );
};

export default Login;