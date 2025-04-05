import React, { useState, useEffect } from 'react';
import { API_URL } from '../config';
import { Page } from '../types';
import './PageManagement.css';

const PageManagement: React.FC = () => {
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [editingPage, setEditingPage] = useState<Page | null>(null);
  const [homePageExists, setHomePageExists] = useState<boolean>(false);
  const [newPage, setNewPage] = useState<{
    title: string;
    slug: string;
    content: string;
    published: boolean;
    isPublic: boolean;
    showInNavigation: boolean;
  }>({
    title: '',
    slug: '',
    content: '',
    published: false,
    isPublic: true,
    showInNavigation: true
  });
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchPages();
  }, []);

  const fetchPages = async () => {
    try {
      setLoading(true);
      const sessionId = localStorage.getItem('sessionId');
      
      if (!sessionId) {
        throw new Error('No session ID found');
      }
      
      const response = await fetch(`${API_URL}/page/all`, {
        headers: {
          Authorization: `Bearer ${sessionId}`
        }
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch pages');
      }
      
      const data = await response.json();
      setPages(data);
      
      // Check if home page exists
      const homePage = data.find((page: Page) => page.slug === 'home');
      setHomePageExists(!!homePage);
      
      setLoading(false);
    } catch (err) {
      console.error('Error fetching pages:', err);
      setError('Error loading pages');
      setLoading(false);
    }
  };

  const handleCreateHomePage = async () => {
    try {
      // Default content for home page
      const defaultHomeContent = `
        <h1>Welcome to Dancing Cat Wine Bar</h1>
        <p>Check out our <a href="/gallery">Gallery</a> and <a href="/blog">Blog</a>.</p>
      `;
      
      const homePageData = {
        title: 'Home',
        slug: 'home',
        content: defaultHomeContent,
        published: true,
        isPublic: true,
        showInNavigation: true
      };
      
      const sessionId = localStorage.getItem('sessionId');
      
      if (!sessionId) {
        throw new Error('No session ID found');
      }
      
      const response = await fetch(`${API_URL}/page`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`
        },
        body: JSON.stringify(homePageData)
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create home page');
      }
      
      const data = await response.json();
      
      // Add the new page to the list
      if (data.success && data.page) {
        setPages([...pages, data.page]);
        setHomePageExists(true);
        setSuccessMessage('Home page created successfully');
        setTimeout(() => setSuccessMessage(null), 3000);
      }
    } catch (err) {
      console.error('Error creating home page:', err);
      setError((err as Error).message);
      setTimeout(() => setError(null), 5000);
    }
  };

  const handleCreatePage = async () => {
    try {
      // Validate inputs
      if (!newPage.title.trim() || !newPage.slug.trim() || !newPage.content.trim()) {
        setError('Title, slug, and content are required');
        return;
      }
      
      const sessionId = localStorage.getItem('sessionId');
      
      if (!sessionId) {
        throw new Error('No session ID found');
      }
      
      const response = await fetch(`${API_URL}/page`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`
        },
        body: JSON.stringify(newPage)
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create page');
      }
      
      const data = await response.json();
      
      // Add the new page to the list
      if (data.success && data.page) {
        setPages([...pages, data.page]);
        
        // Reset the form
        setNewPage({
          title: '',
          slug: '',
          content: '',
          published: false,
          isPublic: true,
          showInNavigation: true
        });
        
        setSuccessMessage('Page created successfully');
        setTimeout(() => setSuccessMessage(null), 3000);
      }
    } catch (err) {
      console.error('Error creating page:', err);
      setError((err as Error).message);
      setTimeout(() => setError(null), 5000);
    }
  };

  const handleUpdatePage = async () => {
    if (!editingPage) return;
    
    try {
      const sessionId = localStorage.getItem('sessionId');
      
      if (!sessionId) {
        throw new Error('No session ID found');
      }
      
      const response = await fetch(`${API_URL}/page/${editingPage.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`
        },
        body: JSON.stringify({
          title: editingPage.title,
          slug: editingPage.slug,
          content: editingPage.content,
          published: editingPage.published,
          isPublic: editingPage.isPublic,
          showInNavigation: editingPage.showInNavigation
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update page');
      }
      
      const data = await response.json();
      
      if (data.success && data.page) {
        // Update the page in the list
        setPages(pages.map(page => 
          page.id === editingPage.id ? data.page : page
        ));
        
        setEditingPage(null);
        setSuccessMessage('Page updated successfully');
        setTimeout(() => setSuccessMessage(null), 3000);
      }
    } catch (err) {
      console.error('Error updating page:', err);
      setError((err as Error).message);
      setTimeout(() => setError(null), 5000);
    }
  };

  const handleDeletePage = async (pageId: string) => {
    if (!window.confirm('Are you sure you want to delete this page? This action cannot be undone.')) {
      return;
    }
    
    try {
      const sessionId = localStorage.getItem('sessionId');
      
      if (!sessionId) {
        throw new Error('No session ID found');
      }
      
      const response = await fetch(`${API_URL}/page/${pageId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${sessionId}`
        }
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to delete page');
      }
      
      // Remove the page from the list
      setPages(pages.filter(page => page.id !== pageId));
      setSuccessMessage('Page deleted successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      console.error('Error deleting page:', err);
      setError((err as Error).message);
      setTimeout(() => setError(null), 5000);
    }
  };

  const handleReorderPages = async (pageId: string, direction: 'up' | 'down') => {
    const pageIndex = pages.findIndex(page => page.id === pageId);
    if (pageIndex === -1) return;
    
    // Can't move first item up or last item down
    if ((direction === 'up' && pageIndex === 0) || 
        (direction === 'down' && pageIndex === pages.length - 1)) {
      return;
    }
    
    const newPages = [...pages];
    const swapIndex = direction === 'up' ? pageIndex - 1 : pageIndex + 1;
    
    // Swap the order values
    const tempOrder = newPages[pageIndex].order;
    newPages[pageIndex].order = newPages[swapIndex].order;
    newPages[swapIndex].order = tempOrder;
    
    // Swap the positions in the array
    [newPages[pageIndex], newPages[swapIndex]] = [newPages[swapIndex], newPages[pageIndex]];
    
    setPages(newPages);
    
    try {
      const sessionId = localStorage.getItem('sessionId');
      
      if (!sessionId) {
        throw new Error('No session ID found');
      }
      
      const response = await fetch(`${API_URL}/page/reorder`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`
        },
        body: JSON.stringify({
          pageOrders: [
            { id: newPages[pageIndex].id, order: newPages[pageIndex].order },
            { id: newPages[swapIndex].id, order: newPages[swapIndex].order }
          ]
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to reorder pages');
      }
    } catch (err) {
      console.error('Error reordering pages:', err);
      setError((err as Error).message);
      setTimeout(() => setError(null), 5000);
      
      // Revert the changes on error
      fetchPages();
    }
  };

  if (loading) {
    return <div>Loading pages...</div>;
  }

  return (
    <div className="page-management">
      <h2>Page Management</h2>
      
      {error && <div className="error">{error}</div>}
      {successMessage && <div className="success-message">{successMessage}</div>}
      
      <div className="page-management-sections">
        <div className="existing-pages">
          <h3>Existing Pages</h3>
          {!homePageExists && (
            <div className="home-page-notice">
              <p>No Home page found. The Home page is used for your site's landing page.</p>
              <button 
                onClick={handleCreateHomePage}
                className="create-home-button"
              >
                Create Home Page
              </button>
            </div>
          )}
          {pages.length === 0 ? (
            <p>No pages found. Create a new page to get started.</p>
          ) : (
            <div className="pages-list">
              {pages.map(page => (
                <div key={page.id} className={`page-item ${page.slug === 'home' ? 'home-page-item' : ''}`} style={{ cursor: 'default' }}>
                  <div className="page-info">
                    <h4>{page.title} {page.slug === 'home' && <span className="home-indicator">(Home Page)</span>}</h4>
                    <p><strong>Slug:</strong> /{page.slug}</p>
                    <p>
                      <strong>Status:</strong> {page.published ? 'Published' : 'Draft'} | 
                      <strong> Visibility:</strong> {page.isPublic ? 'Public' : 'Restricted'} | 
                      <strong> In Navigation:</strong> {page.showInNavigation ? 'Yes' : 'No'}
                    </p>
                  </div>
                  <div className="page-actions">
                    <button 
                      onClick={() => handleReorderPages(page.id, 'up')}
                      disabled={pages.indexOf(page) === 0}
                      className="move-button"
                    >
                      ↑
                    </button>
                    <button 
                      onClick={() => handleReorderPages(page.id, 'down')}
                      disabled={pages.indexOf(page) === pages.length - 1}
                      className="move-button"
                    >
                      ↓
                    </button>
                    <button 
                      onClick={() => setEditingPage(page)}
                      className="edit-button"
                    >
                      Edit
                    </button>
                    <button 
                      onClick={() => handleDeletePage(page.id)}
                      className="delete-button"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        
        {editingPage ? (
          <div className="edit-page-form">
            <h3>Edit Page</h3>
            <div className="form-group">
              <label htmlFor="editTitle">Title:</label>
              <input 
                type="text" 
                id="editTitle" 
                value={editingPage.title}
                onChange={(e) => setEditingPage({...editingPage, title: e.target.value})}
              />
            </div>
            <div className="form-group">
              <label htmlFor="editSlug">Slug:</label>
              <input 
                type="text" 
                id="editSlug" 
                value={editingPage.slug}
                onChange={(e) => setEditingPage({...editingPage, slug: e.target.value})}
              />
            </div>
            <div className="form-group">
              <label htmlFor="editContent">Content (HTML):</label>
              <textarea 
                id="editContent" 
                value={editingPage.content}
                onChange={(e) => setEditingPage({...editingPage, content: e.target.value})}
                rows={10}
              />
            </div>
            <div className="form-group checkbox-group">
              <label>
                <input 
                  type="checkbox" 
                  checked={editingPage.published}
                  onChange={(e) => setEditingPage({...editingPage, published: e.target.checked})}
                />
                Published
              </label>
            </div>
            <div className="form-group checkbox-group">
              <label>
                <input 
                  type="checkbox" 
                  checked={editingPage.isPublic}
                  onChange={(e) => setEditingPage({...editingPage, isPublic: e.target.checked})}
                />
                Public (unchecked = restricted to logged-in users)
              </label>
            </div>
            <div className="form-group checkbox-group">
              <label>
                <input 
                  type="checkbox" 
                  checked={editingPage.showInNavigation}
                  onChange={(e) => setEditingPage({...editingPage, showInNavigation: e.target.checked})}
                />
                Show in Navigation
              </label>
            </div>
            <div className="form-actions">
              <button 
                onClick={() => setEditingPage(null)}
                className="cancel-button"
              >
                Cancel
              </button>
              <button 
                onClick={handleUpdatePage}
                className="save-button"
              >
                Save Changes
              </button>
            </div>
          </div>
        ) : (
          <div className="create-page-form">
            <h3>Create New Page</h3>
            <div className="form-group">
              <label htmlFor="newTitle">Title:</label>
              <input 
                type="text" 
                id="newTitle" 
                value={newPage.title}
                onChange={(e) => setNewPage({...newPage, title: e.target.value})}
                placeholder="Enter page title"
              />
            </div>
            <div className="form-group">
              <label htmlFor="newSlug">Slug:</label>
              <input 
                type="text" 
                id="newSlug" 
                value={newPage.slug}
                onChange={(e) => setNewPage({...newPage, slug: e.target.value})}
                placeholder="Enter page slug (e.g. about-us)"
              />
              <small>This will be the URL path: /{newPage.slug}</small>
            </div>
            <div className="form-group">
              <label htmlFor="newContent">Content (HTML):</label>
              <textarea 
                id="newContent" 
                value={newPage.content}
                onChange={(e) => setNewPage({...newPage, content: e.target.value})}
                placeholder="Enter page content (HTML allowed)"
                rows={10}
              />
            </div>
            <div className="form-group checkbox-group">
              <label>
                <input 
                  type="checkbox" 
                  checked={newPage.published}
                  onChange={(e) => setNewPage({...newPage, published: e.target.checked})}
                />
                Published
              </label>
            </div>
            <div className="form-group checkbox-group">
              <label>
                <input 
                  type="checkbox" 
                  checked={newPage.isPublic}
                  onChange={(e) => setNewPage({...newPage, isPublic: e.target.checked})}
                />
                Public (unchecked = restricted to logged-in users)
              </label>
            </div>
            <div className="form-group checkbox-group">
              <label>
                <input 
                  type="checkbox" 
                  checked={newPage.showInNavigation}
                  onChange={(e) => setNewPage({...newPage, showInNavigation: e.target.checked})}
                />
                Show in Navigation
              </label>
            </div>
            <button 
              onClick={handleCreatePage}
              className="create-button"
            >
              Create Page
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default PageManagement;
