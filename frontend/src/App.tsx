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
        setIsAdmin(userData.isAdmin === true);
      } catch (err) {
        console.error('Error parsing user data:', err);
      }
    }

    // Listen for login state changes
    const handleLoginStateChange = (event: CustomEvent<User | null>) => {
      const userData = event.detail;
      setUser(userData);
      setIsAdmin(userData?.isAdmin === true);
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
      
      // Filter pages that should be shown in navigation
      const navPages = data.filter((page: Page) => 
        page.published && page.showInNavigation
      );
      
      setPages(navPages);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching pages:', err);
      setLoading(false);
    }
  };

  return (
    <Router>
      {/* Fixed position for navbar to prevent layout jumps */}
      <div className="app-container">
        {/* Navbar is included once for all routes */}
        <Navbar />
        
        {/* Add a placeholder with the same height as the navbar during loading */}
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
              
              {/* Dynamic page routes */}
              {pages.map(page => (
                <Route 
                  key={page.id} 
                  path={`/${page.slug}`} 
                  element={<DynamicPage slug={page.slug} skipNavbar={true} />} 
                />
              ))}
              
              {/* Catch-all route for unknown pages */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </div>
      </div>
    </Router>
  );
};

export default App;
