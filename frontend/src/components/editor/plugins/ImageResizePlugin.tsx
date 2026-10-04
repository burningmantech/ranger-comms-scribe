import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getNodeByKey,
  $createParagraphNode,
  COMMAND_PRIORITY_LOW,
  SELECTION_CHANGE_COMMAND,
  $getSelection,
  $isRangeSelection,
} from 'lexical';
import { $isImageNode, ImageAlignment } from '../nodes/ImageNode';
import '../styles/ImageResizePlugin.css';

type HandlePosition = 'nw' | 'ne' | 'sw' | 'se';

export default function ImageResizePlugin(): React.ReactElement | null {
  const [editor] = useLexicalComposerContext();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showAltInput, setShowAltInput] = useState(false);
  const [altText, setAltText] = useState('');
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const [alignment, setAlignment] = useState<ImageAlignment>('none');
  const resizingRef = useRef<{
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    handle: HandlePosition;
    aspectRatio: number;
  } | null>(null);
  const selectedKeyRef = useRef<string | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    selectedKeyRef.current = selectedKey;
  }, [selectedKey]);

  const deselect = useCallback(() => {
    if (selectedKeyRef.current) {
      const dom = editor.getElementByKey(selectedKeyRef.current);
      if (dom) {
        dom.classList.remove('editor-image-selected');
      }
    }
    setSelectedKey(null);
    setShowAltInput(false);
    setDimensions(null);
  }, [editor]);

  const selectImage = useCallback((key: string) => {
    // Deselect previous
    if (selectedKeyRef.current && selectedKeyRef.current !== key) {
      const prevDom = editor.getElementByKey(selectedKeyRef.current);
      if (prevDom) {
        prevDom.classList.remove('editor-image-selected');
      }
    }

    const dom = editor.getElementByKey(key);
    if (dom) {
      dom.classList.add('editor-image-selected');
      const img = dom as HTMLImageElement;
      setDimensions({ w: img.offsetWidth, h: img.offsetHeight });

      editor.getEditorState().read(() => {
        const node = $getNodeByKey(key);
        if ($isImageNode(node)) {
          setAltText(node.getAltText());
          setAlignment(node.getAlignment());
        }
      });
    }
    setSelectedKey(key);
    setShowAltInput(false);
  }, [editor]);

  // Click listener on editor root to detect image clicks
  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'IMG' && target.dataset.lexicalImageKey) {
        e.preventDefault();
        selectImage(target.dataset.lexicalImageKey);
      } else if (!target.closest('.image-controls-toolbar') && !target.closest('.image-resize-handle')) {
        deselect();
      }
    };

    rootElement.addEventListener('click', handleClick);
    return () => {
      rootElement.removeEventListener('click', handleClick);
    };
  }, [editor, selectImage, deselect]);

  // Escape key to deselect
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedKeyRef.current) {
        deselect();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [deselect]);

  // Deselect on selection change to non-image
  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const node = selection.anchor.getNode();
          if (!$isImageNode(node) && !$isImageNode(node.getParent())) {
            // Don't deselect during resize
            if (!resizingRef.current) {
              deselect();
            }
          }
        }
        return false;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor, deselect]);

  // Delete handler
  const handleDelete = useCallback(() => {
    if (!selectedKey) return;
    editor.update(() => {
      const node = $getNodeByKey(selectedKey);
      if ($isImageNode(node)) {
        const paragraph = $createParagraphNode();
        node.replace(paragraph);
        paragraph.select();
      }
    });
    setSelectedKey(null);
    setDimensions(null);
  }, [editor, selectedKey]);

  // Alt text commit
  const commitAltText = useCallback(() => {
    if (!selectedKey) return;
    editor.update(() => {
      const node = $getNodeByKey(selectedKey);
      if ($isImageNode(node)) {
        node.setAltText(altText);
      }
    });
    setShowAltInput(false);
  }, [editor, selectedKey, altText]);

  // Alignment handler
  const handleAlignment = useCallback((newAlignment: ImageAlignment) => {
    if (!selectedKey) return;
    setAlignment(newAlignment);
    editor.update(() => {
      const node = $getNodeByKey(selectedKey);
      if ($isImageNode(node)) {
        node.setAlignment(newAlignment);
      }
    });
  }, [editor, selectedKey]);

  // Resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent, handle: HandlePosition) => {
    e.preventDefault();
    e.stopPropagation();

    if (!selectedKey) return;
    const dom = editor.getElementByKey(selectedKey) as HTMLImageElement | null;
    if (!dom) return;

    const startW = dom.offsetWidth;
    const startH = dom.offsetHeight;

    resizingRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW,
      startH,
      handle,
      aspectRatio: startW / startH,
    };

    dom.draggable = false;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!resizingRef.current) return;
      const { startX, startW, handle: h, aspectRatio } = resizingRef.current;

      let dx = moveEvent.clientX - startX;

      // For left handles, invert the delta
      if (h === 'nw' || h === 'sw') {
        dx = -dx;
      }

      let newW = Math.max(50, startW + dx);
      let newH = newW / aspectRatio;

      dom.style.width = `${newW}px`;
      dom.style.height = `${newH}px`;
      setDimensions({ w: Math.round(newW), h: Math.round(newH) });
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);

      if (!resizingRef.current) return;

      const finalW = dom.offsetWidth;
      const finalH = dom.offsetHeight;
      resizingRef.current = null;
      dom.draggable = true;

      editor.update(() => {
        const node = $getNodeByKey(selectedKey);
        if ($isImageNode(node)) {
          node.setWidthAndHeight(finalW, finalH);
        }
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [editor, selectedKey]);

  // Render nothing if no image selected
  if (!selectedKey) return null;

  const dom = editor.getElementByKey(selectedKey);
  if (!dom) return null;

  const editorRoot = editor.getRootElement();
  if (!editorRoot) return null;

  const imgRect = dom.getBoundingClientRect();
  const rootRect = editorRoot.getBoundingClientRect();

  const top = imgRect.top - rootRect.top;
  const left = imgRect.left - rootRect.left;
  const width = imgRect.width;
  const height = imgRect.height;

  const handles: HandlePosition[] = ['nw', 'ne', 'sw', 'se'];

  return (
    <>
      {/* Resize handles */}
      <div
        className="image-resize-handles-container"
        style={{
          top: `${top}px`,
          left: `${left}px`,
          width: `${width}px`,
          height: `${height}px`,
        }}
      >
        {handles.map((pos) => (
          <div
            key={pos}
            className={`image-resize-handle ${pos}`}
            onMouseDown={(e) => handleResizeStart(e, pos)}
          />
        ))}
      </div>

      {/* Floating toolbar above image */}
      <div
        className="image-controls-toolbar"
        style={{
          top: `${top - 36}px`,
          left: `${left}px`,
        }}
      >
        <button
          className="image-control-button delete"
          onClick={handleDelete}
          title="Delete image"
        >
          Delete
        </button>
        <div className="image-controls-divider" />
        <button
          className={`image-control-button ${alignment === 'left' ? 'active' : ''}`}
          onClick={() => handleAlignment(alignment === 'left' ? 'none' : 'left')}
          title="Float left (text wraps right)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="1" width="5" height="5" rx="0.5" fill="currentColor" opacity="0.3" />
            <line x1="8" y1="2" x2="13" y2="2" /><line x1="8" y1="5" x2="13" y2="5" />
            <line x1="1" y1="8" x2="13" y2="8" /><line x1="1" y1="11" x2="13" y2="11" />
          </svg>
        </button>
        <button
          className={`image-control-button ${alignment === 'center' ? 'active' : ''}`}
          onClick={() => handleAlignment(alignment === 'center' ? 'none' : 'center')}
          title="Center"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="1" width="8" height="5" rx="0.5" fill="currentColor" opacity="0.3" />
            <line x1="1" y1="8" x2="13" y2="8" /><line x1="1" y1="11" x2="13" y2="11" />
          </svg>
        </button>
        <button
          className={`image-control-button ${alignment === 'right' ? 'active' : ''}`}
          onClick={() => handleAlignment(alignment === 'right' ? 'none' : 'right')}
          title="Float right (text wraps left)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="8" y="1" width="5" height="5" rx="0.5" fill="currentColor" opacity="0.3" />
            <line x1="1" y1="2" x2="6" y2="2" /><line x1="1" y1="5" x2="6" y2="5" />
            <line x1="1" y1="8" x2="13" y2="8" /><line x1="1" y1="11" x2="13" y2="11" />
          </svg>
        </button>
        <div className="image-controls-divider" />
        {showAltInput ? (
          <input
            className="image-alt-input"
            value={altText}
            onChange={(e) => setAltText(e.target.value)}
            onBlur={commitAltText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitAltText();
              if (e.key === 'Escape') setShowAltInput(false);
            }}
            placeholder="Alt text..."
            autoFocus
          />
        ) : (
          <button
            className="image-control-button"
            onClick={() => setShowAltInput(true)}
            title="Edit alt text"
          >
            Alt
          </button>
        )}
        {dimensions && (
          <span className="image-dimensions">
            {dimensions.w} x {dimensions.h}
          </span>
        )}
      </div>
    </>
  );
}
