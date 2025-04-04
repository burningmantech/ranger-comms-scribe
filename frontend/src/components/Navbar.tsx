import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API_URL } from '../config';
import { LogoutUserReact } from '../utils/userActions';
import { Page } from '../types';

const Navbar: React.FC = () => {
    const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
    const [isAdmin, setIsAdmin] = useState<boolean>(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
    const [pages, setPages] = useState<Page[]>([]);
    const navigate = useNavigate();

    useEffect(() => {
        // Check if user is logged in
        const sessionId = localStorage.getItem('sessionId');
        if (sessionId) {
            setIsLoggedIn(true);
            checkAdminStatus(sessionId);
        }
        
        // Fetch published pages for navigation
        fetchPages();
    }, []);
    
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
    };

    const toggleMobileMenu = () => {
        setMobileMenuOpen(!mobileMenuOpen);
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
                <Link to="/gallery" className="navbar-item">Gallery</Link>
                <Link to="/blog" className="navbar-item">Blog</Link>
                
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
                            }
                        }}
                    >
                        {page.title}
                    </Link>
                ))}
                
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
