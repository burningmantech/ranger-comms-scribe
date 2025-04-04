import React, { useState, useEffect } from 'react';
import Navbar from './Navbar';
import { API_URL } from '../config';
import { Page } from '../types';

interface DynamicPageProps {
  slug: string;
}

const DynamicPage: React.FC<DynamicPageProps> = ({ slug }) => {
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPage();
  }, [slug]);

  const fetchPage = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/page/${slug}`);
      
      if (!response.ok) {
        throw new Error('Failed to fetch page');
      }
      
      const data = await response.json();
      setPage(data);
      setLoading(false);
    } catch (err) {
      console.error(`Error fetching page ${slug}:`, err);
      setError('Error loading page');
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <>
        <Navbar />
        <div className="dynamic-page">
          <p>Loading...</p>
        </div>
      </>
    );
  }

  if (error || !page) {
    return (
      <>
        <Navbar />
        <div className="dynamic-page">
          <div className="error">{error || 'Page not found'}</div>
        </div>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <div className="dynamic-page">
        <h1>{page.title}</h1>
        <div dangerouslySetInnerHTML={{ __html: page.content }} />
      </div>
    </>
  );
};

export default DynamicPage;
