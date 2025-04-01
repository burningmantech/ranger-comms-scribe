import { API_URL } from '../config';

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

export const logoutUser = (
    setUser: React.Dispatch<React.SetStateAction<{ email: string; name: string } | null>>,
    setBlogContent: React.Dispatch<React.SetStateAction<string | null>>
) => {
    const sessionId = localStorage.getItem('sessionId'); // Retrieve the session ID from localStorage

    if (sessionId) {
        // Call the backend's logout endpoint
        fetch(`${API_URL}/auth/logout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${sessionId}`, // Pass the session ID in the Authorization header
            },
        })
            .then((res) => {
                if (!res.ok) {
                    throw new Error('Failed to log out');
                }
                console.log('Logout successful');
            })
            .catch((error) => {
                console.error('Error during logout:', error);
            });
    }

    // Clear user and session data from localStorage
    localStorage.removeItem('user');
    localStorage.removeItem('sessionId');

    // Clear user state
    setUser(null);
    setBlogContent(null); // Clear blog content

    console.log('User logged out');
};