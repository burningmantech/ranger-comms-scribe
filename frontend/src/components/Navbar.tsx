import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { API_URL } from '../config';
import { LogoutUserReact, USER_LOGIN_EVENT } from '../utils/userActions';
import { Page, User } from '../types';

interface NavbarProps {
    navigationPages?: Page[];
}

const Navbar: React.FC<NavbarProps> = ({ navigationPages = [] }) => {
    const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
    const [isAdmin, setIsAdmin] = useState<boolean>(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
    const [pages, setPages] = useState<Page[]>([]);
    const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
    const [expandedMobileSections, setExpandedMobileSections] = useState<Set<string>>(new Set());
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
        
        // Use navigation pages from props if available
        if (navigationPages && navigationPages.length > 0) {
            setPages(navigationPages);
        } else {
            // Fallback to fetching pages
            fetchPages();
        }

        // Add event listeners for both storage and custom login events
        window.addEventListener('storage', handleStorageChange);
        window.addEventListener(USER_LOGIN_EVENT, handleLoginStateChange as EventListener);
        
        // Clean up event listeners
        return () => {
            window.removeEventListener('storage', handleStorageChange);
            window.removeEventListener(USER_LOGIN_EVENT, handleLoginStateChange as EventListener);
        };
    }, [navigationPages]);

    // Close dropdown when location changes
    useEffect(() => {
        setActiveDropdown(null);
    }, [location]);

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
    
    const fetchPages = async () => {
        try {
            // Get the session ID from localStorage if available
            const sessionId = localStorage.getItem('sessionId');
            const headers: HeadersInit = {};
            
            // Add authorization header if session ID exists
            if (sessionId) {
                headers['Authorization'] = `Bearer ${sessionId}`;
            }
            
            const response = await fetch(`${API_URL}/page`, {
                headers
            });
            
            if (!response.ok) {
                throw new Error('Failed to fetch pages');
            }
            
            const data = await response.json();
            
            // Filter pages that should be shown in navigation, excluding the "home" page
            const navPages = data.filter((page: Page) => 
                page.published && 
                page.showInNavigation && 
                page.slug !== 'home' // Exclude the home page from navigation
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
        setActiveDropdown(null);
    };

    const toggleDropdown = (pageId: string) => {
        if (activeDropdown === pageId) {
            setActiveDropdown(null);
        } else {
            setActiveDropdown(pageId);
        }
    };

    // Toggle a mobile section expanded/collapsed state
    const toggleMobileSection = (parentPageId: string, event: React.MouseEvent) => {
        // Prevent navigation to the parent page
        event.preventDefault();
        event.stopPropagation();
        
        setExpandedMobileSections(prev => {
            const newSet = new Set(prev);
            if (newSet.has(parentPageId)) {
                newSet.delete(parentPageId);
            } else {
                newSet.add(parentPageId);
            }
            return newSet;
        });
    };

    // Group pages by parent-child relationship
    const parentPages = pages.filter(page => !page.parentPageId);
    const childPages = pages.filter(page => page.parentPageId);

    // Get current path to determine active page context
    const currentPath = location.pathname;
    const currentPageSlug = currentPath.split('/')[1] || '';
    const currentPage = pages.find(page => page.slug === currentPageSlug);
    
    // Find all pages in the same parent group as current page
    const currentPageParentId = currentPage?.parentPageId;
    const currentPageIsParent = currentPage && childPages.some(child => child.parentPageId === currentPage.id);

    // Check if a page or its children are active
    const isPageActive = (page: Page): boolean => {
        if (page.slug === currentPageSlug) {
            return true;
        }
        if (currentPage?.parentPageId === page.id) {
            return true;
        }
        return false;
    };

    // Check if a section should be expanded (only if it contains the current page)
    const isSectionExpanded = (parentPage: Page): boolean => {
        // If we are viewing the parent page or any of its children
        return expandedMobileSections.has(parentPage.id) || 
               parentPage.slug === currentPageSlug || 
               (currentPage?.parentPageId === parentPage.id);
    };

    // Get children for a parent page
    const getChildPages = (parentId: string): Page[] => {
        return childPages.filter(page => page.parentPageId === parentId);
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
                {/* Standard non-page items that always show first */}
                <Link to="/gallery" className={`navbar-item ${currentPageSlug === 'gallery' ? 'active' : ''}`} onClick={handleMenuItemClick}>Gallery</Link>
                <Link to="/blog" className={`navbar-item ${currentPageSlug === 'blog' ? 'active' : ''}`} onClick={handleMenuItemClick}>Blog</Link>
                
                {/* Desktop View: Parent pages with dropdowns */}
                {!mobileMenuOpen && parentPages.map(page => {
                    // Check if this parent has children
                    const hasChildren = childPages.some(child => child.parentPageId === page.id);
                    const isActive = isPageActive(page);
                    
                    return hasChildren ? (
                        <div key={page.id} className="navbar-dropdown-container">
                            <div 
                                className={`navbar-item dropdown-toggle ${isActive ? 'active' : ''}`}
                                onClick={() => toggleDropdown(page.id)}
                            >
                                {page.title} <span className="dropdown-arrow">▼</span>
                            </div>
                            {activeDropdown === page.id && (
                                <div className="navbar-dropdown">
                                    <Link 
                                        to={`/${page.slug}`} 
                                        className={`navbar-dropdown-item ${page.slug === currentPageSlug ? 'active' : ''}`}
                                        onClick={handleMenuItemClick}
                                    >
                                        {page.title} (Overview)
                                    </Link>
                                    {getChildPages(page.id).map(child => (
                                        <Link 
                                            key={child.id} 
                                            to={`/${child.slug}`} 
                                            className={`navbar-dropdown-item ${child.slug === currentPageSlug ? 'active' : ''}`}
                                            onClick={handleMenuItemClick}
                                        >
                                            {child.title}
                                        </Link>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : (
                        <Link 
                            key={page.id} 
                            to={`/${page.slug}`} 
                            className={`navbar-item ${page.slug === currentPageSlug ? 'active' : ''}`}
                            onClick={handleMenuItemClick}
                        >
                            {page.title}
                        </Link>
                    );
                })}

                {/* Mobile View: Properly styled hierarchical navigation */}
                {mobileMenuOpen && parentPages.map(parentPage => {
                    const hasChildren = childPages.some(child => child.parentPageId === parentPage.id);
                    const isActive = isPageActive(parentPage);
                    const childrenPages = getChildPages(parentPage.id);
                    const shouldExpandSection = isSectionExpanded(parentPage);
                    
                    return (
                        <div key={parentPage.id} className="mobile-nav-section">
                            <div className="mobile-nav-item-wrapper">
                                <Link 
                                    to={`/${parentPage.slug}`}
                                    className={`navbar-item mobile-parent-item ${isActive ? 'active' : ''}`}
                                    onClick={handleMenuItemClick}
                                >
                                    {parentPage.title}
                                </Link>
                                {hasChildren && (
                                    <button 
                                        className="mobile-dropdown-toggle"
                                        onClick={(e) => toggleMobileSection(parentPage.id, e)}
                                        aria-label="Toggle submenu"
                                    >
                                        <span className={`mobile-parent-indicator ${shouldExpandSection ? 'expanded' : ''}`}>▼</span>
                                    </button>
                                )}
                            </div>
                            
                            {/* Only show children if we're in this section */}
                            {hasChildren && shouldExpandSection && (
                                <div className="mobile-children-container">
                                    {childrenPages.map(childPage => (
                                        <Link
                                            key={childPage.id}
                                            to={`/${childPage.slug}`}
                                            className={`navbar-item mobile-child-item ${childPage.slug === currentPageSlug ? 'active' : ''}`}
                                            onClick={handleMenuItemClick}
                                        >
                                            {childPage.title}
                                        </Link>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
                
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
