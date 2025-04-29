import React, { useState, useEffect } from 'react';
import { API_URL } from '../config';
import { Page, User } from '../types';
import { useParams, useNavigate } from 'react-router-dom';
import './DynamicPage.css';

// Import Lexical editor and related utilities
import LexicalEditorComponent from './editor/LexicalEditor';
import { isValidDraftJs } from './editor/utils/serialization';
import { LexicalEditor } from 'lexical';
import { INSERT_IMAGE_COMMAND } from './editor/plugins/ImagePlugin';
// Import the IndentationPlugin commands
import { INDENT_COMMAND, OUTDENT_COMMAND } from './editor/plugins/IndentationPlugin';

interface DynamicPageProps {
  slug?: string;
  skipNavbar?: boolean;
}

const DynamicPage: React.FC<DynamicPageProps> = ({ slug: propSlug, skipNavbar }) => {
  // Get slug from URL params if not provided as prop
  const { slug: urlSlug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  
  // Use the prop slug if provided, otherwise use the URL slug
  const slug = propSlug || urlSlug;
  
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  
  // Update editor state management for Lexical
  const [editorInstance, setEditorInstance] = useState<LexicalEditor | null>(null);
  const [contentAsJson, setContentAsJson] = useState('');

  const [isEditing, setIsEditing] = useState(false);
  const [showGalleryModal, setShowGalleryModal] = useState(false);
  const [galleryImages, setGalleryImages] = useState<any[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [fullSizeImageUrl, setFullSizeImageUrl] = useState<string | null>(null);
  
  // Page settings states
  const [isPublished, setIsPublished] = useState<boolean>(true);
  const [isPublic, setIsPublic] = useState<boolean>(true);
  const [showInNavigation, setShowInNavigation] = useState<boolean>(true);
  const [isHomePage, setIsHomePage] = useState<boolean>(false);
  const [parentPageId, setParentPageId] = useState<string>('');
  const [availablePages, setAvailablePages] = useState<Page[]>([]);

  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);

  // Handlers for Lexical editor
  const handleEditorChange = (editor: LexicalEditor, json: string) => {
    setEditorInstance(editor);
    setContentAsJson(json);
  };

  // Add key handler for indentation shortcuts
  useEffect(() => {
    // Add keyboard shortcuts for Cmd+[ and Cmd+] to control indentation
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!editorInstance || !isEditing) return;
      
      if (e.metaKey || e.ctrlKey) {
        if (e.key === ']') {
          e.preventDefault();
          editorInstance.dispatchCommand(INDENT_COMMAND, undefined);
        } else if (e.key === '[') {
          e.preventDefault();
          editorInstance.dispatchCommand(OUTDENT_COMMAND, undefined);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [editorInstance, isEditing]);

  // Handle image click for full-size view
  useEffect(() => {
    const handleImageClick = (event: any) => {
      const target = event.target;
      if (target.tagName === 'IMG' && target.dataset.fullSrc) {
        event.preventDefault();
        setFullSizeImageUrl(target.dataset.fullSrc);
      }
    };

    document.addEventListener('click', handleImageClick);

    return () => {
      document.removeEventListener('click', handleImageClick);
    };
  }, []);

  // Load user data and check permissions
  useEffect(() => {
    const userJson = localStorage.getItem('user');
    if (userJson) {
      try {
        setUser(JSON.parse(userJson));
      } catch(err) {
        console.error('Error parsing user data:', err);
      }
    }
  }, []);

  // Fetch page based on slug
  useEffect(() => {
    if (slug) {
      fetchPage(slug);
    } else if (urlSlug) {
      fetchPage(urlSlug);
    }
  }, [slug, urlSlug]);

  // Initialize page settings when entering edit mode
  useEffect(() => {
    if (isEditing && page) {
      // Initialize the page settings from the page object
      setIsPublished(page.published ?? true);
      setIsPublic(page.isPublic ?? true);
      setShowInNavigation(page.showInNavigation ?? true);
      setIsHomePage(page.isHome ?? false);
      setParentPageId(page.parentPageId || '');
      
      // Fetch all pages for parent selection
      fetchAllPages();

      // Fetch gallery images
      fetchGalleryImages();
    }
  }, [isEditing, page]);

  const fetchGalleryImages = async () => {
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) return;
      
      const response = await fetch(`${API_URL}/gallery`, {
        headers: {
          Authorization: `Bearer ${sessionId}`
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        setGalleryImages(data.filter((img: any) => img.fileType && img.fileType.startsWith('image/')));
      }
    } catch (err) {
      console.error('Error fetching gallery images:', err);
    }
  };

  // Fetch all pages for parent page selection
  const fetchAllPages = async () => {
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) return;
      
      const response = await fetch(`${API_URL}/page/all`, {
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch pages');
      }
      
      const data = await response.json();
      if (Array.isArray(data)) {
        setAvailablePages(data);
      } else {
        console.error('Expected array of pages but got:', data);
        setAvailablePages([]);
      }
    } catch (err) {
      console.error('Error fetching all pages:', err);
      setAvailablePages([]);
    }
  };

  const fetchPage = async (pageSlug: string) => {
    try {
      setLoading(true);
      setError(null); // Clear previous errors
      
      // Get the session ID from localStorage if available
      const sessionId = localStorage.getItem('sessionId');
      const headers: HeadersInit = {};
      
      // Add authorization header if session ID exists
      if (sessionId) {
        headers['Authorization'] = `Bearer ${sessionId}`;
      }
      
      const response = await fetch(`${API_URL}/page/${pageSlug}`, {
        headers
      });
      
      if (!response.ok) {
        if (response.status === 404) {
          setError(`Page "${pageSlug}" not found`);
        } else {
          setError('Failed to fetch page');
        }
        setLoading(false);
        return;
      }
      
      const data = await response.json();
      setPage(data);
    } catch (err) {
      console.error(`Error fetching page ${pageSlug}:`, err);
      setError('Error loading page');
    } finally {
      setLoading(false);
    }
  };

  const handleEnterEditMode = (e: React.MouseEvent) => {
    e.preventDefault(); // Prevent default navigation
    setIsEditing(true);
  };

  const openGalleryModal = () => {
    setShowGalleryModal(true);
  };

  const closeGalleryModal = () => setShowGalleryModal(false);

  const handleGalleryImageSelect = (img: any) => {
    const mediumUrl = img.mediumUrl || img.url;
    
    // Insert the image into Lexical editor
    if (editorInstance) {
      editorInstance.dispatchCommand(INSERT_IMAGE_COMMAND, {
        src: mediumUrl,
        altText: img.fileName || 'Gallery image',
        fullSizeSrc: img.url,
      });
      setShowGalleryModal(false);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    setSaveSuccess(false);
    
    // Add null check for page before using it
    if (!page) {
      setError('No page data available to save');
      setLoading(false);
      return;
    }
    
    try {
      const response = await fetch(`${API_URL}/page/${page.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        },
        body: JSON.stringify({
          title: page.title,
          slug: page.slug,
          content: contentAsJson,
          published: isPublished,
          isPublic: isPublic,
          showInNavigation: showInNavigation,
          parentPageId: parentPageId || undefined,
          isHome: isHomePage
        }),
      });

      if (!response.ok) throw new Error('Failed to save page');
      
      // If this page is set as home page, we need to reload all pages
      if (isHomePage) {
        await fetchAllPages();
      }
      
      setSaveSuccess(true);
      
      // Add null check for page before using page.slug
      // Store the slug in a variable to use even after state changes
      const currentSlug = page.slug;
      
      // Show success message briefly before refreshing
      setTimeout(() => {
        setIsEditing(false);
        // Force a full page refresh to ensure content is updated
        window.location.href = `/${currentSlug}`;
      }, 1000);
    } catch (err) {
      console.error('Error saving page:', err);
      setError('Failed to save page');
    } finally {
      setLoading(false);
    }
  };

  const canEdit = user && (user.isAdmin || user.userType === 'Admin' || user.userType === 'Lead');

  if (loading) {
    return (
      <div className="dynamic-page">
        <p>Loading...</p>
      </div>
    );
  }

  if (error || !page) {
    return (
      <div className="dynamic-page">
        <div className="error">{error || 'Page not found'}</div>
        {canEdit && (
          <div className="mt-2">
            <button 
              onClick={() => navigate('/page-management')}
              className="btn btn-primary"
            >
              Go to Page Management
            </button>
          </div>
        )}
      </div>
    );
  }

  // Determine if the content is in DraftJS format
  const isDraftContent = isValidDraftJs(page.content);

  return (
    <div className="dynamic-page">
      <h1>{page.title}</h1>
      {isEditing ? (
        <>
          <div className="lexical-editor-wrapper">
            <LexicalEditorComponent
              initialContent={page.content}
              onChange={handleEditorChange}
              showToolbar={true}
              placeholder="Edit page content..."
              onImageSelect={openGalleryModal}
              galleryImages={galleryImages}
            />
          </div>
            
          {/* Page Settings Section */}
          {canEdit && (
            <div className="page-settings-section mt-4">
              <h3>Page Settings</h3>
              <div className="card">
                <div className="card-body">
                  <div className="row">
                    <div className="col-md-6">
                      <div className="page-settings-group">
                        <h4>Visibility Settings</h4>
                        <div className="form-group">
                          <div className="custom-checkbox">
                            <input 
                              type="checkbox" 
                              id="published"
                              checked={isPublished}
                              onChange={(e) => setIsPublished(e.target.checked)}
                            />
                            <span className="checkbox-icon"></span>
                            <label htmlFor="published">
                              Publish page (when enabled, the page will be accessible to users)
                            </label>
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
                            <label htmlFor="isPublic">
                              Public access (when enabled, non-logged in visitors can view the page)
                            </label>
                          </div>
                        </div>

                        <div className="form-group">
                          <div className="custom-checkbox">
                            <input 
                              type="checkbox" 
                              id="showInNavigation"
                              checked={showInNavigation}
                              onChange={(e) => setShowInNavigation(e.target.checked)}
                            />
                            <span className="checkbox-icon"></span>
                            <label htmlFor="showInNavigation">
                              Show in navigation menu
                            </label>
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    <div className="col-md-6">
                      <div className="page-settings-group">
                        <h4>Page Hierarchy</h4>
                        <div className="form-group">
                          <label htmlFor="parentPage">Parent Page:</label>
                          <select 
                            id="parentPage" 
                            className="form-control"
                            value={parentPageId}
                            onChange={(e) => setParentPageId(e.target.value)}
                          >
                            <option value="">No parent page (top level)</option>
                            {availablePages
                              .filter(p => p.id !== page?.id && !p.isHome && 
                                          // Prevent circular references
                                          !(p.parentPageId === page?.id))
                              .map(p => (
                                <option key={p.id} value={p.id}>
                                  {p.title}
                                </option>
                              ))
                            }
                          </select>
                          <small>Select a parent page to create a hierarchical structure</small>
                        </div>
                      </div>
                      
                      <div className="page-settings-group mt-3">
                        <h4>Home Page Setting</h4>
                        <div className="form-group">
                          <div className="custom-radio">
                            <input 
                              type="radio" 
                              id="makeHomePageYes" 
                              name="isHomePage"
                              checked={isHomePage}
                              onChange={() => setIsHomePage(true)}
                              disabled={availablePages.some(p => p.isHome === true && p.id !== page?.id)}
                            />
                            <label htmlFor="makeHomePageYes">
                              Make this the home page
                            </label>
                          </div>
                          <div className="custom-radio">
                            <input 
                              type="radio" 
                              id="makeHomePageNo" 
                              name="isHomePage"
                              checked={!isHomePage}
                              onChange={() => setIsHomePage(false)}
                            />
                            <label htmlFor="makeHomePageNo">
                              Do not use as home page
                            </label>
                          </div>
                          {availablePages.some(p => p.isHome === true && p.id !== page?.id) && (
                            <p className="note text-warning">
                              Note: Another page is currently set as the home page. Setting this as the home page will replace the current home page.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          {saveSuccess && (
            <div className="success-message mt-2">
              <i className="fas fa-check-circle"></i> Page saved successfully! Redirecting...
            </div>
          )}
          <div className="btn-group mt-2">
            <button 
              onClick={handleSave}
              className="btn btn-tertiary"
              disabled={loading}
            >
              {loading ? (
                <><i className="fas fa-spinner fa-spin"></i> Saving...</>
              ) : (
                <><i className="fas fa-save"></i> Save</>
              )}
            </button>
            <button 
              onClick={() => setIsEditing(false)}
              className="btn btn-danger"
              disabled={loading}
            >
              <i className="fas fa-times"></i> Cancel
            </button>
          </div>
          {showGalleryModal && (
            <div className="modal-overlay">
              <div className="modal-content">
                <div className="modal-header">
                  <h3>Select an image from the gallery</h3>
                  <button onClick={closeGalleryModal} className="modal-close">×</button>
                </div>
                <div className="modal-body">
                  <div style={{display: 'flex', flexWrap: 'wrap', gap: 10, maxHeight: 300, overflowY: 'auto'}}>
                    {galleryImages.length > 0 ? (
                      galleryImages.map(img => (
                        <img key={img.id} src={img.thumbnailUrl || img.url} alt={img.fileName} style={{width: 100, height: 100, objectFit: 'cover', cursor: 'pointer', border: '2px solid #eee'}} onClick={() => handleGalleryImageSelect(img)} />
                      ))
                    ) : (
                      <p>No images found in gallery.</p>
                    )}
                  </div>
                </div>
                <div className="modal-footer">
                  <button onClick={closeGalleryModal} className="btn btn-neutral">Cancel</button>
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* For rendering the page content, we need a read-only Lexical editor instance */}
          <LexicalEditorComponent
            initialContent={page.content}
            showToolbar={false}
            readOnly={true}
            className="read-only-content"
          />
          
          {canEdit && (
            <button 
              onClick={handleEnterEditMode}
              className="btn btn-primary mt-2"
            >
              <i className="fas fa-edit"></i> Edit Page
            </button>
          )}
        </>
      )}
      
      {fullSizeImageUrl && (
        <div 
          className="modal-overlay" 
          onClick={() => setFullSizeImageUrl(null)}
        >
          <div className="modal-content">
            <img 
              src={fullSizeImageUrl} 
              className="image-modal-content" 
              alt="Full size" 
              style={{maxWidth: '100%'}}
            />
            <button 
              className="modal-close" 
              onClick={() => setFullSizeImageUrl(null)}
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DynamicPage;
