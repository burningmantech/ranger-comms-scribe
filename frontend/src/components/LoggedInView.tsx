import React from 'react';

interface LoggedInViewProps {
    user: { email: string; name: string };
    blogContent: string | null;
    handleLogout: () => void;
}

const LoggedInView: React.FC<LoggedInViewProps> = ({ user, blogContent, handleLogout }) => {
    return (
        <div>
            <p>Welcome, {user.name}!</p> {/* Display the user's name */}
            <button onClick={handleLogout}>Logout</button> {/* Logout button */}
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