import React, { useState, useEffect } from 'react';
import { API_URL } from '../config';
import { Link } from 'react-router-dom';
import { EditorState } from 'draft-js';
import { convertFromRaw } from 'draft-js';
import { stateToHTML } from 'draft-js-export-html';
import { isValidDraftJs } from './editor/utils/serialization';
import LexicalEditorComponent from './editor/LexicalEditor';

interface HomeProps {
  skipNavbar?: boolean;
}

const Home: React.FC<HomeProps> = ({ skipNavbar }) => {
    const [content, setContent] = useState<string>('');
    const [isAdmin, setIsAdmin] = useState<boolean>(false);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // Check if the user is an admin
        const userJson = localStorage.getItem('user');
        if (userJson) {
            try {
                const userData = JSON.parse(userJson);
                setIsAdmin(userData.isAdmin === true || userData.userType === 'Admin');
            } catch (err) {
                console.error('Error parsing user data:', err);
            }
        }

        // Fetch home page content
        fetchHomePageContent();
    }, []);

    const fetchHomePageContent = async () => {
        try {
            const response = await fetch(`${API_URL}/page/home/content`);
            
            if (!response.ok) {
                throw new Error('Failed to fetch home page content');
            }
            
            const data = await response.json();
            if (data.content) {
                setContent(data.content);
            } else {
                setContent(`
                    <h1>Welcome to Dancing Cat Wine Bar</h1>
                    <p>Check out our <a href="/gallery">Gallery</a> and <a href="/blog">Blog</a>.</p>
                `);
            }
            setLoading(false);
        } catch (err) {
            console.error('Error fetching home page content:', err);
            setLoading(false);
            
            // Use default content on error
            setContent(`
                <h1>Welcome to Dancing Cat Wine Bar</h1>
                <p>Check out our <a href="/gallery">Gallery</a> and <a href="/blog">Blog</a>.</p>
            `);
        }
    };

    const renderContent = (content: string) => {
        // Check if content is in Lexical format
        try {
            const isLexical = content.includes('"root"') && 
                             content.includes('"children"') && 
                             content.includes('"type"');
            
            if (isLexical) {
                // Return a read-only Lexical editor component
                return (
                    <LexicalEditorComponent 
                        initialContent={content}
                        showToolbar={false}
                        readOnly={true}
                        className="read-only-content"
                    />
                );
            }
            
            // Try to parse as draft.js JSON
            if (isValidDraftJs(content)) {
                try {
                    const raw = JSON.parse(content);
                    const contentState = convertFromRaw(raw);
                    return <div dangerouslySetInnerHTML={{ __html: stateToHTML(contentState) }} />;
                } catch (e) {
                    console.error("Error parsing Draft.js content:", e);
                }
            }
        } catch {
            // Fallback: treat as HTML if parsing fails
        }
        
        // Simple HTML content
        return <div dangerouslySetInnerHTML={{ __html: content }} />;
    };

    if (loading) {
        return (
            <div className="home">
                <p>Loading...</p>
            </div>
        );
    }

    return (
        <div className="dynamic-page">
            <div className="home">
                {error && <div className="error">{error}</div>}
                {renderContent(content)}
                
                {/* Add edit button for admin users */}
                {isAdmin && (
                    <Link 
                        to="/home" 
                        style={{
                            display: 'inline-block',
                            padding: '8px 16px',
                            backgroundColor: '#722f37', // Using our accent-wine color
                            color: '#f5f0eb', // Using our text-light color
                            borderRadius: '4px',
                            fontSize: '14px',
                            border: 'none',
                            cursor: 'pointer',
                            margin: '20px 0',
                            textDecoration: 'none',
                            transition: 'background-color 0.3s'
                        }}
                    >
                        Edit Page
                    </Link>
                )}
            </div>
        </div>
    );
};

export default Home;
