import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import Blog from './components/Blog';
import Gallery from './components/Gallery';
import Login from './components/Login';
import Admin from './components/Admin';
import UserSettings from './components/UserSettings';
import ResetPassword from './components/ResetPassword';
import VerifyEmail from './components/VerifyEmail';
import { User, Page } from './types';
import Home from './components/Home';
import { API_URL } from './config';
import DynamicPage from './components/DynamicPage';
import Navbar from './components/Navbar';
import { USER_LOGIN_EVENT } from './utils/userActions';
import PageManagement from './components/PageManagement';
import IndentationTest from './components/editor/tests/IndentationTest';

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    // Check if user is logged in
    const userJson = localStorage.getItem('user');
    if (userJson) {
      try {
        const userData = JSON.parse(userJson) as User;
        setUser(userData);
        setIsAdmin(userData.isAdmin === true || userData.userType === 'Admin');
      } catch (err) {
        console.error('Error parsing user data:', err);
      }
    }

    // Listen for login state changes
    const handleLoginStateChange = (event: CustomEvent<User | null>) => {
      const userData = event.detail;
      setUser(userData);
      setIsAdmin(userData?.isAdmin === true || userData?.userType === 'Admin');
    };

    window.addEventListener(USER_LOGIN_EVENT, handleLoginStateChange as EventListener);

    // Fetch published pages for navigation
    fetchPages();

    return () => {
      window.removeEventListener(USER_LOGIN_EVENT, handleLoginStateChange as EventListener);
    };
  }, []);

  const fetchPages = async () => {
    try {
      const response = await fetch(`${API_URL}/page`);
      
      if (!response.ok) {
        throw new Error('Failed to fetch pages');
      }
      
      const data = await response.json();
      
      // Store all pages but mark which ones should be shown in navigation
      setPages(data);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching pages:', err);
      setLoading(false);
    }
  };

  // Get pages to share with Navbar
  const getNavigationPages = () => {
    return pages.filter(page => page.published && page.showInNavigation && page.slug !== 'home');
  };

  return (
    <Router>
      <div className="app-container">
        {/* Pass navigation pages to Navbar to avoid duplicate fetching */}
        <Navbar navigationPages={getNavigationPages()} />
        
        <div className="content-container">
          {loading ? (
            <div className="loading-container">Loading...</div>
          ) : (
            <Routes>
              <Route path="/" element={<Home skipNavbar={true} />} />
              <Route path="/login" element={<Login skipNavbar={true} setParentUser={setUser} />} />
              <Route path="/blog" element={<Blog isAdmin={isAdmin} skipNavbar={true} />} />
              <Route path="/gallery" element={<Gallery isAdmin={isAdmin} skipNavbar={true} />} />
              <Route path="/admin" element={<Admin skipNavbar={true} />} />
              <Route path="/settings" element={<UserSettings skipNavbar={true} />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/verify-email" element={<VerifyEmail />} />
              <Route path="/page-management" element={<PageManagement />} />
              <Route path="/test-indentation" element={<IndentationTest />} />
              
              {/* Dynamic page routes - include all pages, not just navigation ones */}
              {pages.map(page => (
                <Route 
                  key={page.id} 
                  path={`/${page.slug}`} 
                  element={<DynamicPage slug={page.slug} skipNavbar={true} />} 
                />
              ))}
              
              {/* Create a catch-all dynamic page route that tries to load the page */}
              <Route 
                path="/:slug" 
                element={<DynamicPage slug="" skipNavbar={true} />} 
              />
              
              {/* Final catch-all if nothing else matches */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </div>
      </div>
    </Router>
  );
};

export default App;
