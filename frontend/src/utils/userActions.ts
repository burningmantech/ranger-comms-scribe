import { useNavigate } from 'react-router-dom';
import { API_URL } from '../config';
import { User } from '../types';

// Event to notify login state changes
export const USER_LOGIN_EVENT = 'user_login_change';

// Helper to dispatch login state change event
const dispatchLoginStateChange = (user: User | null) => {
    const event = new CustomEvent(USER_LOGIN_EVENT, { detail: user });
    window.dispatchEvent(event);
};

// Function to handle user login
export const handleUserLogin = async (userData: User, sessionId: string) => {
    // Fetch user roles from backend
    try {
        const response = await fetch(`${API_URL}/admin/user-roles`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${sessionId}`,
            },
        });

        if (response.ok) {
            const data = await response.json();
            userData.roles = data.roles;
        }
    } catch (error) {
        console.error('Error fetching user roles:', error);
    }

    localStorage.setItem('user', JSON.stringify(userData));
    localStorage.setItem('sessionId', sessionId);
    dispatchLoginStateChange(userData);
};

export const LogoutUserReact = async (navigate?: (path: string) => void) => {
    const sessionId = localStorage.getItem('sessionId');
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionId}`,
      },
    });
    localStorage.removeItem('user');
    localStorage.removeItem('sessionId');
    dispatchLoginStateChange(null);

    console.log('User logged out');
    if (navigate) {
        navigate('/'); // Redirect to home page if navigate function is provided
    }
};
