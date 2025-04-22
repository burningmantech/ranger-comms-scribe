import React, { useState, useEffect } from 'react';
import { API_URL } from '../config';
import { Page, User } from '../types';
import { Editor, EditorState, RichUtils, convertToRaw, convertFromRaw, DraftHandleValue, Modifier } from 'draft-js';
import { stateToHTML } from 'draft-js-export-html';

interface DynamicPageProps {
  slug: string;
  skipNavbar?: boolean;
}

const DynamicPage: React.FC<DynamicPageProps> = ({ slug, skipNavbar }) => {
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [editorState, setEditorState] = useState<EditorState>(() => EditorState.createEmpty());
  const [isEditing, setIsEditing] = useState(false);
  const [showGalleryModal, setShowGalleryModal] = useState(false);
  const [galleryImages, setGalleryImages] = useState<any[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [fullSizeImageUrl, setFullSizeImageUrl] = useState<string | null>(null);

  const getRawContent = (state: EditorState) => JSON.stringify(convertToRaw(state.getCurrentContent()));
  const getEditorStateFromRaw = (raw: string) => {
    try {
      return EditorState.createWithContent(convertFromRaw(JSON.parse(raw)));
    } catch {
      return EditorState.createEmpty();
    }
  };

  const getHTMLFromEditorState = (state: EditorState) => {
    const options = {
      entityStyleFn: (entity: any) => {
        const entityType = entity.get('type').toLowerCase();
        if (entityType === 'image') {
          const data = entity.getData();
          const fullSizeSrc = data.fullSizeSrc || data.src;
          return {
            element: 'img',
            attributes: {
              src: data.src,
              class: 'clickable-image',
              'data-full-src': fullSizeSrc,
              style: {
                maxWidth: '100%',
                cursor: 'pointer',
              },
              onClick: `(function(){
                const modal = document.createElement('div');
                modal.className = 'image-modal';
                modal.onclick = function() { document.body.removeChild(modal); };
                
                const img = document.createElement('img');
                img.src = '${fullSizeSrc}';
                img.className = 'image-modal-content';
                
                const closeBtn = document.createElement('span');
                closeBtn.className = 'image-modal-close';
                closeBtn.innerHTML = '×';
                
                modal.appendChild(img);
                modal.appendChild(closeBtn);
                document.body.appendChild(modal);
              })()`
            }
          };
        }
        return undefined; // Return undefined instead of null to match expected RenderConfig | undefined
      }
    };
    return stateToHTML(state.getCurrentContent(), options);
  };

  const handleKeyCommand = (command: string, state: EditorState): DraftHandleValue => {
    const newState = RichUtils.handleKeyCommand(state, command);
    if (newState) {
      setEditorState(newState);
      return 'handled';
    }
    return 'not-handled';
  };
  const onTab = (e: React.KeyboardEvent) => {
    setEditorState(RichUtils.onTab(e, editorState, 4));
  };
  const toggleBlockType = (blockType: string) => {
    setEditorState(RichUtils.toggleBlockType(editorState, blockType));
  };
  const toggleInlineStyle = (inlineStyle: string) => {
    setEditorState(RichUtils.toggleInlineStyle(editorState, inlineStyle));
  };
  const promptForLink = () => {
    const selection = editorState.getSelection();
    const url = window.prompt('Enter a URL');
    if (!url) return;
    const content = editorState.getCurrentContent();
    const contentWithEntity = content.createEntity('LINK', 'MUTABLE', { url });
    const entityKey = contentWithEntity.getLastCreatedEntityKey();
    let newState = EditorState.set(editorState, { currentContent: contentWithEntity });
    newState = RichUtils.toggleLink(newState, selection, entityKey);
    setEditorState(newState);
  };

  const insertImage = (src: string, mediumSrc: string) => {
    const contentState = editorState.getCurrentContent();
    const contentStateWithEntity = contentState.createEntity('IMAGE', 'IMMUTABLE', { 
      src: mediumSrc || src,
      fullSizeSrc: src,
      width: '100%',
      style: { maxWidth: '100%' },
      className: 'clickable-image'
    });
    
    const entityKey = contentStateWithEntity.getLastCreatedEntityKey();
    let newContentState = Modifier.insertText(
      contentStateWithEntity,
      editorState.getSelection(),
      '🖼️ ',
      undefined,
      entityKey
    );
    setEditorState(EditorState.push(editorState, newContentState, 'insert-characters'));
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
    const mediumUrl = img.mediumUrl || img.url;
    insertImage(img.url, mediumUrl);
    setShowGalleryModal(false);
  };

  useEffect(() => {
    fetchPage();
    const userJson = localStorage.getItem('user');
    if (userJson) {
      try {
        setUser(JSON.parse(userJson));
      } catch {}
    }

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
  }, [slug]);

  useEffect(() => {
    if (page && page.content && !isEditing) {
      setEditorState(getEditorStateFromRaw(page.content));
    }
  }, [page, isEditing]);

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
      </div>
    );
  }

  return (
    <div className="dynamic-page">
      <h1>{page.title}</h1>
      {isEditing ? (
        <>
          <div className="draftjs-editor-container">
            <div className="editor-toolbar">
              <button type="button" onClick={() => toggleInlineStyle('BOLD')}>Bold</button>
              <button type="button" onClick={() => toggleInlineStyle('ITALIC')}>Italic</button>
              <button type="button" onClick={() => toggleInlineStyle('UNDERLINE')}>Underline</button>
              <button type="button" onClick={() => toggleBlockType('header-one')}>H1</button>
              <button type="button" onClick={() => toggleBlockType('header-two')}>H2</button>
              <button type="button" onClick={() => toggleBlockType('unordered-list-item')}>UL</button>
              <button type="button" onClick={() => toggleBlockType('ordered-list-item')}>OL</button>
              <button type="button" onClick={promptForLink}>Link</button>
              <button type="button" onClick={openGalleryModal}>Image</button>
            </div>
            <div className="editor-box" style={{border: '1px solid #ccc', minHeight: 120, padding: 8}}>
              <Editor
                editorState={editorState}
                onChange={setEditorState}
                handleKeyCommand={handleKeyCommand}
                onTab={onTab}
                placeholder="Write your page..."
                spellCheck={true}
              />
            </div>
            <div className="editor-preview">
              <h4>Preview:</h4>
              <div className="preview-content" dangerouslySetInnerHTML={{ __html: getHTMLFromEditorState(editorState) }} />
            </div>
          </div>
          <div className="editor-actions" style={{ marginTop: '20px' }}>
            <button 
              onClick={async () => {
                setLoading(true);
                setError(null);
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
                      content: getRawContent(editorState),
                    }),
                  });
                  if (!response.ok) throw new Error('Failed to save page');
                  setIsEditing(false);
                  fetchPage();
                } catch (err) {
                  setError('Failed to save page');
                } finally {
                  setLoading(false);
                }
              }}
              style={{
                padding: '8px 16px',
                backgroundColor: '#4caf50',
                color: 'white',
                borderRadius: '4px',
                fontSize: '14px',
                border: 'none',
                cursor: 'pointer',
                marginRight: '10px'
              }}
            >
              Save
            </button>
            <button 
              onClick={() => setIsEditing(false)}
              style={{
                padding: '8px 16px',
                backgroundColor: '#f44336',
                color: 'white',
                borderRadius: '4px',
                fontSize: '14px',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              Cancel
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
        </>
      ) : (
        <>
          <div dangerouslySetInnerHTML={{ __html: getHTMLFromEditorState(getEditorStateFromRaw(page.content)) }} />
          {canEdit && (
            <button 
              onClick={() => setIsEditing(true)}
              style={{
                padding: '8px 16px',
                backgroundColor: '#4a90e2',
                color: 'white',
                borderRadius: '4px',
                fontSize: '14px',
                border: 'none',
                cursor: 'pointer',
                margin: '20px 0'
              }}
            >
              Edit Page
            </button>
          )}
        </>
      )}
      
      {fullSizeImageUrl && (
        <div 
          className="image-modal" 
          onClick={() => setFullSizeImageUrl(null)}
        >
          <img 
            src={fullSizeImageUrl} 
            className="image-modal-content" 
            alt="Full size" 
          />
          <span 
            className="image-modal-close" 
            onClick={() => setFullSizeImageUrl(null)}
          >
            ×
          </span>
        </div>
      )}
    </div>
  );
};

export default DynamicPage;
