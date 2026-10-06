import { API_URL } from '../config';
import { User, UserType } from '../types';
import { handleUserLogin } from './userActions';

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


export const handleGoogleCredentialResponse = async (
    response: any,
    setUser: React.Dispatch<React.SetStateAction<User | null>>,
    setParentUser?: React.Dispatch<React.SetStateAction<User | null>>
) => {
    console.log('Encoded JWT ID token:', response.credential);

    // Send the token to your backend for verification
    const res = await fetch(`${API_URL}/auth/loginGoogleToken`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: response.credential }),
    });

    if (!res.ok) {
        throw new Error('Failed to log in');
    }

    const data = await res.json();
    console.log('Response from backend:', data);

    // Stores the person's record from the server (with their access) and signs them in
    const userData = await handleUserLogin({ email: data.email, name: data.name, isAdmin: !!data.isAdmin }, data.sessionId);

    // Update local state
    setUser(userData);
    
    // Update parent state if provided
    if (setParentUser) {
        setParentUser(userData);
    }

    // Redirect to admin dashboard if user is an admin
    if (data.isAdmin) {
        window.location.href = '/admin';
    }
};
