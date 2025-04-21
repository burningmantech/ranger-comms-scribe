import React, { useState, useEffect } from 'react';
import { API_URL } from '../config';
import { Page } from '../types';
import './PageManagement.css';
import { Editor, EditorState, RichUtils, convertToRaw, convertFromRaw, DraftHandleValue, Modifier } from 'draft-js';
import { stateToHTML } from 'draft-js-export-html';

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

  const [newPageEditorState, setNewPageEditorState] = useState<EditorState>(() => EditorState.createEmpty());
  const [editingPageEditorState, setEditingPageEditorState] = useState<EditorState>(() => EditorState.createEmpty());
  const [showGalleryModal, setShowGalleryModal] = useState(false);
  const [galleryImages, setGalleryImages] = useState<any[]>([]);

  const getRawContent = (state: EditorState) => JSON.stringify(convertToRaw(state.getCurrentContent()));
  const getEditorStateFromRaw = (raw: string) => {
    try {
      return EditorState.createWithContent(convertFromRaw(JSON.parse(raw)));
    } catch {
      return EditorState.createEmpty();
    }
  };
  const getHTMLFromEditorState = (state: EditorState) => stateToHTML(state.getCurrentContent());

  const handleKeyCommand = (command: string, state: EditorState, setState: (s: EditorState) => void): DraftHandleValue => {
    const newState = RichUtils.handleKeyCommand(state, command);
    if (newState) {
      setState(newState);
      return 'handled';
    }
    return 'not-handled';
  };
  const onTab = (
    e: any, // Accept any type to satisfy both React and draft-js
    state: EditorState,
    setState: (s: EditorState) => void
  ) => {
    setState(RichUtils.onTab(e, state, 4));
  };
  const toggleBlockType = (blockType: string, state: EditorState, setState: (s: EditorState) => void) => {
    setState(RichUtils.toggleBlockType(state, blockType));
  };
  const toggleInlineStyle = (inlineStyle: string, state: EditorState, setState: (s: EditorState) => void) => {
    setState(RichUtils.toggleInlineStyle(state, inlineStyle));
  };
  const promptForLink = (state: EditorState, setState: (s: EditorState) => void) => {
    const selection = state.getSelection();
    const url = window.prompt('Enter a URL');
    if (!url) return;
    const content = state.getCurrentContent();
    const contentWithEntity = content.createEntity('LINK', 'MUTABLE', { url });
    const entityKey = contentWithEntity.getLastCreatedEntityKey();
    let newState = EditorState.set(state, { currentContent: contentWithEntity });
    newState = RichUtils.toggleLink(newState, selection, entityKey);
    setState(newState);
  };
  const insertImage = (src: string, state: EditorState, setState: (s: EditorState) => void) => {
    const contentState = state.getCurrentContent();
    const contentStateWithEntity = contentState.createEntity('IMAGE', 'IMMUTABLE', { src });
    const entityKey = contentStateWithEntity.getLastCreatedEntityKey();
    let newContentState = Modifier.insertText(
      contentStateWithEntity,
      state.getSelection(),
      ' ',
      undefined,
      entityKey
    );
    setState(EditorState.push(state, newContentState, 'insert-characters'));
  };
  const openGalleryModal = async () => {
    setShowGalleryModal(true);
    try {
      const res = await fetch(`${API_URL}/gallery`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('sessionId')}` }
      });
      if (res.ok) {
        const data = await res.json();
        setGalleryImages(data.filter((img: any) => img.fileType && img.fileType.startsWith('image/')));
      }
    } catch {}
  };
  const closeGalleryModal = () => setShowGalleryModal(false);
  const handleGalleryImageSelect = (img: any) => {
    if (editingPage) {
      insertImage(img.url, editingPageEditorState, setEditingPageEditorState);
    } else {
      insertImage(img.url, newPageEditorState, setNewPageEditorState);
    }
    setShowGalleryModal(false);
  };

  useEffect(() => {
    fetchPages();
  }, []);

  useEffect(() => {
    if (editingPage) {
      setEditingPageEditorState(getEditorStateFromRaw(editingPage.content));
    }
  }, [editingPage]);

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
      if (!newPage.title.trim() || !newPage.slug.trim()) {
        setError('Title and slug are required');
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
        body: JSON.stringify({
          ...newPage,
          content: getRawContent(newPageEditorState)
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create page');
      }
      
      const data = await response.json();
      
      if (data.success && data.page) {
        setPages([...pages, data.page]);
        
        setNewPage({
          title: '',
          slug: '',
          content: '',
          published: false,
          isPublic: true,
          showInNavigation: true
        });
        setNewPageEditorState(EditorState.createEmpty());
        
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
          ...editingPage,
          content: getRawContent(editingPageEditorState)
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update page');
      }
      
      const data = await response.json();
      
      if (data.success && data.page) {
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
    
    if ((direction === 'up' && pageIndex === 0) || 
        (direction === 'down' && pageIndex === pages.length - 1)) {
      return;
    }
    
    const newPages = [...pages];
    const swapIndex = direction === 'up' ? pageIndex - 1 : pageIndex + 1;
    
    const tempOrder = newPages[pageIndex].order;
    newPages[pageIndex].order = newPages[swapIndex].order;
    newPages[swapIndex].order = tempOrder;
    
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
              <label>Content:</label>
              <div className="draftjs-editor-container">
                <div className="editor-toolbar">
                  <button type="button" onClick={() => toggleInlineStyle('BOLD', editingPageEditorState, setEditingPageEditorState)}>Bold</button>
                  <button type="button" onClick={() => toggleInlineStyle('ITALIC', editingPageEditorState, setEditingPageEditorState)}>Italic</button>
                  <button type="button" onClick={() => toggleInlineStyle('UNDERLINE', editingPageEditorState, setEditingPageEditorState)}>Underline</button>
                  <button type="button" onClick={() => toggleBlockType('header-one', editingPageEditorState, setEditingPageEditorState)}>H1</button>
                  <button type="button" onClick={() => toggleBlockType('header-two', editingPageEditorState, setEditingPageEditorState)}>H2</button>
                  <button type="button" onClick={() => toggleBlockType('unordered-list-item', editingPageEditorState, setEditingPageEditorState)}>UL</button>
                  <button type="button" onClick={() => toggleBlockType('ordered-list-item', editingPageEditorState, setEditingPageEditorState)}>OL</button>
                  <button type="button" onClick={() => promptForLink(editingPageEditorState, setEditingPageEditorState)}>Link</button>
                  <button type="button" onClick={openGalleryModal}>Image</button>
                </div>
                <div className="editor-box" style={{border: '1px solid #ccc', minHeight: 120, padding: 8}}>
                  <Editor
                    editorState={editingPageEditorState}
                    onChange={setEditingPageEditorState}
                    handleKeyCommand={(cmd, state) => handleKeyCommand(cmd, state, setEditingPageEditorState)}
                    onTab={e => { e.preventDefault(); onTab(e, editingPageEditorState, setEditingPageEditorState); }}
                    placeholder="Write your page..."
                    spellCheck={true}
                  />
                </div>
                <div className="editor-preview">
                  <h4>Preview:</h4>
                  <div className="preview-content" dangerouslySetInnerHTML={{ __html: getHTMLFromEditorState(editingPageEditorState) }} />
                </div>
              </div>
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
                onClick={() => {
                  setEditingPage({
                    ...editingPage,
                    content: getRawContent(editingPageEditorState)
                  });
                  handleUpdatePage();
                }}
                className="save-button"
              >
                Save Changes
              </button>
            </div>
            {showGalleryModal && (
              <div className="modal" style={{zIndex: 1000, position: 'fixed', top:0, left:0, right:0, bottom:0, background: 'rgba(0,0,0,0.5)'}}>
                <div style={{background: '#fff', margin: '40px auto', padding: 20, maxWidth: 600, borderRadius: 8}}>
                  <h3>Select an image from the gallery</h3>
                  <div style={{display: 'flex', flexWrap: 'wrap', gap: 10, maxHeight: 300, overflowY: 'auto'}}>
                    {galleryImages.map(img => (
                      <img key={img.id} src={img.thumbnailUrl || img.url} alt={img.fileName} style={{width: 100, height: 100, objectFit: 'cover', cursor: 'pointer', border: '2px solid #eee'}} onClick={() => handleGalleryImageSelect(img)} />
                    ))}
                  </div>
                  <button onClick={closeGalleryModal} style={{marginTop: 20}}>Cancel</button>
                </div>
              </div>
            )}
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
              <label>Content:</label>
              <div className="draftjs-editor-container">
                <div className="editor-toolbar">
                  <button type="button" onClick={() => toggleInlineStyle('BOLD', newPageEditorState, setNewPageEditorState)}>Bold</button>
                  <button type="button" onClick={() => toggleInlineStyle('ITALIC', newPageEditorState, setNewPageEditorState)}>Italic</button>
                  <button type="button" onClick={() => toggleInlineStyle('UNDERLINE', newPageEditorState, setNewPageEditorState)}>Underline</button>
                  <button type="button" onClick={() => toggleBlockType('header-one', newPageEditorState, setNewPageEditorState)}>H1</button>
                  <button type="button" onClick={() => toggleBlockType('header-two', newPageEditorState, setNewPageEditorState)}>H2</button>
                  <button type="button" onClick={() => toggleBlockType('unordered-list-item', newPageEditorState, setNewPageEditorState)}>UL</button>
                  <button type="button" onClick={() => toggleBlockType('ordered-list-item', newPageEditorState, setNewPageEditorState)}>OL</button>
                  <button type="button" onClick={() => promptForLink(newPageEditorState, setNewPageEditorState)}>Link</button>
                  <button type="button" onClick={openGalleryModal}>Image</button>
                </div>
                <div className="editor-box" style={{border: '1px solid #ccc', minHeight: 120, padding: 8}}>
                  <Editor
                    editorState={newPageEditorState}
                    onChange={setNewPageEditorState}
                    handleKeyCommand={(cmd, state) => handleKeyCommand(cmd, state, setNewPageEditorState)}
                    onTab={e => { e.preventDefault(); onTab(e, newPageEditorState, setNewPageEditorState); }}
                    placeholder="Write your page..."
                    spellCheck={true}
                  />
                </div>
                <div className="editor-preview">
                  <h4>Preview:</h4>
                  <div className="preview-content" dangerouslySetInnerHTML={{ __html: getHTMLFromEditorState(newPageEditorState) }} />
                </div>
              </div>
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
              onClick={() => {
                setNewPage({
                  ...newPage,
                  content: getRawContent(newPageEditorState)
                });
                handleCreatePage();
              }}
              className="create-button"
            >
              Create Page
            </button>
            {showGalleryModal && (
              <div className="modal" style={{zIndex: 1000, position: 'fixed', top:0, left:0, right:0, bottom:0, background: 'rgba(0,0,0,0.5)'}}>
                <div style={{background: '#fff', margin: '40px auto', padding: 20, maxWidth: 600, borderRadius: 8}}>
                  <h3>Select an image from the gallery</h3>
                  <div style={{display: 'flex', flexWrap: 'wrap', gap: 10, maxHeight: 300, overflowY: 'auto'}}>
                    {galleryImages.map(img => (
                      <img key={img.id} src={img.thumbnailUrl || img.url} alt={img.fileName} style={{width: 100, height: 100, objectFit: 'cover', cursor: 'pointer', border: '2px solid #eee'}} onClick={() => handleGalleryImageSelect(img)} />
                    ))}
                  </div>
                  <button onClick={closeGalleryModal} style={{marginTop: 20}}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default PageManagement;
