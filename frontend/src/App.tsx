import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import Blog from './components/Blog';
import Gallery from './components/Gallery';
import Login from './components/Login';
import Admin from './components/Admin';
import { User, Page } from './types';
import Home from './components/Home';
import { API_URL } from './config';
import DynamicPage from './components/DynamicPage';

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
      setLoading(false);
    } catch (err) {
      console.error('Error fetching pages:', err);
      setLoading(false);
    }
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/blog" element={<Blog isAdmin={isAdmin} />} />
        <Route path="/gallery" element={<Gallery isAdmin={isAdmin} />} />
        <Route path="/admin" element={<Admin />} />
        
        {/* Dynamic page routes */}
        {pages.map(page => (
          <Route 
            key={page.id} 
            path={`/${page.slug}`} 
            element={<DynamicPage slug={page.slug} />} 
          />
        ))}
        
        {/* Catch-all route for unknown pages */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
};

export default App;
