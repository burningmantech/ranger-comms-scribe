import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API_URL } from '../config';

import { User } from '../types';

interface LoggedInViewProps {
    user: User;
    blogContent: string | null;
    handleLogout: () => void;
}

const LoggedInView: React.FC<LoggedInViewProps> = ({ user, blogContent, handleLogout }) => {
    const [isAdmin, setIsAdmin] = useState<boolean>(false);

    useEffect(() => {
        // Check if user is admin
        checkAdminStatus();
    }, []);

    const checkAdminStatus = async () => {
        const sessionId = localStorage.getItem('sessionId');
        if (!sessionId) return;

        try {
            const response = await fetch(`${API_URL}/admin/check`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${sessionId}`,
                },
            });

            if (response.ok) {
                const data = await response.json();
                setIsAdmin(data.isAdmin);
            }
        } catch (err) {
            console.error('Error checking admin status:', err);
        }
    };

    return (
        <div>
            <p>Welcome, {user.name}!</p> {/* Display the user's name */}
            <div className="user-actions">
                <Link to="/gallery" className="gallery-link">
                    <button>Gallery</button>
                </Link>
                {isAdmin && (
                    <Link to="/admin" className="admin-link">
                        <button>Admin Dashboard</button>
                    </Link>
                )}
                <button onClick={handleLogout}>Logout</button> {/* Logout button */}
            </div>
            
            {user.approved === false && (
                <div className="approval-message" style={{ 
                    margin: '20px 0', 
                    padding: '10px', 
                    backgroundColor: '#fff3cd', 
                    border: '1px solid #ffeeba', 
                    borderRadius: '4px',
                    color: '#856404'
                }}>
                    <p><strong>Your account is pending approval.</strong></p>
                    <p>An administrator needs to approve your account before you can access all features.</p>
                </div>
            )}
            
            {blogContent ? (
                <div>
                    <h3>Blog</h3>
                    <div dangerouslySetInnerHTML={{ __html: blogContent }} /> {/* Render blog content */}
                </div>
            ) : (
                <p>Loading blog content...</p>
            )}
        </div>
    );
};

export default LoggedInView;
