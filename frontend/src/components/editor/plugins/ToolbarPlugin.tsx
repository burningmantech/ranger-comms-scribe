import React, { useCallback, useState, useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  FORMAT_TEXT_COMMAND,
  FORMAT_ELEMENT_COMMAND,
  UNDO_COMMAND,
  REDO_COMMAND,
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  $createTextNode,
  TextFormatType,
  $getRoot,
  ElementFormatType,
  NodeSelection,
  createCommand,
  LexicalCommand,
  COMMAND_PRIORITY_EDITOR,
  LexicalNode,
  $isElementNode,
  ElementNode,
  $getNodeByKey,
} from 'lexical';
import {
  $setBlocksType,
} from '@lexical/selection';
import {
  $createHeadingNode,
  $isHeadingNode,
  HeadingTagType,
} from '@lexical/rich-text';
import {
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
  $isListNode,
  $isListItemNode,
  ListNode,
} from '@lexical/list';
import {
  $createTableNodeWithDimensions,
  TableNode,
  TableRowNode,
  TableCellNode,
  $isTableRowNode,
  $isTableCellNode,
} from '@lexical/table';
import { CheckboxNode, $createCheckboxNode, $isCheckboxNode } from '../nodes/CheckboxNode';
import { createPortal } from 'react-dom';
import { INSERT_IMAGE_COMMAND } from './ImagePlugin';
import { INDENT_COMMAND, OUTDENT_COMMAND } from './IndentationPlugin';

// Helper function to replace $findMatchingParent
function $findMatchingParent(node: any, predicate: (node: any) => boolean): any {
  let parent = node.getParent();
  while (parent !== null) {
    if (predicate(parent)) {
      return parent;
    }
    parent = parent.getParent();
  }
  return null;
}

// Define additional property for caching text in the checkbox node
interface ExtendedCheckboxNode extends CheckboxNode {
  __cachedText?: string;
}

