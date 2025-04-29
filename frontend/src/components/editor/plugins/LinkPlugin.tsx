import React, { useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection, createCommand, COMMAND_PRIORITY_EDITOR } from 'lexical';
import { $createLinkNode, $isLinkNode, LinkNode } from '@lexical/link';
import { createPortal } from 'react-dom';

export const INSERT_LINK_COMMAND = createCommand('insertLink');
export const TOGGLE_LINK_EDITOR = createCommand('toggleLinkEditor');

interface LinkEditorProps {
  url: string;
  onSave: (url: string) => void;
  onCancel: () => void;
}

function LinkEditor({ url, onSave, onCancel }: LinkEditorProps) {
  const [linkUrl, setLinkUrl] = useState(url);
  
  return (
    <div className="link-editor">
      <div className="link-input">
        <input 
          type="text" 
          value={linkUrl} 
          onChange={(e) => setLinkUrl(e.target.value)}
          placeholder="https://" 
        />
        <div className="link-editor-buttons">
          <button onClick={() => onSave(linkUrl)}>Save</button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default function LinkPlugin() {
  const [editor] = useLexicalComposerContext();
  const [isEditingLink, setIsEditingLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkPosition, setLinkPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const handleLinkEdit = (url: string) => {
    setIsEditingLink(true);
    setLinkUrl(url);
    
    // Position editor near the selection
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      setLinkPosition({
        x: rect.left,
        y: rect.bottom + window.scrollY + 10,
      });
    }
  };

  const saveLinkEdit = (url: string) => {
    editor.update(() => {
      const selection = $getSelection();
      
      if ($isRangeSelection(selection)) {
        // If selection is collapsed or empty, don't create a link
        if (selection.isCollapsed()) {
          return;
        }
        
        // Check if we're editing an existing link node
        const nodes = selection.getNodes();
        const linkNode = nodes.find(node => $isLinkNode(node));
        
        if (linkNode && $isLinkNode(linkNode)) {
          // If this is an existing link node, just update its URL
          linkNode.setURL(url);
        } else {
          // Create a new link with the selected text
          const linkNode = $createLinkNode(url);
          selection.insertNodes([linkNode]);
          
          // Move selected text into the link node to maintain proper structure
          linkNode.select();
        }
      }
    });
    setIsEditingLink(false);
  };

  // Register command listener for inserting links
  useEffect(() => {
    return editor.registerCommand(
      INSERT_LINK_COMMAND,
      (payload: string) => {
        if (typeof payload === 'string') {
          handleLinkEdit(payload);
        } else {
          handleLinkEdit('');
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR
    );
  }, [editor]);

  // Register command listener for toggling link editor
  useEffect(() => {
    return editor.registerCommand(
      TOGGLE_LINK_EDITOR,
      () => {
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const node = selection.getNodes()[0];
            const linkNode = $isLinkNode(node) ? node : null;
            
            if (linkNode) {
              handleLinkEdit(linkNode.getURL());
            } else {
              handleLinkEdit('');
            }
          }
        });
        return true;
      },
      COMMAND_PRIORITY_EDITOR
    );
  }, [editor]);

  return (
    <>
      {isEditingLink && createPortal(
        <div 
          style={{ 
            position: 'absolute', 
            left: `${linkPosition.x}px`, 
            top: `${linkPosition.y}px`,
            zIndex: 100,
          }}
        >
          <LinkEditor 
            url={linkUrl} 
            onSave={saveLinkEdit} 
            onCancel={() => setIsEditingLink(false)} 
          />
        </div>,
        document.body
      )}
    </>
  );
}