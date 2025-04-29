import React, { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  LexicalCommand,
  TextNode,
  $getNodeByKey
} from 'lexical';
import { $createCheckboxNode, $isCheckboxNode, CheckboxNode } from '../nodes/CheckboxNode';

export const INSERT_CHECKBOX_COMMAND: LexicalCommand<void> = createCommand();

export default function CheckboxPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Handle checkbox state changes
    const handleCheckboxChange = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { nodeKey, checked } = customEvent.detail;

      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (node && $isCheckboxNode(node)) {
          node.setChecked(checked);
        }
      });
    };

    const removeListener = editor.registerRootListener((rootElement, prevRootElement) => {
      if (rootElement) {
        rootElement.addEventListener('checkboxChange', handleCheckboxChange);
      }
      if (prevRootElement) {
        prevRootElement.removeEventListener('checkboxChange', handleCheckboxChange);
      }
    });

    // Register command for inserting checkbox
    const removeListenerCommand = editor.registerCommand(
      INSERT_CHECKBOX_COMMAND,
      () => {
        convertToCheckboxes();
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );

    return () => {
      removeListener();
      removeListenerCommand();
    };
  }, [editor]);

  function convertToCheckboxes() {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return;
      }

      // Get text content from the current selection
      const nodes = selection.getNodes();
      const textContent = nodes
        .filter(node => node instanceof TextNode)
        .map(node => (node as TextNode).getTextContent())
        .join('');

      // Replace the selected text with a checkbox node
      if (textContent.trim()) {
        // Create checkbox with the extracted text
        const checkboxNode = $createCheckboxNode(false, textContent.trim());
        
        // Replace the selected nodes with the checkbox node
        const anchorNode = selection.anchor.getNode();
        const focusNode = selection.focus.getNode();
        const topLevelNode = anchorNode.getTopLevelElementOrThrow();
        
        topLevelNode.insertBefore(checkboxNode);
        
        // Remove the original text nodes that were selected
        selection.getNodes().forEach(node => {
          if (node.isAttached()) {
            node.remove();
          }
        });
        
        // Select the newly created checkbox
        checkboxNode.selectStart();
      } else {
        // If no text is selected, just insert an empty checkbox
        const checkboxNode = $createCheckboxNode(false);
        selection.insertNodes([checkboxNode]);
        checkboxNode.selectStart();
      }
    });
  }

  return null;
}

// Helper function to insert a checkbox
export function insertCheckbox(): void {
  const editor = document.querySelector('[contenteditable="true"]');
  
  // Create and dispatch the custom command
  const event = new CustomEvent('lexical-command', {
    detail: {
      type: INSERT_CHECKBOX_COMMAND,
    },
    bubbles: true,
    cancelable: true,
  });
  
  editor?.dispatchEvent(event);
}