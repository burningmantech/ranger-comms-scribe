import React, { useState, useEffect } from 'react';
import { API_URL } from '../config';
import { User } from '../types';

interface HomeProps {
  skipNavbar?: boolean;
}

const Home: React.FC<HomeProps> = ({ skipNavbar }) => {
    const [user, setUser] = useState<User | null>(null);
    const [content, setContent] = useState<string>('');
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // Check if user is logged in
        const userJson = localStorage.getItem('user');
        if (userJson) {
            try {
                const userData = JSON.parse(userJson) as User;
                setUser(userData);
            } catch (err) {
                console.error('Error parsing user data:', err);
            }
        }

        // Fetch home page content
        fetchHomeContent();
    }, []);

    const fetchHomeContent = async () => {
        try {
            const response = await fetch(`${API_URL}/page/home/content`);
            
            if (!response.ok) {
                throw new Error('Failed to fetch home page content');
            }
            
            const data = await response.json();
            
            if (data.content) {
                setContent(data.content);
            } else {
                // Use default content if no custom content is available
                setContent(`
                    <h1>Welcome to Dancing Cat Wine Bar</h1>
                    <p>Check out our <a href="/gallery">Gallery</a> and <a href="/blog">Blog</a>.</p>
                `);
            }
            
            setLoading(false);
        } catch (err) {
            console.error('Error fetching home page content:', err);
            setError('Error loading content');
            setLoading(false);
            
            // Use default content on error
            setContent(`
                <h1>Welcome to Dancing Cat Wine Bar</h1>
                <p>Check out our <a href="/gallery">Gallery</a> and <a href="/blog">Blog</a>.</p>
            `);
        }
    };

    if (loading) {
        return (
            <div className="home">
                <p>Loading...</p>
            </div>
        );
    }

    return (
        <div className="home">
            {error && <div className="error">{error}</div>}
            <div dangerouslySetInnerHTML={{ __html: content }} />
        </div>
    );
};

export default Home;
