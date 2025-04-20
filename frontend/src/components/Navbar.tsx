import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API_URL } from '../config';
import { LogoutUserReact, USER_LOGIN_EVENT } from '../utils/userActions';
import { Page, User } from '../types';

const Navbar: React.FC = () => {
    const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
    const [isAdmin, setIsAdmin] = useState<boolean>(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
    const [pages, setPages] = useState<Page[]>([]);
    const navigate = useNavigate();

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
        
        // Fetch published pages for navigation
        fetchPages();

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
        setIsAdmin(userData?.isAdmin === true);
    };
    
    const fetchPages = async () => {
        try {
            const response = await fetch(`${API_URL}/page`);
            
            if (!response.ok) {
                throw new Error('Failed to fetch pages');
            }
            
            const data = await response.json();
            
            // Filter pages that should be shown in navigation
            const navPages = data.filter((page: Page) => 
                page.published && page.showInNavigation
            );
            
            setPages(navPages);
        } catch (err) {
            console.error('Error fetching pages:', err);
        }
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

    return (
        <nav className="navbar">
            <div className="navbar-brand">
                <Link to="/">DCWB</Link>
            </div>
            <button className="mobile-menu-toggle" onClick={toggleMobileMenu}>
                ☰
            </button>
            <div className={`navbar-menu ${mobileMenuOpen ? 'active' : ''}`}>
                <Link to="/gallery" className="navbar-item" onClick={handleMenuItemClick}>Gallery</Link>
                <Link to="/blog" className="navbar-item" onClick={handleMenuItemClick}>Blog</Link>
                
                {/* Dynamic pages in navigation */}
                {pages.map(page => (
                    <Link 
                        key={page.id} 
                        to={`/${page.slug || ''}`} 
                        className="navbar-item"
                        onClick={(e) => {
                            if (!page.slug) {
                                e.preventDefault();
                                console.error('Invalid slug for page:', page);
                            } else {
                                handleMenuItemClick();
                            }
                        }}
                    >
                        {page.title}
                    </Link>
                ))}
                
                {isAdmin && (
                    <Link to="/admin" className="navbar-item" onClick={handleMenuItemClick}>Admin</Link>
                )}
                {isLoggedIn ? (
                    <>
                        <Link to="/settings" className="navbar-item" onClick={handleMenuItemClick}>Settings</Link>
                        <button onClick={() => { handleLogout(); handleMenuItemClick(); }} className="navbar-item logout-button">Logout</button>
                    </>
                ) : (
                    <Link to="/login" className="navbar-item" onClick={handleMenuItemClick}>Login</Link>
                )}
            </div>
        </nav>
    );
};

export default Navbar;
