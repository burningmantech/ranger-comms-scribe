import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { API_URL } from '../config';
import { LogoutUserReact, USER_LOGIN_EVENT } from '../utils/userActions';
import { User } from '../types';

interface NavbarProps {
    skipNavbar?: boolean;
}

const Navbar: React.FC<NavbarProps> = ({ skipNavbar = false }) => {
    const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
    const [isAdmin, setIsAdmin] = useState<boolean>(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
    const navigate = useNavigate();
    const location = useLocation();
    
    // Function to check login status
    const checkLoginStatus = () => {
        const sessionId = localStorage.getItem('sessionId');
        if (sessionId) {
            setIsLoggedIn(true);
            checkAdminStatus(sessionId);
        } else {
            setIsLoggedIn(false);
            setIsAdmin(false);
        }
    };

    useEffect(() => {
        // Check if user is logged in
        checkLoginStatus();

        // Add event listeners for both storage and custom login events
        window.addEventListener('storage', handleStorageChange);
        window.addEventListener(USER_LOGIN_EVENT, handleLoginStateChange as EventListener);
        
        // Clean up event listeners
        return () => {
            window.removeEventListener('storage', handleStorageChange);
            window.removeEventListener(USER_LOGIN_EVENT, handleLoginStateChange as EventListener);
        };
    }, []);

    // Handle localStorage changes
    const handleStorageChange = (event: StorageEvent) => {
        if (event.key === 'sessionId' || event.key === 'user') {
            checkLoginStatus();
        }
    };

    // Handle custom login state changes
    const handleLoginStateChange = (event: CustomEvent<User | null>) => {
        const userData = event.detail;
        setIsLoggedIn(!!userData);
        setIsAdmin(userData?.isAdmin === true || userData?.userType === 'Admin');
    };

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
        setIsLoggedIn(false);
        setIsAdmin(false);
    };

    const toggleMobileMenu = () => {
        setMobileMenuOpen(!mobileMenuOpen);
    };

    const handleMenuItemClick = () => {
        setMobileMenuOpen(false);
    };

    const currentPageSlug = location.pathname.split('/')[1] || '';

    return (
        <nav className="navbar">
            <div className="navbar-brand">
                <Link to="/">Comms Scribe</Link>
            </div>
            <button className="mobile-menu-toggle" onClick={toggleMobileMenu}>
                ☰
            </button>
            <div className={`navbar-menu ${mobileMenuOpen ? 'active' : ''}`}>
                {/* Admin and user account links */}
                {isAdmin && (
                    <Link to="/admin" className={`navbar-item ${currentPageSlug === 'admin' ? 'active' : ''}`} onClick={handleMenuItemClick}>Admin</Link>
                )}
                {isLoggedIn ? (
                    <>
                        <Link to="/settings" className={`navbar-item ${currentPageSlug === 'settings' ? 'active' : ''}`} onClick={handleMenuItemClick}>Settings</Link>
                        <button onClick={() => { handleLogout(); handleMenuItemClick(); }} className="navbar-item logout-button">Logout</button>
                    </>
                ) : (
                    <Link to="/login" className={`navbar-item ${currentPageSlug === 'login' ? 'active' : ''}`} onClick={handleMenuItemClick}>Login</Link>
                )}
            </div>
        </nav>
    );
};

export default Navbar;
