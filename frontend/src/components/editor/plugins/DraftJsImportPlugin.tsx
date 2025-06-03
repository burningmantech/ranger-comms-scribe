import React, { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $createParagraphNode, $createTextNode, CLEAR_EDITOR_COMMAND } from 'lexical';
import { $createHeadingNode } from '@lexical/rich-text';
import { 
  $createListItemNode, 
  $createListNode,
  ListType
} from '@lexical/list';
import { convertFromRaw, RawDraftContentState } from 'draft-js';
import { ImageNode } from '../nodes/ImageNode';
import { CheckboxNode } from '../nodes/CheckboxNode';

export function DraftJsImportPlugin({ initialContent }: { initialContent: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // If no initial content, do nothing
    if (!initialContent || initialContent.trim() === '') {
      return;
    }

    try {
      // Try to parse as Draft.js content
      const draftContent = JSON.parse(initialContent);
      convertDraftToLexical(draftContent, editor);
    } catch (error) {
      console.error('Error importing DraftJs content:', error);
      
      // If not valid JSON, just set as plain text
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode(initialContent));
        root.append(paragraph);
      });
    }
  }, [initialContent, editor]);

  return null;
}

function convertDraftToLexical(draftContent: RawDraftContentState, editor: any) {
  try {
    const draftState = convertFromRaw(draftContent);
  
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      
      // Process each block
      const blocks = draftContent.blocks;
      let currentListType: string | null = null;
      let currentListNode: any = null;
      
      blocks.forEach((block) => {
        const { text, type, depth, entityRanges, inlineStyleRanges, key } = block;
        
        switch (type) {
          case 'header-one':
            const h1Node = $createHeadingNode('h1');
            h1Node.append($createTextNode(text));
            root.append(h1Node);
            break;
            
          case 'header-two':
            const h2Node = $createHeadingNode('h2');
            h2Node.append($createTextNode(text));
            root.append(h2Node);
            break;
            
          case 'header-three':
            const h3Node = $createHeadingNode('h3');
            h3Node.append($createTextNode(text));
            root.append(h3Node);
            break;
            
          case 'unordered-list-item':
          case 'ordered-list-item':
            // Determine list type
            const isOrdered = type === 'ordered-list-item';
            const listType: ListType = isOrdered ? 'number' : 'bullet';
            
            // If this is a new list or list type changed, create a new list
            if (!currentListNode || (currentListType !== type)) {
              currentListType = type;
              currentListNode = $createListNode(listType);
              root.append(currentListNode);
            }
            
            // Create and append the list item
            const listItem = $createListItemNode();
            listItem.append($createTextNode(text));
            currentListNode.append(listItem);
            break;
            
          case 'atomic':
            // Handle entities for atomic blocks (images, etc.)
            if (entityRanges.length > 0) {
              const entityRange = entityRanges[0];
              const entity = draftContent.entityMap[entityRange.key];
              
              if (entity.type === 'IMAGE') {
                const paragraph = $createParagraphNode();
                root.append(paragraph);
                break;
              }
            }
            // If not a handled entity, treat it like a checkbox
            const paragraph = $createParagraphNode();
            paragraph.append($createTextNode(text));
            root.append(paragraph);
            break;
            
          case 'checkbox':
            // Handle checkbox blocks
            const isChecked = !!block.data?.checked;
            const checkboxParagraph = $createParagraphNode();
            checkboxParagraph.append($createTextNode(text));
            root.append(checkboxParagraph);
            break;
            
          case 'unstyled':
          default:
            // Default paragraph
            const paragraphNode = $createParagraphNode();
            paragraphNode.append($createTextNode(text));
            root.append(paragraphNode);
            break;
        }
      });
    });
  } catch (error) {
    console.error('Error converting Draft.js to Lexical:', error);
  }
}