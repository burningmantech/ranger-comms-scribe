import { API_URL } from '../config';
import { User } from '../types';

export const loadGoogleOneTap = (clientId: string, callback: (response: any) => void) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
        console.log('Google One Tap script loaded');
        window.google.accounts.id.initialize({
            client_id: clientId,
            callback,
            auto_select: true,
        });
        window.google.accounts.id.prompt();
    };
    script.onerror = () => {
        console.error('Failed to load Google One Tap script');
    };
    document.body.appendChild(script);
};


export const handleGoogleCredentialResponse = (
    response: any,
    setUser: React.Dispatch<React.SetStateAction<User | null>>
) => {
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

            // Persist the user's email, name, session ID, and admin status in localStorage
            localStorage.setItem('user', JSON.stringify({ 
                email: data.email, 
                name: data.name,
                isAdmin: data.isAdmin || false,
                approved: data.approved || false
            }));
            localStorage.setItem('sessionId', data.sessionId);

            // Update state
            setUser({ 
                email: data.email, 
                name: data.name,
                isAdmin: data.isAdmin || false,
                approved: data.approved || false
            });

            // Redirect to admin dashboard if user is an admin
            if (data.isAdmin) {
                window.location.href = '/admin';
            }
        })
        .catch((error) => {
            console.error('Error during login:', error);
        });
};
