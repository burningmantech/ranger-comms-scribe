import React, { useCallback, useState, useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection, COMMAND_PRIORITY_EDITOR } from 'lexical';
import { createCommand } from 'lexical';
import { $createParagraphNode } from 'lexical';

export const INSERT_IMAGE_COMMAND = createCommand('insertImage');

export interface ImagePluginProps {
  onImageSelect?: () => void;
}

export function ImagePlugin({ onImageSelect }: ImagePluginProps) {
  const [editor] = useLexicalComposerContext();

  const insertImage = useCallback(
    (payload: { src: string; altText?: string; width?: number; height?: number; fullSizeSrc?: string }) => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return;
        }

        // Create an HTML img element
        const imgElement = document.createElement('img');
        imgElement.src = payload.src;
        imgElement.alt = payload.altText || '';
        if (payload.width) imgElement.width = Number(payload.width);
        if (payload.height) imgElement.height = Number(payload.height);
        if (payload.fullSizeSrc) imgElement.dataset.fullSrc = payload.fullSizeSrc;

        // Create a paragraph node to hold the image
        const paragraphNode = $createParagraphNode();
        
        // Insert the paragraph node
        selection.insertNodes([paragraphNode]);
        
        // Replace the paragraph's innerHTML with our image
        const element = editor.getElementByKey(paragraphNode.getKey());
        if (element) {
          element.innerHTML = '';
          element.appendChild(imgElement);
        }
      });
    },
    [editor]
  );

  // Register command listener
  useEffect(() => {
    const removeListener = editor.registerCommand(
      INSERT_IMAGE_COMMAND,
      (payload: any) => {
        insertImage(payload);
        return true;
      },
      COMMAND_PRIORITY_EDITOR
    );
    
    return () => {
      removeListener();
    };
  }, [editor, insertImage]);

  // Register a custom handler for image insertion from gallery
  useEffect(() => {
    if (onImageSelect) {
      const handleImageInsert = () => {
        onImageSelect();
      };
      
      // Create a button in the toolbar to trigger image insertion
      const toolbarElement = document.querySelector('.lexical-editor-toolbar');
      if (toolbarElement) {
        const imageButton = document.createElement('button');
        imageButton.className = 'lexical-toolbar-button';
        imageButton.textContent = '🖼️ Image';
        imageButton.addEventListener('click', handleImageInsert);
        toolbarElement.appendChild(imageButton);
      }
      
      return () => {
        // Clean up the button when the component unmounts
        const imageButton = document.querySelector('.lexical-toolbar-button:last-child');
        imageButton?.removeEventListener('click', handleImageInsert);
        imageButton?.remove();
      };
    }
    
    return () => {};
  }, [onImageSelect]);

  return null;
}