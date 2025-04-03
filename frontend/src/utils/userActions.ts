import { useNavigate } from 'react-router-dom';
import { API_URL } from '../config';
import { User } from '../types';

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

    console.log('User logged out');
    if (navigate) {
        navigate('/'); // Redirect to home page if navigate function is provided
    }
};
