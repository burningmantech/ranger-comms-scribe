import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API_URL } from '../config';
import { LogoutUserReact } from '../utils/userActions';

const Navbar: React.FC = () => {
    const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
    const [isAdmin, setIsAdmin] = useState<boolean>(false);
    const navigate = useNavigate();

    useEffect(() => {
        // Check if user is logged in
        const sessionId = localStorage.getItem('sessionId');
        if (sessionId) {
            setIsLoggedIn(true);
            checkAdminStatus(sessionId);
        }
    }, []);

    const checkAdminStatus = async (sessionId: string) => {
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

    const handleLogout = () => {
        LogoutUserReact(navigate);
    };

    return (
        <nav className="navbar">
            <div className="navbar-brand">
                <Link to="/">DCWB</Link>
            </div>
            <div className="navbar-menu">
                <Link to="/gallery" className="navbar-item">Gallery</Link>
                <Link to="/blog" className="navbar-item">Blog</Link>
                {isAdmin && (
                    <Link to="/admin" className="navbar-item">Admin</Link>
                )}
                {isLoggedIn ? (
                    <button onClick={handleLogout} className="navbar-item logout-button">Logout</button>
                ) : (
                    <Link to="/login" className="navbar-item">Login</Link>
                )}
            </div>
        </nav>
    );
};

export default Navbar;
