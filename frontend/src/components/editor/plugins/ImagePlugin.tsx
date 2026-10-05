import React, { useCallback, useState, useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { DRAG_DROP_PASTE } from '@lexical/rich-text';
import {
  $createParagraphNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_LOW,
  LexicalNode,
  PASTE_COMMAND,
  RangeSelection,
  createCommand,
} from 'lexical';
import {
  $createImageNode,
  $createPendingImageNode,
  $getPendingImageNodes,
  $hoistImageFromTextBlock,
  $isImageNode,
  ImageNode,
} from '../nodes/ImageNode';
import { MediaItem } from '../../../types/index';
import { API_URL } from '../../../config';
import {
  IMAGE_IMPORT_TIMEOUT_MS,
  PENDING_IMAGE_STALE_MS,
  PendingImageSource,
  registerPendingImageSource,
  resolveImageSource,
  takePendingImageSource,
  uploadImageToGallery,
} from '../utils/imageImport';

export const INSERT_IMAGE_COMMAND = createCommand('insertImage');

export interface ImagePluginProps {
  onImageSelect?: () => void;
  currentUser?: any;
}

/**
 * Insert an image as its own block after the caret's top-level block (or in place of an
 * empty paragraph), with the caret in a paragraph after it.
 */
export function $insertImageBlock(imageNode: ImageNode): void {
  const root = $getRoot();
  const selection = $getSelection();
  let top: LexicalNode | null = $isRangeSelection(selection) ? selection.anchor.getNode() : null;
  while (top && top.getParent() && top.getParent() !== root) {
    top = top.getParent();
  }

  if (!top || top === root) {
    root.append(imageNode);
  } else if ($isParagraphNode(top) && top.isEmpty()) {
    top.insertBefore(imageNode);
    top.selectStart();
    return;
  } else {
    top.insertAfter(imageNode);
  }
  const paragraph = $createParagraphNode();
  imageNode.insertAfter(paragraph);
  paragraph.select();
}

/** Clipboard HTML that is nothing but images ("Copy image" in a browser). */
function isImageOnlyHtml(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.querySelector('img') !== null && (doc.body.textContent || '').trim() === '';
}

/**
 * Images in the editor:
 * - the toolbar's upload / gallery dialog (INSERT_IMAGE_COMMAND);
 * - pasted HTML: Lexical's own paste imports `<img>` through ImageNode.importDOM, which
 *   makes a placeholder for every non-gallery image; this plugin uploads a copy of each
 *   (data: URLs directly, https images through the backend import) and swaps it in;
 * - a pasted screenshot or dropped image files (DRAG_DROP_PASTE): same placeholder flow.
 * Only the client that created a placeholder uploads it. Placeholders that fail are removed
 * with one notice; orphans (their uploader left) are removed once stale.
 */
export function ImagePlugin({ currentUser }: ImagePluginProps) {
  const [editor] = useLexicalComposerContext();
  const [showImageDialog, setShowImageDialog] = useState(false);
  const [showGalleryDialog, setShowGalleryDialog] = useState(false);
  const [galleryImages, setGalleryImages] = useState<MediaItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Ref to save cursor selection when opening the image dialog (editor loses focus)
  const savedSelectionRef = useRef<RangeSelection | null>(null);

  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;

  // Non-blocking notice; hides itself.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Image upload from the dialog
  const handleImageUpload = useCallback(async (file: File) => {
    if (!currentUser) {
      setNotice('Sign in to upload images.');
      return;
    }
    setIsUploading(true);
    try {
      const uploader = currentUser.name || currentUser.email;
      const result = await uploadImageToGallery(file, uploader);
      editor.dispatchCommand(INSERT_IMAGE_COMMAND, {
        src: result.url,
        altText: result.fileName,
        fullSizeSrc: result.url,
        thumbnailSrc: result.thumbnailUrl,
        mediumSrc: result.mediumUrl,
        imageId: result.id,
        uploadedBy: uploader,
        uploadedAt: new Date().toISOString()
      });
      setShowImageDialog(false);
    } catch (error) {
      console.error('Error uploading image:', error);
      setNotice("The image couldn't be uploaded.");
    } finally {
      setIsUploading(false);
    }
  }, [currentUser, editor]);

  // Pasted / dropped images: placeholders, uploads, swaps and cleanup.
  useEffect(() => {
    const inFlight = new Set<string>();
    let sweepTimer: ReturnType<typeof setTimeout> | null = null;
    let sweepAt = Infinity;

    const $findPlaceholder = (id: string): ImageNode | undefined =>
      $getPendingImageNodes().find((node) => node.getImageId() === id);

    const importImage = async (id: string, source: PendingImageSource): Promise<boolean> => {
      inFlight.add(id);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IMAGE_IMPORT_TIMEOUT_MS);
      try {
        const user = currentUserRef.current;
        if (!user) throw new Error('Not signed in');
        const uploader = user.name || user.email;
        const file = await resolveImageSource(source, controller.signal);
        const uploaded = await uploadImageToGallery(file, uploader, controller.signal);
        // An ordinary local edit, so it syncs (Yjs) and saves like any other.
        editor.update(() => {
          $findPlaceholder(id)?.completeImport({
            src: uploaded.url,
            fullSizeSrc: uploaded.url,
            thumbnailSrc: uploaded.thumbnailUrl,
            mediumSrc: uploaded.mediumUrl,
            imageId: uploaded.id,
            uploadedBy: uploader,
            uploadedAt: new Date().toISOString(),
          });
        });
        return true;
      } catch (error) {
        console.warn('[images] Could not import an image', error);
        editor.update(() => {
          $findPlaceholder(id)?.remove();
        });
        return false;
      } finally {
        clearTimeout(timer);
        inFlight.delete(id);
      }
    };

    // Remove placeholders nobody is finishing (another client's that went stale, or one
    // loaded from saved content). Bookkeeping, not a user edit: 'history-merge' keeps it
    // out of undo and change tracking. Read-only editors leave it (the node renders hidden).
    const sweepStale = () => {
      sweepTimer = null;
      sweepAt = Infinity;
      const now = Date.now();
      const stale: string[] = [];
      let nextDue = Infinity;
      editor.getEditorState().read(() => {
        for (const node of $getPendingImageNodes()) {
          if (inFlight.has(node.getImageId() || '')) continue;
          if (node.isStalePending(now)) stale.push(node.getKey());
          else nextDue = Math.min(nextDue, (node.getPendingSince() || 0) + PENDING_IMAGE_STALE_MS);
        }
      });
      if (stale.length > 0 && editor.isEditable()) {
        editor.update(() => {
          for (const key of stale) $getNodeByKey(key)?.remove();
        }, { tag: 'history-merge' });
      }
      if (nextDue !== Infinity) scheduleSweep(nextDue);
    };
    const scheduleSweep = (at: number) => {
      if (at >= sweepAt) return;
      if (sweepTimer) clearTimeout(sweepTimer);
      sweepAt = at;
      sweepTimer = setTimeout(sweepStale, Math.max(0, at - Date.now()) + 1000);
    };

    const removeMutationListener = editor.registerMutationListener(ImageNode, (mutations) => {
      const claimed: Array<[string, PendingImageSource]> = [];
      editor.getEditorState().read(() => {
        mutations.forEach((mutation, key) => {
          if (mutation !== 'created') return;
          const node = $getNodeByKey(key);
          if (!$isImageNode(node) || !node.isPending()) return;
          const id = node.getImageId() || '';
          const source = takePendingImageSource(id);
          if (source) {
            claimed.push([id, source]);
          } else if (!inFlight.has(id)) {
            scheduleSweep((node.getPendingSince() || 0) + PENDING_IMAGE_STALE_MS);
          }
        });
      });
      if (claimed.length > 0) {
        Promise.all(claimed.map(([id, source]) => importImage(id, source))).then((results) => {
          const failed = results.filter((ok) => !ok).length;
          if (failed > 0) setNotice(`${failed} image${failed === 1 ? '' : 's'} couldn't be imported.`);
        });
      }
    });

    return () => {
      removeMutationListener();
      if (sweepTimer) clearTimeout(sweepTimer);
    };
  }, [editor]);

  // Register command listeners
  useEffect(() => {
    const removeInsertImageCommand = editor.registerCommand(
      INSERT_IMAGE_COMMAND,
      (payload: any) => {
        // Handle toolbar request to show the upload dialog
        if (payload && payload.showDialog) {
          // Save current selection so we can restore it after the dialog closes
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            savedSelectionRef.current = selection.clone() as RangeSelection;
          }
          setShowImageDialog(true);
          return true;
        }

        const imageNode = $createImageNode({
          src: payload.src || payload.url,
          altText: payload.altText || payload.alt || '',
          width: payload.width,
          height: payload.height,
          fullSizeSrc: payload.fullSizeSrc,
          thumbnailSrc: payload.thumbnailSrc,
          mediumSrc: payload.mediumSrc,
          imageId: payload.imageId,
          uploadedBy: payload.uploadedBy,
          uploadedAt: payload.uploadedAt
        });

        // Restore saved selection if current selection is lost (e.g. after dialog interaction)
        if (!$isRangeSelection($getSelection()) && savedSelectionRef.current) {
          $setSelection(savedSelectionRef.current);
        }
        savedSelectionRef.current = null;
        $insertImageBlock(imageNode);
        return true;
      },
      COMMAND_PRIORITY_EDITOR
    );

    // Pasted screenshots and dropped image files (RichTextPlugin dispatches DRAG_DROP_PASTE
    // for clipboard files without text, and for file drops after moving the caret there).
    const removeDragDropPaste = editor.registerCommand(
      DRAG_DROP_PASTE,
      (files: File[]) => {
        const images = files.filter((file) => file.type.startsWith('image/'));
        if (images.length === 0) return false;
        for (const file of images) {
          const placeholder = $createPendingImageNode({ altText: file.name });
          registerPendingImageSource(placeholder.getImageId()!, { kind: 'file', file });
          $insertImageBlock(placeholder);
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR
    );

    // "Copy image" in a browser puts the image file and `<img src>` HTML on the clipboard;
    // RichTextPlugin would paste the HTML, whose URL may not be fetchable. Use the file.
    // Everything else falls through to RichTextPlugin's paste.
    const removePaste = editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        const data = 'clipboardData' in event ? event.clipboardData : null;
        if (!data || data.types.includes('application/x-lexical-editor')) return false;
        const files = Array.from(data.files).filter((file) => file.type.startsWith('image/'));
        const html = data.getData('text/html');
        if (files.length === 0 || !html || !isImageOnlyHtml(html)) return false;
        event.preventDefault();
        editor.dispatchCommand(DRAG_DROP_PASTE, files);
        return true;
      },
      COMMAND_PRIORITY_LOW
    );

    // Pasted HTML puts images inside paragraphs; make them blocks.
    const removeHoist = editor.registerNodeTransform(ImageNode, $hoistImageFromTextBlock);

    return () => {
      removeInsertImageCommand();
      removeDragDropPaste();
      removePaste();
      removeHoist();
    };
  }, [editor]);

  // Load gallery images
  const loadGalleryImages = useCallback(async () => {
    
    try {
      // Get session ID for authentication
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) {
        console.error('❌ No session ID found - cannot load gallery');
        return;
      }
      
      const response = await fetch(`${API_URL}/gallery/`, {
        credentials: 'include',
        headers: {
          'Authorization': `Bearer ${sessionId}`
        }
      });


      if (response.ok) {
        const images: MediaItem[] = await response.json();
        
        const imageItems = images.filter(img => img.fileType.startsWith('image/'));
        
        setGalleryImages(imageItems);
      } else {
        const errorText = await response.text();
        console.error('❌ Gallery request failed:', response.status, errorText);
        
        // If it's a 403 error (admin required), show a more helpful message
        if (response.status === 403) {
          setNotice('Gallery access requires admin privileges. Only uploaded images will be shown.');
          setGalleryImages([]);
        } else {
          setNotice(`Failed to load gallery: ${response.status}`);
        }
      }
    } catch (error) {
      console.error('❌ Error loading gallery images:', error);
      setNotice('Failed to load gallery images. Only new uploads will be available.');
      setGalleryImages([]);
    }
  }, []);

  // Select image from gallery
  const handleGalleryImageSelect = useCallback((image: MediaItem) => {
    editor.dispatchCommand(INSERT_IMAGE_COMMAND, {
      src: image.url,
      altText: image.fileName,
      width: undefined,
      height: undefined,
      fullSizeSrc: image.url,
      thumbnailSrc: image.thumbnailUrl,
      mediumSrc: image.mediumUrl,
      imageId: image.id,
      uploadedBy: image.uploaderName,
      uploadedAt: image.uploadedAt
    });

    setShowGalleryDialog(false);
  }, [editor]);

  return (
    <>
      {/* Image Upload Dialog */}
      {showImageDialog && (
        <div className="image-dialog-overlay" onClick={() => setShowImageDialog(false)}>
          <div className="image-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="image-dialog-header">
              <h3>Insert Image</h3>
              <button 
                className="close-button"
                onClick={() => setShowImageDialog(false)}
              >
                ×
              </button>
            </div>
            
            <div className="image-dialog-content">
              <div className="image-upload-section">
                <h4>Upload New Image</h4>
                <div className="image-upload-area">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        handleImageUpload(file);
                      }
                    }}
                    disabled={isUploading}
                  />
                  {isUploading && (
                    <div className="upload-progress">
                      <span>Uploading...</span>
                    </div>
                  )}
                </div>
              </div>
              
              <div className="image-gallery-section">
                <h4>Or Select from Gallery</h4>
                <button 
                  className="gallery-button"
                  onClick={() => {
                    setShowImageDialog(false);
                    setShowGalleryDialog(true);
                    loadGalleryImages();
                  }}
                >
                  Browse Gallery
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Gallery Selection Dialog */}
      {showGalleryDialog && (
        <div className="image-dialog-overlay" onClick={() => setShowGalleryDialog(false)}>
          <div className="image-dialog gallery-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="image-dialog-header">
              <h3>Select Image from Gallery</h3>
              <button 
                className="close-button"
                onClick={() => setShowGalleryDialog(false)}
              >
                ×
              </button>
            </div>
            
            <div className="gallery-grid">
              {galleryImages.map((image) => (
                <div
                  key={image.id}
                  className="gallery-item"
                  onClick={() => handleGalleryImageSelect(image)}
                >
                  <img
                    src={image.thumbnailUrl || image.url}
                    alt={image.fileName}
                    className="gallery-thumbnail"
                  />
                  <div className="gallery-item-info">
                    <span className="gallery-item-name">{image.fileName}</span>
                    <span className="gallery-item-uploader">by {image.uploaderName}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {notice && (
        <div className="image-import-notice" role="status" aria-live="polite">
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      <style dangerouslySetInnerHTML={{
        __html: `
          .image-dialog-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
          }

          .image-dialog {
            background: white;
            border-radius: 8px;
            padding: 20px;
            max-width: 500px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
          }

          .gallery-dialog {
            max-width: 800px;
            width: 90%;
          }

          .image-dialog-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
          }

          .close-button {
            background: none;
            border: none;
            font-size: 24px;
            cursor: pointer;
            color: #666;
          }

          .image-upload-section, .image-gallery-section {
            margin-bottom: 20px;
          }

          .image-upload-area {
            border: 2px dashed #ddd;
            border-radius: 8px;
            padding: 20px;
            text-align: center;
            margin-top: 10px;
          }

          .upload-progress {
            margin-top: 10px;
          }

          .image-import-notice {
            position: fixed;
            right: 16px;
            bottom: 16px;
            max-width: calc(100vw - 32px);
            z-index: 1100;
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 14px;
            border-radius: 6px;
            background: #323232;
            color: #fff;
            font-size: 14px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
          }

          .image-import-notice button {
            background: none;
            border: none;
            color: inherit;
            font-size: 18px;
            line-height: 1;
            cursor: pointer;
          }

          .gallery-button {
            background: #007bff;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
          }

          .gallery-button:hover {
            background: #0056b3;
          }

          .gallery-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
            gap: 15px;
            margin-top: 10px;
          }

          .gallery-item {
            border: 1px solid #ddd;
            border-radius: 8px;
            padding: 10px;
            cursor: pointer;
            transition: border-color 0.2s ease;
          }

          .gallery-item:hover {
            border-color: #007bff;
          }

          .gallery-thumbnail {
            width: 100%;
            height: 100px;
            object-fit: cover;
            border-radius: 4px;
          }

          .gallery-item-info {
            margin-top: 5px;
          }

          .gallery-item-name {
            display: block;
            font-size: 12px;
            font-weight: bold;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .gallery-item-uploader {
            display: block;
            font-size: 10px;
            color: #666;
          }

        `
      }} />
    </>
  );
}