export const ToolbarPlugin: React.FC = () => {
  const [editor] = useLexicalComposerContext();
  const [showTableModal, setShowTableModal] = useState(false);
  const [tableRows, setTableRows] = useState(3);
  const [tableColumns, setTableColumns] = useState(3);
  const [isUnorderedList, setIsUnorderedList] = useState(false);
  const [isOrderedList, setIsOrderedList] = useState(false);
  
  // Track current selection state for proper toggling
  useEffect(() => {
    return editor.registerUpdateListener(({editorState}) => {
      editorState.read(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          // Check if current selection is in a list
          const anchorNode = selection.anchor.getNode();
          const focusNode = selection.focus.getNode();
          
          const anchorListItem = $findMatchingParent(anchorNode, $isListItemNode);
          const focusListItem = $findMatchingParent(focusNode, $isListItemNode);
          
          // Check for list type
          let hasOrderedList = false;
          let hasUnorderedList = false;
          
          if (anchorListItem) {
            const parentList = anchorListItem.getParent();
            if (parentList && $isListNode(parentList)) {
              const listType = parentList.getListType();
              if (listType === 'number') hasOrderedList = true;
              if (listType === 'bullet') hasUnorderedList = true;
            }
          }
          
          setIsOrderedList(hasOrderedList);
          setIsUnorderedList(hasUnorderedList);
        }
      });
    });
  }, [editor]);

  const insertCheckbox = useCallback(() => {
    editor.update(() => {
      const selection = $getSelection();
      
      if ($isRangeSelection(selection)) {
        // Get the selected text content
        const selectedText = selection.getTextContent();
        
        // If there's no selection, just insert an empty checkbox
        if (!selectedText.trim()) {
          const checkboxNode = $createCheckboxNode(false);
          selection.insertNodes([checkboxNode]);
          return;
        }
        
        // Get the original nodes so we can preserve formatting
        const selectionNodes = selection.getNodes();
        
        // Store text content for each line
        const textLines = selectedText.split(/\r?\n/);
        
        // Store the current anchor and focus points
        const anchor = selection.anchor;
        const focus = selection.focus;
        const anchorOffset = anchor.offset;
        const focusOffset = focus.offset;
        
        // Create a map of text to be assigned to checkboxes
        const checkboxTextMap = new Map();
        for (let i = 0; i < textLines.length; i++) {
          checkboxTextMap.set(`checkbox-${i}`, textLines[i].trim());
        }
        
        // Remove the selected text - we'll replace it with checkboxes
        selection.removeText();
        
        // Insert checkbox nodes, one for each line
        for (let i = 0; i < textLines.length; i++) {
          // Create a checkbox node
          const checkboxNode = $createCheckboxNode(false);
          
          // Insert the checkbox
          selection.insertNodes([checkboxNode]);
          
          // If this isn't the last line, we need a paragraph break
          if (i < textLines.length - 1) {
            const paragraphNode = $createParagraphNode();
            selection.insertNodes([paragraphNode]);
          }
        }
        
        // Now find all the checkboxes we just inserted and set their text content
        setTimeout(() => {
          const checkboxElements = document.querySelectorAll('.editor-checkbox');
          let index = 0;
          
          // Set text for each checkbox
          checkboxElements.forEach((element) => {
            // Find the text field in the checkbox
            const textSpan = element.querySelector('.checkbox-text');
            if (textSpan) {
              // Get corresponding text for this checkbox
              const text = checkboxTextMap.get(`checkbox-${index}`);
              if (text) {
                textSpan.textContent = text;
                index++;
              }
            }
          });
        }, 0);
      }
    });
  }, [editor]);

  const insertLink = useCallback(() => {
    // Simple link insertion
    const url = prompt('Enter URL:');
    if (url) {
      // Just wrap the selected text with a link
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const selectedText = selection.getTextContent();
          const linkText = selectedText || url;
          const textNode = $createTextNode(linkText);
          textNode.setFormat('underline' as TextFormatType);
          selection.insertNodes([textNode]);
        }
      });
    }
  }, [editor]);

  const insertTable = useCallback(() => {
    setShowTableModal(true);
  }, []);

  const createTable = useCallback(() => {
    editor.update(() => {
      try {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          // Create table with properly initialized cells
          const tableNode = $createTableNodeWithDimensions(tableRows, tableColumns, true);
          
          // Make sure every cell has a paragraph node for editing
          const rows = tableNode.getChildren();
          rows.forEach(row => {
            if ($isTableRowNode(row)) {
              const cells = row.getChildren();
              cells.forEach(cell => {
                if ($isTableCellNode(cell) && cell.getChildrenSize() === 0) {
                  cell.append($createParagraphNode());
                }
              });
            }
          });
          
          // Insert the table at the current selection
          selection.insertNodes([tableNode]);
          
          // Add a paragraph after the table for better editing experience
          const paragraphNode = $createParagraphNode();
          tableNode.insertAfter(paragraphNode);
          paragraphNode.select();
        }
      } catch (error) {
        console.error('Error creating table:', error);
      }
    });
    setShowTableModal(false);
  }, [editor, tableRows, tableColumns]);

  const formatHeading = useCallback(
    (headingTag: HeadingTagType) => {
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          $setBlocksType(selection, () => $createHeadingNode(headingTag));
        }
      });
    },
    [editor]
  );

  // List toggle handlers with proper toggling behavior
  const toggleUnorderedList = useCallback(() => {
    if (isUnorderedList) {
      // If already in an unordered list, remove it
      editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
    } else {
      // If not in an unordered list, create one or convert the existing list
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    }
  }, [editor, isUnorderedList]);

  const toggleOrderedList = useCallback(() => {
    if (isOrderedList) {
      // If already in an ordered list, remove it
      editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
    } else {
      // If not in an ordered list, create one or convert the existing list
      editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
    }
  }, [editor, isOrderedList]);

  // Indent/Outdent handlers - direct dispatching to our custom commands
  const indent = useCallback(() => {
    editor.dispatchCommand(INDENT_COMMAND, undefined);
  }, [editor]);

  const outdent = useCallback(() => {
    editor.dispatchCommand(OUTDENT_COMMAND, undefined);
  }, [editor]);

  // Helper function to handle formatting commands
  const formatText = (format: TextFormatType) => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
  };

  return (
    <>
      <div className="lexical-editor-toolbar" aria-label="Formatting options">
        {/* Text formatting */}
        <button
          onClick={() => formatText('bold')}
          className="lexical-toolbar-button"
          aria-label="Format text as bold"
          title="Bold"
        >
          B
        </button>
        <button
          onClick={() => formatText('italic')}
          className="lexical-toolbar-button"
          aria-label="Format text as italics"
          title="Italic"
        >
          I
        </button>
        <button
          onClick={() => formatText('underline')}
          className="lexical-toolbar-button"
          aria-label="Format text as underlined"
          title="Underline"
        >
          U
        </button>

        {/* Headings */}
        <button
          onClick={() => formatHeading('h1')}
          className="lexical-toolbar-button"
          aria-label="Format as heading 1"
          title="Heading 1"
        >
          H1
        </button>
        <button
          onClick={() => formatHeading('h2')}
          className="lexical-toolbar-button"
          aria-label="Format as heading 2"
          title="Heading 2"
        >
          H2
        </button>
        <button
          onClick={() => formatHeading('h3')}
          className="lexical-toolbar-button"
          aria-label="Format as heading 3"
          title="Heading 3"
        >
          H3
        </button>

        {/* Lists with toggle behavior */}
        <button
          onClick={toggleUnorderedList}
          className={`lexical-toolbar-button ${isUnorderedList ? 'active' : ''}`}
          aria-label="Toggle unordered list"
          title="Bullet List"
        >
          • List
        </button>
        <button
          onClick={toggleOrderedList}
          className={`lexical-toolbar-button ${isOrderedList ? 'active' : ''}`}
          aria-label="Toggle ordered list"
          title="Numbered List"
        >
          1. List
        </button>

        {/* Indent/Outdent controls */}
        <button
          onClick={indent}
          className="lexical-toolbar-button"
          aria-label="Indent"
          title="Indent"
        >
          →
        </button>
        <button
          onClick={outdent}
          className="lexical-toolbar-button"
          aria-label="Outdent" 
          title="Outdent"
        >
          ←
        </button>

        {/* Custom elements */}
        <button
          onClick={insertCheckbox}
          className="lexical-toolbar-button"
          aria-label="Insert checkbox"
          title="Checkbox"
        >
          ☑ Checkbox
        </button>
        <button
          onClick={insertTable}
          className="lexical-toolbar-button"
          aria-label="Insert table"
          title="Insert Table"
        >
          Table
        </button>
        <button
          onClick={insertLink}
          className="lexical-toolbar-button"
          aria-label="Insert link"
          title="Link"
        >
          Link
        </button>

        {/* History */}
        <button
          onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
          className="lexical-toolbar-button"
          aria-label="Undo"
          title="Undo"
        >
          Undo
        </button>
        <button
          onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}
          className="lexical-toolbar-button"
          aria-label="Redo"
          title="Redo"
        >
          Redo
        </button>
      </div>

      {/* Table Modal */}
      {showTableModal && createPortal(
        <div className="table-modal-overlay" onClick={() => setShowTableModal(false)}>
          <div className="table-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Insert Table</h3>
            <div className="table-size-controls">
              <label>
                Rows:
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={tableRows}
                  onChange={(e) => setTableRows(Number(e.target.value))}
                />
              </label>
              <label>
                Columns:
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={tableColumns}
                  onChange={(e) => setTableColumns(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="table-controls">
              <button onClick={createTable} className="lexical-toolbar-button">Create</button>
              <button onClick={() => setShowTableModal(false)} className="lexical-toolbar-button">Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};