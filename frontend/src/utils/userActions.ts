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
export const handleUserLogin = (userData: User, sessionId: string) => {
    localStorage.setItem('user', JSON.stringify(userData));
    localStorage.setItem('sessionId', sessionId);
    dispatchLoginStateChange(userData);
};

export const fetchBlogContent = (
    setBlogContent: React.Dispatch<React.SetStateAction<string | null>>
) => {
    const sessionId = localStorage.getItem('sessionId');
    if (sessionId) {
        fetch(`${API_URL}/blog`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${sessionId}`, // Pass the session ID in the Authorization header
            },
        })
            .then((res) => {
                if (!res.ok) {
                    throw new Error('Failed to fetch blog content');
                }
                return res.text(); // Assuming the blog content is plain text or HTML
            })
            .then((content) => {
                setBlogContent(content); // Store the blog content in state
            })
            .catch((error) => {
                console.error('Error fetching blog content:', error);
            });
    }
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
