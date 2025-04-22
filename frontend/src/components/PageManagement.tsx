import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_URL } from '../config';
import './PageManagement.css';

// Rich text editor imports
import { Editor, EditorState, RichUtils, convertToRaw, convertFromRaw, Modifier } from 'draft-js';
import 'draft-js/dist/Draft.css';

interface Page {
  id: string;
  title: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  isHome?: boolean;
}

const PageManagement: React.FC = () => {
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [title, setTitle] = useState<string>('');
  const [slug, setSlug] = useState<string>('');
  const [isPublic, setIsPublic] = useState<boolean>(false);
  const [isHome, setIsHome] = useState<boolean>(false);
  const [editorState, setEditorState] = useState(EditorState.createEmpty());
  const [showImageGallery, setShowImageGallery] = useState<boolean>(false);
  const [galleryImages, setGalleryImages] = useState<string[]>([]);
  
  const navigate = useNavigate();

  useEffect(() => {
    fetchPages();
    fetchGalleryImages();
  }, []);

  const fetchPages = async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/page/all`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch pages');
      }

      const data = await response.json();
      // Check if the response is an array directly or has a pages property
      if (Array.isArray(data)) {
        console.log('Received pages array directly:', data);
        setPages(data);
      } else if (data && Array.isArray(data.pages)) {
        console.log('Received pages in data.pages:', data.pages);
        setPages(data.pages);
      } else {
        console.error('Expected array of pages but got:', data);
        setPages([]);
      }
      setLoading(false);
    } catch (err) {
      console.error('Error fetching pages:', err);
      setError('Error fetching pages');
      setPages([]);
      setLoading(false);
    }
  };

  const fetchGalleryImages = async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/gallery`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch gallery images');
      }

      const data = await response.json();
      // Add proper checks to ensure data is an array before mapping
      if (Array.isArray(data)) {
        setGalleryImages(data.map((img: any) => img.url || '').filter(Boolean));
      } else {
        console.error('Expected array of media items but got:', data);
        setGalleryImages([]);
      }
    } catch (err) {
      console.error('Error fetching gallery images:', err);
      setGalleryImages([]);
    }
  };

  const handleCreatePage = async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    if (!slug.trim()) {
      setError('Slug is required');
      return;
    }

    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      // Convert the editor state to raw content
      const content = JSON.stringify(convertToRaw(editorState.getCurrentContent()));

      const response = await fetch(`${API_URL}/page`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({
          title,
          slug,
          content,
          isPublic,
          isHome,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create page');
      }

      // Clear form and show success message
      setTitle('');
      setSlug('');
      setIsPublic(false);
      setIsHome(false);
      setEditorState(EditorState.createEmpty());
      setSuccess('Page created successfully');
      
      // Refresh pages list
      fetchPages();
      
      // Clear success message after 3 seconds
      setTimeout(() => {
        setSuccess(null);
      }, 3000);
    } catch (err) {
      setError(`Error creating page: ${(err as Error).message}`);
    }
  };

  const handleDeletePage = async (pageId: string) => {
    if (!window.confirm('Are you sure you want to delete this page? This action cannot be undone.')) {
      return;
    }

    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/page/${pageId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to delete page');
      }

      // Remove deleted page from state
      setPages(pages.filter(page => page.id !== pageId));
      setSuccess('Page deleted successfully');
      
      setTimeout(() => {
        setSuccess(null);
      }, 3000);
    } catch (err) {
      setError('Error deleting page');
    }
  };

  const handleMakeHomePage = async (pageId: string) => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/page/${pageId}/make-home`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to set home page');
      }

      // Update pages list to reflect the new home page
      setPages(pages.map(page => ({
        ...page,
        isHome: page.id === pageId,
      })));
      
      setSuccess('Home page updated successfully');
      
      setTimeout(() => {
        setSuccess(null);
      }, 3000);
    } catch (err) {
      setError('Error setting home page');
    }
  };

  const handleSlugChange = (value: string) => {
    // Convert to lowercase and replace spaces with hyphens
    const formattedSlug = value
      .toLowerCase()
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/[^a-z0-9-]/g, ''); // Remove special characters
    
    setSlug(formattedSlug);
  };

  const generateSlugFromTitle = () => {
    handleSlugChange(title);
  };

  // Rich text editor functions
  const handleEditorChange = (state: EditorState) => {
    setEditorState(state);
  };

  const handleKeyCommand = (command: string, editorState: EditorState) => {
    const newState = RichUtils.handleKeyCommand(editorState, command);
    if (newState) {
      handleEditorChange(newState);
      return 'handled';
    }
    return 'not-handled';
  };

  const toggleInlineStyle = (style: string) => {
    handleEditorChange(
      RichUtils.toggleInlineStyle(editorState, style)
    );
  };

  const toggleBlockType = (blockType: string) => {
    handleEditorChange(
      RichUtils.toggleBlockType(editorState, blockType)
    );
  };

  const insertImage = (imageUrl: string) => {
    // For this simplified version, we'll just add the URL as text
    // In a real implementation, you'd use an entity or custom block
    const currentContent = editorState.getCurrentContent();
    const selection = editorState.getSelection();
    const contentWithEntity = currentContent.createEntity(
      'IMAGE',
      'IMMUTABLE',
      { src: imageUrl }
    );
    const entityKey = contentWithEntity.getLastCreatedEntityKey();
    const textWithEntity = Modifier.insertText(
      contentWithEntity,
      selection,
      `![Image](${imageUrl})`,
      undefined,
      entityKey
    );
    const newEditorState = EditorState.push(
      editorState,
      textWithEntity,
      'insert-characters'
    );
    setEditorState(newEditorState);
    setShowImageGallery(false);
  };

  if (loading) {
    return <div>Loading pages...</div>;
  }

  return (
    <div className="page-management">
      <h2>Page Management</h2>
      
      {error && <div className="error-message">{error}</div>}
      {success && <div className="success-message">{success}</div>}
      
      <div className="page-management-sections">
        <div className="existing-pages card">
          <div className="card-header">
            <h3>Existing Pages</h3>
          </div>
          <div className="card-body">
            {pages.length === 0 ? (
              <p>No pages found. Create your first page using the form.</p>
            ) : (
              <div className="pages-list">
                {pages.map(page => (
                  <div 
                    key={page.id} 
                    className={`page-item ${page.isHome ? 'home-page-item' : ''}`}
                  >
                    <div className="page-info">
                      <h4>
                        {page.title}
                        {page.isHome && <span className="home-indicator">Home</span>}
                      </h4>
                      <p>Slug: /{page.slug}</p>
                      <p>Created: {new Date(page.createdAt).toLocaleDateString()}</p>
                    </div>
                    <div className="btn-group">
                      {!page.isHome && (
                        <button 
                          onClick={() => handleMakeHomePage(page.id)}
                          className="btn btn-tertiary btn-sm"
                          title="Set as home page"
                        >
                          Set Home
                        </button>
                      )}
                      <button 
                        onClick={() => navigate(`/admin/pages/edit/${page.id}`)}
                        className="btn btn-secondary btn-sm"
                      >
                        Edit
                      </button>
                      <button 
                        onClick={() => handleDeletePage(page.id)}
                        className="btn btn-danger btn-sm"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        
        <div className="create-page-form card">
          <div className="card-header">
            <h3>Create New Page</h3>
          </div>
          <div className="card-body">
            <div className="form-group">
              <label htmlFor="title">Title:</label>
              <input 
                type="text" 
                id="title" 
                className="form-control"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  // Optionally auto-generate slug if user wants
                  // generateSlugFromTitle();
                }}
                placeholder="Enter page title"
              />
            </div>
            
            <div className="form-group">
              <label htmlFor="slug">Slug:</label>
              <div className="d-flex gap-1 align-items-center">
                <input 
                  type="text" 
                  id="slug" 
                  className="form-control"
                  value={slug}
                  onChange={(e) => handleSlugChange(e.target.value)}
                  placeholder="enter-page-slug"
                />
                <button 
                  onClick={generateSlugFromTitle} 
                  className="btn btn-tertiary"
                  type="button"
                >
                  Generate from Title
                </button>
              </div>
              <small>The slug will be used in the URL: /page/your-slug</small>
            </div>
            
            <div className="form-group">
              <label>Page Content:</label>
              <div className="rich-editor-container">
                <div className="editor-toolbar">
                  <button 
                    className={`btn btn-sm ${editorState.getCurrentInlineStyle().has('BOLD') ? 'btn-tertiary' : 'btn-neutral'}`}
                    onClick={() => toggleInlineStyle('BOLD')}
                    title="Bold"
                  >
                    B
                  </button>
                  <button 
                    className={`btn btn-sm ${editorState.getCurrentInlineStyle().has('ITALIC') ? 'btn-tertiary' : 'btn-neutral'}`}
                    onClick={() => toggleInlineStyle('ITALIC')}
                    title="Italic"
                  >
                    I
                  </button>
                  <button 
                    className={`btn btn-sm ${editorState.getCurrentInlineStyle().has('UNDERLINE') ? 'btn-tertiary' : 'btn-neutral'}`}
                    onClick={() => toggleInlineStyle('UNDERLINE')}
                    title="Underline"
                  >
                    U
                  </button>
                  <button 
                    className="btn btn-sm btn-neutral"
                    onClick={() => toggleBlockType('header-one')}
                    title="Heading 1"
                  >
                    H1
                  </button>
                  <button 
                    className="btn btn-sm btn-neutral"
                    onClick={() => toggleBlockType('header-two')}
                    title="Heading 2"
                  >
                    H2
                  </button>
                  <button 
                    className="btn btn-sm btn-neutral"
                    onClick={() => toggleBlockType('header-three')}
                    title="Heading 3"
                  >
                    H3
                  </button>
                  <button 
                    className="btn btn-sm btn-neutral"
                    onClick={() => toggleBlockType('unordered-list-item')}
                    title="Bullet List"
                  >
                    • List
                  </button>
                  <button 
                    className="btn btn-sm btn-neutral"
                    onClick={() => toggleBlockType('ordered-list-item')}
                    title="Numbered List"
                  >
                    1. List
                  </button>
                  <button 
                    className="btn btn-sm btn-tertiary"
                    onClick={() => setShowImageGallery(true)}
                    title="Insert Image"
                  >
                    🖼️ Image
                  </button>
                </div>
                <div className="editor-content">
                  <Editor 
                    editorState={editorState}
                    onChange={handleEditorChange}
                    handleKeyCommand={handleKeyCommand}
                    placeholder="Write your page content here..."
                  />
                </div>
              </div>
            </div>
            
            <div className="form-group">
              <div className="custom-checkbox">
                <input 
                  type="checkbox" 
                  id="isPublic"
                  checked={isPublic}
                  onChange={(e) => setIsPublic(e.target.checked)}
                />
                <span className="checkbox-icon"></span>
                <label htmlFor="isPublic">Make this page public (visible to non-logged in users)</label>
              </div>
            </div>
            
            {!pages.some(page => page.isHome) && (
              <div className="form-group">
                <div className="custom-checkbox">
                  <input 
                    type="checkbox"
                    id="isHome" 
                    checked={isHome}
                    onChange={(e) => setIsHome(e.target.checked)}
                  />
                  <span className="checkbox-icon"></span>
                  <label htmlFor="isHome">Set as home page</label>
                </div>
              </div>
            )}
          </div>
          <div className="card-footer">
            <button 
              onClick={handleCreatePage}
              className="btn btn-primary"
            >
              Create Page
            </button>
          </div>
        </div>
      </div>

      {/* Image Gallery Modal */}
      {showImageGallery && (
        <div className="modal-overlay" onClick={() => setShowImageGallery(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Select an Image</h3>
              <button className="modal-close" onClick={() => setShowImageGallery(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="gallery-modal-grid">
                {galleryImages.length === 0 ? (
                  <p>No images available. Upload images in the Gallery section first.</p>
                ) : (
                  galleryImages.map((imageUrl, index) => (
                    <div 
                      key={index} 
                      className="gallery-image-item clickable"
                      onClick={() => insertImage(imageUrl)}
                    >
                      <img src={imageUrl} alt={`Gallery image ${index}`} />
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-neutral" onClick={() => setShowImageGallery(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PageManagement;
