import React, { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ENTER_COMMAND,
  NodeKey,
  $getNodeByKey,
  $isElementNode
} from 'lexical';
import { CheckboxNode, $isCheckboxNode } from '../nodes/CheckboxNode';
import { $isAtNodeEnd } from '@lexical/selection';

type CheckboxEventDetail = {
  nodeKey: NodeKey;
  checked: boolean;
};

export const CheckboxPlugin: React.FC = () => {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Event handler for checkbox changes
    const handleCheckboxChange = (event: Event) => {
      const customEvent = event as CustomEvent<CheckboxEventDetail>;
      const { nodeKey, checked } = customEvent.detail;
      
      editor.update(() => {
        const checkboxNode = $getNodeByKey(nodeKey);
        if (checkboxNode instanceof CheckboxNode) {
          checkboxNode.setChecked(checked);
        }
      });
    };

    // Add listener for custom checkbox events
    const rootElement = editor.getRootElement();
    if (rootElement) {
      rootElement.addEventListener('checkboxChange', handleCheckboxChange);
    }

    // Handle Enter key for checkboxes
    const removeEnterListener = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        const selection = $getSelection();
        
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const node = selection.anchor.getNode();
        const parent = node.getParent();
        
        // Check if we're in a checkbox or a paragraph containing a checkbox
        if ($isCheckboxNode(parent) || $isCheckboxNode(node)) {
          const checkboxNode = $isCheckboxNode(node) ? node : parent;
          
          // If at the end of the checkbox node, check if it's empty
          if ($isAtNodeEnd(selection.anchor) && checkboxNode) {
            // Check if the checkbox is empty or contains only whitespace
            const content = checkboxNode.getTextContent().trim();
            
            if (!content) {
              // If empty, replace with a regular paragraph
              const newParagraph = $createParagraphNode();
              
              if ($isElementNode(checkboxNode)) {
                checkboxNode.replace(newParagraph);
                newParagraph.select();
                return true;
              }
            } else {
              // Not empty, create a new checkbox below
              const newParagraph = $createParagraphNode();
              const newCheckbox = new CheckboxNode(false);
              
              newParagraph.append(newCheckbox);
              
              // Insert the new paragraph after the current one
              if ($isElementNode(parent)) {
                parent.insertAfter(newParagraph);
              } else if ($isElementNode(node)) {
                node.insertAfter(newParagraph);
              }
              
              // Select the new checkbox
              newCheckbox.selectEnd();
            }
            
            return true;
          }
        }
        
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    return () => {
      if (rootElement) {
        rootElement.removeEventListener('checkboxChange', handleCheckboxChange);
      }
      removeEnterListener();
    };
  }, [editor]);

  return null;
};