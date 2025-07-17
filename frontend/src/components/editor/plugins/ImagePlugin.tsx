import React, { useCallback, useState, useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection, COMMAND_PRIORITY_EDITOR, COMMAND_PRIORITY_LOW, PASTE_COMMAND, $getRoot, $createParagraphNode, $createTextNode } from 'lexical';
import { createCommand } from 'lexical';
import { $createHeadingNode } from '@lexical/rich-text';
import { $createListNode, $createListItemNode } from '@lexical/list';
import { $createQuoteNode } from '@lexical/rich-text';
import { $createTableNodeWithDimensions, $isTableRowNode, $isTableCellNode } from '@lexical/table';
import { $createImageNode, ImageNode } from '../nodes/ImageNode';
import { MediaItem } from '../../../types/index';
import { API_URL } from '../../../config';

export const INSERT_IMAGE_COMMAND = createCommand('insertImage');

export interface ImagePluginProps {
  onImageSelect?: () => void;
  currentUser?: any;
}

interface ImageUploadResponse {
  id: string;
  fileName: string;
  fileType: string;
  url: string;
  thumbnailUrl: string;
  mediumUrl: string;
  uploadedBy: string;
  uploaderName: string;
  uploadedAt: string;
  size: number;
}

export function ImagePlugin({ onImageSelect, currentUser }: ImagePluginProps) {
  const [editor] = useLexicalComposerContext();
  const [showImageDialog, setShowImageDialog] = useState(false);
  const [showGalleryDialog, setShowGalleryDialog] = useState(false);
  const [galleryImages, setGalleryImages] = useState<MediaItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  
  // Ref to store the downloadAndReplaceImage function to avoid circular dependencies
  const downloadAndReplaceImageRef = useRef<((src: string, width?: string, height?: string, placeholderId?: string) => Promise<void>) | null>(null);

  console.log('🎯 ImagePlugin mounted with currentUser:', currentUser);

  // Helper function to create a skeleton placeholder while image loads
  const createSkeletonImageData = useCallback((width?: string, height?: string, placeholderId?: string) => {
    const w = parseInt(width || '300');
    const h = parseInt(height || '200');
    
    // Create a clean SVG skeleton with CSS animation
    const svgSkeleton = `
      <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="shimmer" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" style="stop-color:#f6f7f8;stop-opacity:1" />
            <stop offset="20%" style="stop-color:#edeef1;stop-opacity:1" />
            <stop offset="40%" style="stop-color:#f6f7f8;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#f6f7f8;stop-opacity:1" />
          </linearGradient>
          <animateTransform 
            attributeName="gradientTransform" 
            attributeType="XML" 
            type="translate" 
            values="-100 0; 100 0; -100 0"
            dur="2s" 
            repeatCount="indefinite"/>
        </defs>
        <rect width="100%" height="100%" fill="#f6f7f8" stroke="#e1e4e8" stroke-width="1" rx="4"/>
        <rect width="100%" height="100%" fill="url(#shimmer)" opacity="0.7" rx="4"/>
        <text x="50%" y="45%" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" fill="#6a737d" font-weight="500">⏳ Loading image...</text>
        <text x="50%" y="60%" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#959da5">${w} × ${h}px</text>
      </svg>
    `;
    
    // Convert SVG to data URL using encodeURIComponent to handle Unicode characters
    const skeletonDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgSkeleton)}`;
    
    // Return the data needed to create the node (not the node itself)
    return {
      src: skeletonDataUrl,
      altText: 'Loading...',
      width: width,
      height: height,
      imageId: placeholderId || `skeleton-${Date.now()}`
    };
  }, []);

  // Helper function to recursively search for image nodes in the tree
  const findImageNodesRecursively = useCallback((node: any): any[] => {
    const imageNodes: any[] = [];
    
    if (node.getType() === 'image') {
      imageNodes.push(node);
    }
    
    // Recursively search children if they exist
    if (typeof node.getChildren === 'function') {
      const children = node.getChildren();
      for (const child of children) {
        imageNodes.push(...findImageNodesRecursively(child));
      }
    }
    
    return imageNodes;
  }, []);

  // Helper function to replace skeleton with real image
  const replaceSkeletonWithImage = useCallback((placeholderId: string, imagePayload: any) => {
    console.log('🔄 replaceSkeletonWithImage called:', {
      placeholderId,
      imagePayload: {
        src: imagePayload.src?.substring(0, 50) + '...',
        width: imagePayload.width,
        height: imagePayload.height,
        imageId: imagePayload.imageId
      }
    });
    
    editor.update(() => {
      const root = $getRoot();
      
      // Recursively find all image nodes in the entire tree
      const allImageNodes = findImageNodesRecursively(root);
      console.log('🔍 Searching for skeleton recursively, found', allImageNodes.length, 'total image nodes');
      
      let foundSkeleton = false;
      
      // Search through all image nodes
      allImageNodes.forEach((imageNode, index) => {
        console.log(`📸 Found image node ${index}:`, {
          imageId: imageNode.__imageId,
          src: imageNode.__src?.substring(0, 50) + '...',
          matchesPlaceholder: imageNode.__imageId === placeholderId
        });
        
        if (imageNode.__imageId === placeholderId) {
          console.log('✅ Found matching skeleton, replacing with real image');
          foundSkeleton = true;
          
          // Create new real image node
          const realImageNode = $createImageNode({
            src: imagePayload.src,
            altText: imagePayload.altText,
            width: imagePayload.width,
            height: imagePayload.height,
            fullSizeSrc: imagePayload.fullSizeSrc,
            thumbnailSrc: imagePayload.thumbnailSrc,
            mediumSrc: imagePayload.mediumSrc,
            imageId: imagePayload.imageId,
            uploadedBy: imagePayload.uploadedBy,
            uploadedAt: imagePayload.uploadedAt
          });
          
          // Replace the skeleton node
          imageNode.replace(realImageNode);
          console.log('🎉 Skeleton replaced successfully');
        }
      });
      
      if (!foundSkeleton) {
        console.warn('⚠️ No matching skeleton found for placeholderId:', placeholderId);
        console.log('🔍 Available image IDs:', allImageNodes.map(node => node.__imageId));
      }
    });
  }, [editor, findImageNodesRecursively]);

  // Helper function to recursively find all images in an element
  const findAllImages = useCallback((element: Element): Element[] => {
    const images: Element[] = [];
    
    // Check if this element is an image
    if (element.tagName === 'IMG') {
      images.push(element);
    }
    
    // Recursively search children
    for (const child of element.children) {
      images.push(...findAllImages(child));
    }
    
    return images;
  }, []);

  // Helper function to parse HTML and maintain text/image order
  const parseAndInsertHTML = useCallback((htmlData: string) => {
    console.log('🔍 Parsing HTML content to maintain order');
    
    // Create a temporary DOM element to parse HTML
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlData;
    
    // Find all images recursively
    const allImages = findAllImages(tempDiv);
    console.log('🖼️ Found', allImages.length, 'images in HTML content');
    
    // Get all child nodes in order (including text nodes)
    const childNodes = Array.from(tempDiv.childNodes);
    
    editor.update(() => {
      const selection = $getSelection();
      
      console.log('📝 Processing', childNodes.length, 'nodes in order');
      
      const nodesToInsert = [];
      let imageIndex = 0;
      
      // Process each child node and convert to appropriate Lexical nodes
      for (let i = 0; i < childNodes.length; i++) {
        const node = childNodes[i];
        const lexicalNodes = convertHTMLNodeToLexical(node, { imageIndex, allImages });
        nodesToInsert.push(...lexicalNodes);
        imageIndex = lexicalNodes.filter(n => n.getType && n.getType() === 'image').length + imageIndex;
      }
      
      // Insert all nodes at once
      if (nodesToInsert.length > 0 && $isRangeSelection(selection)) {
        console.log('✅ Inserting', nodesToInsert.length, 'nodes at selection');
        selection.insertNodes(nodesToInsert);
      }
      
      // Add a final paragraph for continued typing
      const finalParagraph = $createParagraphNode();
      if ($isRangeSelection(selection)) {
        selection.insertNodes([finalParagraph]);
        finalParagraph.select();
      }
    });
  }, [editor, createSkeletonImageData, findAllImages]);

  // Helper function to convert HTML node to Lexical nodes
  const convertHTMLNodeToLexical = useCallback((node: Node, context: { imageIndex: number, allImages: Element[] }): any[] => {
    const results = [];
    
    if (node.nodeType === Node.TEXT_NODE) {
      // Handle text nodes
      const textContent = node.textContent?.trim();
      if (textContent) {
        const textNode = $createTextNode(textContent);
        return [textNode]; // Return as array for consistency
      }
      return [];
    } 
    
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const tagName = element.tagName.toLowerCase();
      
      // Handle different HTML elements
      switch (tagName) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          const headingNode = $createHeadingNode(tagName as any);
          const headingText = extractTextWithFormatting(element);
          if (headingText.length > 0) {
            headingNode.append(...headingText);
          }
          results.push(headingNode);
          break;
          
        case 'p':
        case 'div':
          // Handle paragraphs and divs
          const hasImages = findAllImages(element).length > 0;
          
          if (hasImages) {
            // If paragraph contains images, process mixed content
            const mixedContent = processMixedContent(element, context);
            results.push(...mixedContent);
          } else {
            // Regular paragraph
            const paragraphNode = $createParagraphNode();
            const paragraphText = extractTextWithFormatting(element);
            if (paragraphText.length > 0) {
              paragraphNode.append(...paragraphText);
              results.push(paragraphNode);
            }
          }
          break;
          
        case 'ul':
          // Unordered list
          const ulNode = $createListNode('bullet');
          const listItems = element.querySelectorAll('li');
          listItems.forEach(li => {
            const listItemNode = $createListItemNode();
            const itemText = extractTextWithFormatting(li);
            if (itemText.length > 0) {
              listItemNode.append(...itemText);
            }
            ulNode.append(listItemNode);
          });
          if (listItems.length > 0) {
            results.push(ulNode);
          }
          break;
          
        case 'ol':
          // Ordered list
          const olNode = $createListNode('number');
          const orderedItems = element.querySelectorAll('li');
          orderedItems.forEach(li => {
            const listItemNode = $createListItemNode();
            const itemText = extractTextWithFormatting(li);
            if (itemText.length > 0) {
              listItemNode.append(...itemText);
            }
            olNode.append(listItemNode);
          });
          if (orderedItems.length > 0) {
            results.push(olNode);
          }
          break;
          
        case 'blockquote':
          // Quote
          const quoteNode = $createQuoteNode();
          const quoteText = extractTextWithFormatting(element);
          if (quoteText.length > 0) {
            quoteNode.append(...quoteText);
          }
          results.push(quoteNode);
          break;
          
        case 'table':
          // Tables - convert to Lexical table
          console.log('🏢 Processing table element with', element.querySelectorAll('img').length, 'images');
          const tableNode = createTableFromHTML(element, context);
          if (tableNode) {
            console.log('✅ Table node created and added to results');
            results.push(tableNode);
          } else {
            console.log('❌ Failed to create table node');
          }
          break;
          
        case 'img':
          // Handle images
          const src = element.getAttribute('src');
          const width = element.getAttribute('width');
          const height = element.getAttribute('height');
          
          if (src && src.includes('googleusercontent.com')) {
            const placeholderId = `ordered-skeleton-${Date.now()}-${context.imageIndex}`;
            console.log('🖼️ Creating skeleton for Google Docs image:', {
              src: src.substring(0, 50) + '...',
              width,
              height,
              placeholderId,
              imageIndex: context.imageIndex
            });
            
            const skeletonData = createSkeletonImageData(width || undefined, height || undefined, placeholderId);
            const skeletonNode = $createImageNode(skeletonData);
            console.log('✅ Skeleton node created:', {
              type: skeletonNode.getType(),
              imageId: (skeletonNode as any).__imageId,
              src: (skeletonNode as any).__src?.substring(0, 50) + '...'
            });
            
            results.push(skeletonNode);
            
            // Start async download and replacement
            setTimeout(() => {
              console.log('⏳ Starting image download for placeholder:', placeholderId);
              if (downloadAndReplaceImageRef.current) {
                downloadAndReplaceImageRef.current(src, width || undefined, height || undefined, placeholderId);
              } else {
                console.error('❌ downloadAndReplaceImageRef.current is null!');
              }
            }, 0);
            
            context.imageIndex++;
          }
          break;
          
        case 'br':
          // Line breaks - create empty paragraph
          results.push($createParagraphNode());
          break;
          
        default:
          // For other elements, process their children
          const childNodes = Array.from(element.childNodes);
          for (const child of childNodes) {
            const childResults = convertHTMLNodeToLexical(child, context);
            results.push(...childResults);
          }
          break;
      }
    }
    
    return results;
  }, [createSkeletonImageData, findAllImages]);

  // Helper function to extract text with inline formatting
  const extractTextWithFormatting = useCallback((element: Element): any[] => {
    const textNodes = [];
    
    // Process all child nodes to preserve formatting
    const processNode = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (text && text.trim()) {
          const textNode = $createTextNode(text);
          
          // Apply formatting based on parent elements
          let currentElement = node.parentElement;
          while (currentElement && currentElement !== element.parentElement) {
            const tagName = currentElement.tagName?.toLowerCase();
            const style = currentElement.getAttribute('style') || '';
            
            // Apply formatting based on tags
            if (tagName === 'b' || tagName === 'strong' || style.includes('font-weight:700') || style.includes('font-weight:bold')) {
              textNode.toggleFormat('bold');
            }
            if (tagName === 'i' || tagName === 'em' || style.includes('font-style:italic')) {
              textNode.toggleFormat('italic');
            }
            if (tagName === 'u' || style.includes('text-decoration:underline')) {
              textNode.toggleFormat('underline');
            }
            if (tagName === 'strike' || tagName === 's' || style.includes('text-decoration:line-through')) {
              textNode.toggleFormat('strikethrough');
            }
            
            // Apply font size
            const fontSizeMatch = style.match(/font-size:\s*([^;]+)/);
            if (fontSizeMatch) {
              const fontSize = fontSizeMatch[1].trim();
              textNode.setStyle(textNode.getStyle() + `font-size: ${fontSize};`);
            }
            
            // Apply font family
            const fontFamilyMatch = style.match(/font-family:\s*([^;]+)/);
            if (fontFamilyMatch) {
              const fontFamily = fontFamilyMatch[1].trim();
              textNode.setStyle(textNode.getStyle() + `font-family: ${fontFamily};`);
            }
            
            // Apply text color
            const colorMatch = style.match(/color:\s*([^;]+)/);
            if (colorMatch) {
              const color = colorMatch[1].trim();
              textNode.setStyle(textNode.getStyle() + `color: ${color};`);
            }
            
            currentElement = currentElement.parentElement;
          }
          
          textNodes.push(textNode);
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Recursively process child elements
        for (const child of node.childNodes) {
          processNode(child);
        }
      }
    };
    
    // Process all children of the element
    for (const child of element.childNodes) {
      processNode(child);
    }
    
    // If no formatted text was found, fall back to plain text
    if (textNodes.length === 0) {
      const plainText = element.textContent?.trim();
      if (plainText) {
        textNodes.push($createTextNode(plainText));
      }
    }
    
    return textNodes;
  }, []);

  // Helper function to process mixed content (text + images)
  const processMixedContent = useCallback((element: Element, context: { imageIndex: number, allImages: Element[] }): any[] => {
    const results = [];
    
    // Process all child nodes in order
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent?.trim();
        if (text) {
          const paragraphNode = $createParagraphNode();
          paragraphNode.append($createTextNode(text));
          results.push(paragraphNode);
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const childElement = child as Element;
        
        if (childElement.tagName.toLowerCase() === 'img') {
          // Handle image
          const src = childElement.getAttribute('src');
          const width = childElement.getAttribute('width');
          const height = childElement.getAttribute('height');
          
          if (src && src.includes('googleusercontent.com')) {
            const placeholderId = `ordered-skeleton-${Date.now()}-${context.imageIndex}`;
            const skeletonData = createSkeletonImageData(width || undefined, height || undefined, placeholderId);
            const skeletonNode = $createImageNode(skeletonData);
            results.push(skeletonNode);
            
            setTimeout(() => {
              if (downloadAndReplaceImageRef.current) {
                downloadAndReplaceImageRef.current(src, width || undefined, height || undefined, placeholderId);
              }
            }, 0);
            
            context.imageIndex++;
          }
        } else {
          // Handle other elements
          const childResults = convertHTMLNodeToLexical(child, context);
          results.push(...childResults);
        }
      }
    }
    
    return results;
  }, [createSkeletonImageData]);

  // Helper function to process mixed content in table cells (text + images)
  const processMixedTableCellContent = useCallback((cellElement: Element, context: { imageIndex: number, allImages: Element[] }): any[] => {
    const results = [];
    
    console.log('🔍 Processing table cell with mixed content');
    
    // Process all child nodes in the cell
    const processChildNodes = (element: Element): any[] => {
      const nodes = [];
      
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent?.trim();
          if (text) {
            nodes.push($createTextNode(text));
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const childElement = child as Element;
          const tagName = childElement.tagName.toLowerCase();
          
          if (tagName === 'img') {
            // Handle image in table cell
            const src = childElement.getAttribute('src');
            const width = childElement.getAttribute('width');
            const height = childElement.getAttribute('height');
            
            console.log('🖼️ Found image in table cell:', { src: src?.substring(0, 50) + '...', width, height });
            
            if (src && src.includes('googleusercontent.com')) {
              const placeholderId = `table-cell-skeleton-${Date.now()}-${context.imageIndex}`;
              console.log('🖼️ Creating skeleton for table cell image:', {
                src: src.substring(0, 50) + '...',
                width,
                height,
                placeholderId,
                imageIndex: context.imageIndex
              });
              
              const skeletonData = createSkeletonImageData(width || undefined, height || undefined, placeholderId);
              const skeletonNode = $createImageNode(skeletonData);
              console.log('✅ Table cell skeleton node created:', {
                type: skeletonNode.getType(),
                imageId: (skeletonNode as any).__imageId,
                placeholderId: placeholderId,
                src: (skeletonNode as any).__src?.substring(0, 50) + '...'
              });
              
              // Verify the skeleton's imageId matches our placeholderId
              if ((skeletonNode as any).__imageId !== placeholderId) {
                console.warn('⚠️ Skeleton imageId mismatch!', {
                  expected: placeholderId,
                  actual: (skeletonNode as any).__imageId
                });
              }
              
              nodes.push(skeletonNode);
              
              // Start async download and replacement
              setTimeout(() => {
                console.log('⏳ Starting table cell image download for placeholder:', placeholderId);
                if (downloadAndReplaceImageRef.current) {
                  downloadAndReplaceImageRef.current(src, width || undefined, height || undefined, placeholderId);
                } else {
                  console.error('❌ downloadAndReplaceImageRef.current is null!');
                }
              }, 0);
              
              context.imageIndex++;
            }
          } else {
            // Recursively process other elements
            const childNodes = processChildNodes(childElement);
            nodes.push(...childNodes);
          }
        }
      }
      
      return nodes;
    };
    
    const cellNodes = processChildNodes(cellElement);
    
    // If we have content, wrap it in a paragraph
    if (cellNodes.length > 0) {
      const paragraph = $createParagraphNode();
      paragraph.append(...cellNodes);
      results.push(paragraph);
    } else {
      // Empty cell gets an empty paragraph
      results.push($createParagraphNode());
    }
    
    return results;
  }, [createSkeletonImageData]);

  // Helper function to create table from HTML
  const createTableFromHTML = useCallback((tableElement: Element, context: { imageIndex: number, allImages: Element[] }) => {
    try {
      const rows = tableElement.querySelectorAll('tr');
      if (rows.length === 0) return null;
      
      // Determine table dimensions
      let maxCols = 0;
      rows.forEach(row => {
        const cells = row.querySelectorAll('td, th');
        maxCols = Math.max(maxCols, cells.length);
      });
      
      // Create table node
      const tableNode = $createTableNodeWithDimensions(rows.length, maxCols, true);
      
      // Populate table cells
      const tableRows = (tableNode as any).getChildren();
      for (let i = 0; i < rows.length && i < tableRows.length; i++) {
        const htmlRow = rows[i];
        const lexicalRow = tableRows[i];
        const htmlCells = htmlRow.querySelectorAll('td, th');
        const lexicalCells = $isTableRowNode(lexicalRow) ? lexicalRow.getChildren() : [];
        
        for (let j = 0; j < htmlCells.length && j < lexicalCells.length; j++) {
          const htmlCell = htmlCells[j];
          const lexicalCell = lexicalCells[j];
          
          if ($isTableCellNode(lexicalCell)) {
            // Check if cell contains images
            const imagesInCell = findAllImages(htmlCell);
            console.log(`🔍 Cell ${i},${j} contains ${imagesInCell.length} images`);
            
            if (imagesInCell.length > 0) {
              // Process mixed content (text + images) in table cell
              const cellContent = processMixedTableCellContent(htmlCell, context);
              cellContent.forEach(node => {
                lexicalCell.append(node);
              });
            } else {
              // Extract cell content with formatting (text only)
              const cellText = extractTextWithFormatting(htmlCell);
              if (cellText.length > 0) {
                const cellParagraph = $createParagraphNode();
                cellParagraph.append(...cellText);
                lexicalCell.append(cellParagraph);
              } else {
                // Ensure cell has at least an empty paragraph
                lexicalCell.append($createParagraphNode());
              }
            }
          }
        }
      }
      
      return tableNode;
    } catch (error) {
      console.error('Error creating table from HTML:', error);
      return null;
    }
  }, [processMixedTableCellContent]);

  // Helper function to parse HTML and maintain text/image order
  const handleHTMLImageContent = useCallback((htmlData: string) => {
    console.log('🔍 Processing HTML image content');
    
    try {
      // Create a temporary DOM element to parse HTML
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = htmlData;
      
      // Find all img tags
      const images = tempDiv.querySelectorAll('img');
      console.log('🖼️ Found images in HTML:', images.length);
      
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const src = img.getAttribute('src');
        const width = img.getAttribute('width');
        const height = img.getAttribute('height');
        const style = img.getAttribute('style');
        
        console.log(`📸 Image ${i + 1}:`, {
          src: src?.substring(0, 50) + '...',
          alt: img.getAttribute('alt'),
          width: width,
          height: height,
          style: style
        });
        
        if (src) {
          if (src.startsWith('data:image/')) {
            console.log('✅ Found base64 image in HTML');
            convertBase64ToFile(src);
            return; // Handle first base64 image found
          } else if (src.startsWith('http')) {
            console.log('🔗 Found external image URL in HTML');
            
            // For Google Docs URLs, try to create a cross-origin proxy or use a different approach
            if (src.includes('googleusercontent.com') || src.includes('docs.google.com')) {
              console.log('🔧 Attempting alternative approach for Google Docs image');
              
              // Pass the original dimensions to the handler
              handleGoogleDocsImageFromHTML(src, img, width || undefined, height || undefined);
            } else {
              console.log('🔗 Downloading regular external image URL');
              downloadImageFromURL(src);
            }
            return; // Handle first external image found
          }
        }
      }
      
      console.log('❌ No processable images found in HTML');
    } catch (error) {
      console.error('❌ Error processing HTML image content:', error);
    }
  }, []);

  // Helper function to handle Google Docs images from HTML with alternative approaches
  const handleGoogleDocsImageFromHTML = useCallback(async (src: string, imgElement: HTMLImageElement, width?: string, height?: string) => {
    console.log('🔧 Using backend proxy for Google Docs image');
    console.log('📏 Original dimensions:', { width, height });
    
    // Create skeleton placeholder immediately
    const placeholderId = `skeleton-${Date.now()}`;
    const skeletonData = createSkeletonImageData(width, height, placeholderId);
    
    // Insert skeleton immediately to show loading state
    editor.update(() => {
      const selection = $getSelection();
      
      // Create the skeleton node inside the editor context
      const skeletonNode = $createImageNode(skeletonData);
      
      // Create a paragraph for text after the skeleton
      const paragraphNode = $createParagraphNode();
      
      if ($isRangeSelection(selection)) {
        // Insert skeleton and paragraph together
        selection.insertNodes([skeletonNode, paragraphNode]);
        // Move cursor to the paragraph
        paragraphNode.select();
      } else {
        const root = $getRoot();
        root.append(skeletonNode);
        root.append(paragraphNode);
        // Move cursor to the paragraph
        paragraphNode.select();
      }
    });
    
    console.log('⏳ Skeleton placeholder inserted, starting download...');
    
    try {
      // Use the backend proxy to download the image
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) {
        console.error('❌ No session ID found - user not authenticated');
        alert('You must be logged in to paste images.');
        return;
      }

      console.log('🔄 Sending image URL to backend proxy:', src);
      
      const response = await fetch(`${API_URL}/content/editor-images/proxy-google-docs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionId}`
        },
        body: JSON.stringify({ imageUrl: src })
      });

      if (!response.ok) {
        console.error('❌ Backend proxy failed:', response.status, response.statusText);
        alert('Failed to download image from Google Docs. Please try saving the image locally first.');
        return;
      }

      // Convert response to blob and then to file
      const blob = await response.blob();
      const file = new File([blob], `google-docs-image-${Date.now()}.jpg`, {
        type: blob.type || 'image/jpeg'
      });

      console.log('✅ Successfully downloaded image via backend proxy:', {
        name: file.name,
        size: file.size,
        type: file.type,
        originalWidth: width,
        originalHeight: height
      });

      // Store original dimensions for use in upload
      (file as any).originalWidth = width;
      (file as any).originalHeight = height;
      (file as any).placeholderId = placeholderId; // Store placeholder ID

      // Upload the file (this will replace the skeleton)
      await handleImageUpload(file);

    } catch (error) {
      console.error('❌ Error using backend proxy for Google Docs image:', error);
      alert('Failed to download image from Google Docs. Please try saving the image locally first.');
    }
  }, [createSkeletonImageData, editor]);

  // Helper function to extract image data from Google Docs data structure
  const extractImageFromGoogleDocsData = (data: any): string | null => {
    try {
      console.log('🔍 Extracting image from Google Docs data structure');
      
      // Google Docs data has a nested structure
      if (data && data.data && typeof data.data === 'string') {
        console.log('📊 Parsing nested Google Docs data');
        const nestedData = JSON.parse(data.data);
        console.log('📊 Nested data structure:', nestedData);
        
        // Look for image_urls in the nested data
        if (nestedData.image_urls && typeof nestedData.image_urls === 'object') {
          console.log('🔍 Found image_urls object:', nestedData.image_urls);
          
          // Get the first image URL
          const imageKeys = Object.keys(nestedData.image_urls);
          if (imageKeys.length > 0) {
            const firstImageUrl = nestedData.image_urls[imageKeys[0]];
            console.log('✅ Found image URL in Google Docs data:', firstImageUrl);
            return firstImageUrl;
          }
        }
      }
      
      // Fallback: look for any URLs in the entire data structure
      const dataStr = JSON.stringify(data);
      
      // Look for Google userusercontent URLs
      const urlMatch = dataStr.match(/https:\/\/lh\d+-rt\.googleusercontent\.com\/[^"]+/);
      if (urlMatch) {
        console.log('✅ Found Google userusercontent URL as fallback:', urlMatch[0]);
        return urlMatch[0];
      }
      
      // Look for any other image URLs
      const imageUrlMatch = dataStr.match(/https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|webp)/i);
      if (imageUrlMatch) {
        console.log('✅ Found image URL as fallback:', imageUrlMatch[0]);
        return imageUrlMatch[0];
      }
      
      // Original base64 check as final fallback
      const base64Match = dataStr.match(/data:image\/[^;]+;base64,[^"]+/);
      if (base64Match) {
        console.log('✅ Found base64 image in Google Docs data');
        return base64Match[0];
      }
      
      console.log('❌ No image URL or base64 found in Google Docs data');
      return null;
    } catch (error) {
      console.error('❌ Error extracting image from Google Docs data:', error);
      return null;
    }
  };

  // Helper function to convert base64 to file and upload
  const convertBase64ToFile = useCallback((base64Data: string) => {
    try {
      console.log('🔄 Converting base64 to file');
      
      // Extract mime type and base64 data
      const matches = base64Data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        console.error('❌ Invalid base64 data format');
        return;
      }
      
      const mimeType = matches[1];
      const base64 = matches[2];
      
      // Convert base64 to blob
      const byteCharacters = atob(base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: mimeType });
      
      // Create file object
      const file = new File([blob], `pasted-image-${Date.now()}.${mimeType.split('/')[1]}`, {
        type: mimeType
      });
      
      console.log('✅ Converted base64 to file:', {
        name: file.name,
        size: file.size,
        type: file.type
      });
      
      // We'll call handleImageUpload directly since it's defined later
      // This avoids the circular dependency issue
      setTimeout(() => {
        handleImageUpload(file);
      }, 0);
    } catch (error) {
      console.error('❌ Error converting base64 to file:', error);
    }
  }, []);

  // Helper function to download image from URL
  const downloadImageFromURL = useCallback(async (url: string, retryCount = 0) => {
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second
    
    try {
      // For Google Docs URLs, use the backend proxy
      if (url.includes('googleusercontent.com') || url.includes('docs.google.com')) {
        console.log('🔧 Using backend proxy for Google Docs URL');
        
        const sessionId = localStorage.getItem('sessionId');
        if (!sessionId) {
          console.error('❌ No session ID found - user not authenticated');
          alert('You must be logged in to paste images.');
          return;
        }

        console.log('🔄 Sending Google Docs URL to backend proxy:', url);
        
        const response = await fetch(`${API_URL}/content/editor-images/proxy-google-docs`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionId}`
          },
          body: JSON.stringify({ imageUrl: url })
        });

        if (!response.ok) {
          console.error('❌ Backend proxy failed:', response.status, response.statusText);
          alert('Failed to download image from Google Docs. Please try saving the image locally first.');
          return;
        }

        // Convert response to blob and then to file
        const blob = await response.blob();
        const file = new File([blob], `google-docs-image-${Date.now()}.jpg`, {
          type: blob.type || 'image/jpeg'
        });

        console.log('✅ Successfully downloaded Google Docs image via backend proxy:', {
          name: file.name,
          size: file.size,
          type: file.type
        });

        // Upload the file
        setTimeout(() => {
          handleImageUpload(file);
        }, 0);
        
        return;
      }
      
      // For non-Google Docs URLs, use direct download with retry logic
      console.log(`🔄 Downloading image from URL (attempt ${retryCount + 1}/${maxRetries + 1}):`, url);
      
      const response = await fetch(url);
      
      // Handle rate limiting with retry
      if (response.status === 429) {
        if (retryCount < maxRetries) {
          const delay = baseDelay * Math.pow(2, retryCount); // Exponential backoff
          console.log(`⏱️ Rate limited, retrying in ${delay}ms...`);
          setTimeout(() => {
            downloadImageFromURL(url, retryCount + 1);
          }, delay);
          return;
        } else {
          throw new Error(`Rate limited after ${maxRetries} retries`);
        }
      }
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const blob = await response.blob();
      const file = new File([blob], `downloaded-image-${Date.now()}.jpg`, {
        type: blob.type || 'image/jpeg'
      });
      
      console.log('✅ Downloaded image as file:', {
        name: file.name,
        size: file.size,
        type: file.type
      });
      
      // Upload the file
      setTimeout(() => {
        handleImageUpload(file);
      }, 0);
    } catch (error) {
      console.error('❌ Error downloading image from URL:', error);
      
      // If all retries failed, show user-friendly message
      if (retryCount >= maxRetries) {
        alert('Failed to download image after multiple attempts. The image may be access-restricted or the server may be rate limiting requests.');
      }
    }
  }, []);

  // Image upload handler
  const handleImageUpload = useCallback(async (file: File) => {
    console.log('🖼️ handleImageUpload called with file:', file.name, file.type, file.size);
    
    if (!currentUser) {
      console.error('❌ No current user for image upload');
      alert('You must be logged in to upload images.');
      return;
    }

    console.log('👤 Current user:', currentUser);

    // Check session ID before proceeding
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      console.error('❌ No session ID found - user not authenticated');
      alert('You must be logged in to upload images.');
      return;
    }
    
    console.log('🔐 Session ID found:', sessionId.substring(0, 8) + '...');

    setIsUploading(true);
    setUploadProgress(0);

    try {
      console.log('🔄 Creating image versions...');
      // Create thumbnail and medium versions on the client side
      const { thumbnail, medium } = await createImageVersions(file);
      console.log('✅ Image versions created:', { thumbnail: thumbnail.name, medium: medium.name });
      
      // Upload to backend
      const formData = new FormData();
      formData.append('media', file);
      formData.append('thumbnail', thumbnail);
      formData.append('medium', medium);
      formData.append('isPublic', 'true');
      formData.append('takenBy', currentUser.name || currentUser.email);

      console.log('📤 Uploading to', `${API_URL}/content/editor-images/upload`);
      console.log('📤 Form data entries:', Array.from(formData.entries()).map(([key, value]) => [key, value instanceof File ? `File(${value.name}, ${value.size})` : value]));
      
      const response = await fetch(`${API_URL}/content/editor-images/upload`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
        headers: {
          'Authorization': `Bearer ${sessionId}`
        }
      });

      console.log('📥 Upload response:', response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Upload failed:', response.status, errorText);
        throw new Error(`Upload failed: ${response.status} ${errorText}`);
      }

      const result: ImageUploadResponse = await response.json();
      console.log('✅ Upload successful:', result);
      
      // Dispatch the INSERT_IMAGE_COMMAND with the image data
      const imagePayload = {
        src: result.url,
        altText: result.fileName,
        width: (file as any).originalWidth,
        height: (file as any).originalHeight,
        fullSizeSrc: result.url,
        thumbnailSrc: result.thumbnailUrl,
        mediumSrc: result.mediumUrl,
        imageId: result.id,
        uploadedBy: currentUser.name || currentUser.email,
        uploadedAt: new Date().toISOString()
      };
      
      // Check if this upload should replace a skeleton placeholder
      const placeholderId = (file as any).placeholderId;
      if (placeholderId) {
        console.log('🔄 Replacing skeleton placeholder with real image');
        replaceSkeletonWithImage(placeholderId, imagePayload);
      } else {
        console.log('🚀 Dispatching INSERT_IMAGE_COMMAND with payload:', imagePayload);
        
        editor.dispatchCommand(INSERT_IMAGE_COMMAND, imagePayload);
      }

      setShowImageDialog(false);
      console.log('✅ Image upload and insertion complete');
    } catch (error) {
      console.error('❌ Error uploading image:', error);
      alert(`Failed to upload image: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  }, [currentUser, editor, replaceSkeletonWithImage]);

  // Helper function to download and replace image (separated from the main handler)
  const downloadAndReplaceImage = useCallback(async (src: string, width?: string, height?: string, placeholderId?: string) => {
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) {
        console.error('❌ No session ID found - user not authenticated');
        return;
      }

      const response = await fetch(`${API_URL}/content/editor-images/proxy-google-docs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionId}`
        },
        body: JSON.stringify({ imageUrl: src })
      });

      if (!response.ok) {
        console.error('❌ Backend proxy failed:', response.status, response.statusText);
        return;
      }

      const blob = await response.blob();
      const file = new File([blob], `google-docs-image-${Date.now()}.jpg`, {
        type: blob.type || 'image/jpeg'
      });

      // Store metadata for replacement
      (file as any).originalWidth = width;
      (file as any).originalHeight = height;
      (file as any).placeholderId = placeholderId;

      await handleImageUpload(file);
    } catch (error) {
      console.error('❌ Error downloading ordered image:', error);
    }
  }, [handleImageUpload]);

  // Store the function in the ref for use by other functions
  downloadAndReplaceImageRef.current = downloadAndReplaceImage;

  // Debug function to check image processing status
  const debugImageProcessing = useCallback(() => {
    console.log('🔧 Debug Image Processing Status:', {
      hasDownloadFunction: !!downloadAndReplaceImageRef.current,
      hasHandleImageUpload: !!handleImageUpload,
      hasCreateSkeletonData: !!createSkeletonImageData,
      hasReplaceSkeletonWithImage: !!replaceSkeletonWithImage,
      currentUser: currentUser?.name || currentUser?.email,
      sessionId: !!localStorage.getItem('sessionId')
    });
  }, [currentUser, handleImageUpload, createSkeletonImageData, replaceSkeletonWithImage]);

  // Make debug function available globally
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).debugImageProcessing = debugImageProcessing;
    }
  }, [debugImageProcessing]);

  // Load gallery images
  const loadGalleryImages = useCallback(async () => {
    console.log('🖼️ Loading gallery images...');
    
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

      console.log('📥 Gallery response:', response.status, response.statusText);

      if (response.ok) {
        const images: MediaItem[] = await response.json();
        console.log('✅ Gallery images loaded:', images.length, 'total items');
        
        const imageItems = images.filter(img => img.fileType.startsWith('image/'));
        console.log('🖼️ Image items found:', imageItems.length);
        
        setGalleryImages(imageItems);
      } else {
        const errorText = await response.text();
        console.error('❌ Gallery request failed:', response.status, errorText);
        
        // If it's a 403 error (admin required), show a more helpful message
        if (response.status === 403) {
          alert('Gallery access requires admin privileges. Only uploaded images will be shown.');
          setGalleryImages([]);
        } else {
          alert(`Failed to load gallery: ${response.status} ${errorText}`);
        }
      }
    } catch (error) {
      console.error('❌ Error loading gallery images:', error);
      alert('Failed to load gallery images. Only new uploads will be available.');
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
  }, []);

  // Insert image into editor
  const insertImage = useCallback(
    (payload: { 
      src: string; 
      altText?: string; 
      width?: number; 
      height?: number; 
      fullSizeSrc?: string;
      thumbnailSrc?: string;
      mediumSrc?: string;
      imageId?: string;
      uploadedBy?: string;
      uploadedAt?: string;
    }) => {
      console.log('🖼️ insertImage called with payload:', payload);
      
      editor.update(() => {
        const selection = $getSelection();
        console.log('🖼️ Current selection:', selection);
        
        // Create an image node using the custom ImageNode
        const imageNode = $createImageNode({
          src: payload.src,
          altText: payload.altText || '',
          width: payload.width,
          height: payload.height,
          fullSizeSrc: payload.fullSizeSrc || payload.src,
          thumbnailSrc: payload.thumbnailSrc,
          mediumSrc: payload.mediumSrc,
          imageId: payload.imageId,
          uploadedBy: payload.uploadedBy,
          uploadedAt: payload.uploadedAt
        });

        console.log('🖼️ Created image node:', imageNode);

        if ($isRangeSelection(selection)) {
          console.log('🎯 Range selection detected, inserting at selection');
          // Insert the image node at current selection
          selection.insertNodes([imageNode]);
        } else {
          console.log('🎯 No range selection, appending to root');
          // If no selection, append to the end of the document
          const root = $getRoot();
          root.append(imageNode);
        }
        
        console.log('✅ Image node inserted successfully');
      });
    },
    [editor]
  );

  // Register command listener
  useEffect(() => {
    console.log('🎯 Registering INSERT_IMAGE_COMMAND listener');
    
    // Debug editor state
    const debugEditorState = () => {
      console.log('🔍 Editor debug info:', {
        hasEditor: !!editor,
        isEditable: editor ? editor.isEditable() : false,
        rootElement: editor ? editor.getRootElement() : null,
        hasRootElement: editor ? !!editor.getRootElement() : false
      });
    };

    debugEditorState();
    
    // Register the INSERT_IMAGE_COMMAND listener
    const removeInsertImageCommand = editor.registerCommand(
      INSERT_IMAGE_COMMAND,
      (payload: any) => {
        console.log('📸 INSERT_IMAGE_COMMAND triggered with payload:', payload);
        
        // Handle different payload structures
        const src = payload.src || payload.url;
        const altText = payload.altText || payload.alt || '';
        
        console.log('🖼️ Creating image node with:', { src, altText });
        
        const imageNode = $createImageNode({
          src: src,
          altText: altText,
          width: payload.width,
          height: payload.height,
          fullSizeSrc: payload.fullSizeSrc,
          thumbnailSrc: payload.thumbnailSrc,
          mediumSrc: payload.mediumSrc,
          imageId: payload.imageId,
          uploadedBy: payload.uploadedBy,
          uploadedAt: payload.uploadedAt
        });
        
        console.log('✅ Image node created, inserting into editor...');
        console.log('🔍 Image node details:', {
          type: imageNode.getType(),
          src: imageNode.__src,
          altText: imageNode.__altText,
          width: imageNode.__width,
          height: imageNode.__height,
          hasCreateDOM: typeof imageNode.createDOM === 'function'
        });
        
        // Test if image URL is accessible
        const testImg = new Image();
        testImg.onload = () => {
          console.log('✅ Image URL is accessible and loads successfully');
        };
        testImg.onerror = () => {
          console.error('❌ Image URL failed to load - accessibility issue');
        };
        testImg.src = src;
        
        editor.update(() => {
          const selection = $getSelection();
          const root = $getRoot();
          
          console.log('📊 Editor state before insertion:', {
            hasSelection: !!selection,
            isRangeSelection: $isRangeSelection(selection),
            rootChildren: root.getChildren().length,
            rootType: root.getType()
          });
          
          if ($isRangeSelection(selection)) {
            console.log('📍 Inserting at selection');
            
            // Add a paragraph after the image for text input
            const paragraphNode = $createParagraphNode();
            
            // Insert both image and paragraph together
            selection.insertNodes([imageNode, paragraphNode]);
            
            // Move cursor to the new paragraph
            paragraphNode.select();
          } else {
            console.log('📍 Appending to root');
            root.append(imageNode);
            
            // Add a paragraph after the image for text input
            const paragraphNode = $createParagraphNode();
            root.append(paragraphNode);
            // Move cursor to the new paragraph
            paragraphNode.select();
          }
          
          console.log('📊 Editor state after insertion:', {
            rootChildren: root.getChildren().length,
            lastChild: root.getLastChild()?.getType(),
            secondToLastChild: root.getChildren()[root.getChildren().length - 2]?.getType()
          });
          
          console.log('✅ Image node inserted into editor');
        });
        
        return true;
      },
      COMMAND_PRIORITY_EDITOR
    );
    
    console.log('✅ INSERT_IMAGE_COMMAND listener registered');
    
    // DOM paste listener removed to prevent conflicts with PASTE_COMMAND

    console.log('📋 Registering paste handler...');
    
    // Register the PASTE_COMMAND listener
    const removePasteCommand = editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        console.log('🚨 LEXICAL PASTE COMMAND FIRED!', {
          hasClipboardData: !!event.clipboardData,
          itemsLength: event.clipboardData?.items?.length || 0,
          types: event.clipboardData?.types || []
        });

        if (!event.clipboardData) {
          console.log('❌ No clipboard data in paste event');
          return false;
        }

        const items = Array.from(event.clipboardData.items);
        console.log('📋 Clipboard items detailed:', items.map((item, index) => ({
          index,
          kind: item.kind,
          type: item.type,
          isFile: item.kind === 'file',
          isImage: item.type.startsWith('image/'),
          matchesPattern: item.kind === 'file' && item.type.startsWith('image/')
        })));

        // Also check clipboard.types for additional info
        console.log('📋 Clipboard types:', event.clipboardData.types);

        for (const item of items) {
          console.log(`🔍 Checking item: kind="${item.kind}", type="${item.type}"`);
          
          // Handle regular file-based images
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            console.log('🖼️ Found regular image file in clipboard:', item.type);
            
            try {
              const file = item.getAsFile();
              console.log('📁 getAsFile() result:', {
                hasFile: !!file,
                name: file?.name,
                size: file?.size,
                type: file?.type,
                lastModified: file?.lastModified
              });
              
              if (file) {
                console.log('✅ Successfully got file object, uploading...');
                
                // Prevent default paste behavior for images
                event.preventDefault();
                
                // Upload the image
                handleImageUpload(file);
                return true;
              } else {
                console.log('❌ getAsFile() returned null/undefined');
              }
            } catch (error) {
              console.error('❌ Error calling getAsFile():', error);
            }
          }
          
          // Handle HTML content (which includes Google Docs images)
          else if (item.kind === 'string' && item.type === 'text/html') {
            console.log('🔍 Found HTML content, checking for images...');
            
            // Prevent default paste behavior immediately for HTML content
            event.preventDefault();
            
            try {
              item.getAsString((htmlData) => {
                console.log('📄 HTML data received:', {
                  hasData: !!htmlData,
                  dataLength: htmlData?.length,
                  containsImg: htmlData?.includes('<img'),
                  htmlPreview: htmlData?.substring(0, 200) + '...'
                });
                
                // Log the complete HTML structure for debugging
                console.log('🔍 Complete HTML structure:', htmlData);
                
                // Check if HTML contains image tags
                if (htmlData && htmlData.includes('<img')) {
                  console.log('🖼️ Found image in HTML content, using comprehensive parser...');
                  
                  // Use comprehensive parser to maintain text/image order
                  parseAndInsertHTML(htmlData);
                } else {
                  console.log('📝 No images found, inserting HTML as text');
                  // If no images, just insert the text content
                  const tempDiv = document.createElement('div');
                  tempDiv.innerHTML = htmlData;
                  const textContent = tempDiv.textContent || tempDiv.innerText || '';
                  
                  if (textContent.trim()) {
                    editor.update(() => {
                      const selection = $getSelection();
                      if ($isRangeSelection(selection)) {
                        const textNode = $createTextNode(textContent);
                        selection.insertNodes([textNode]);
                      }
                    });
                  }
                }
              });
              
              return true; // Always return true to prevent further paste processing
            } catch (error) {
              console.error('❌ Error processing HTML content:', error);
            }
          }
        }

        console.log('❌ No image found in clipboard items');
        return false;
      },
      COMMAND_PRIORITY_LOW
    );

    console.log('✅ Paste handler registered');

    // Cleanup function
    return () => {
      console.log('🗑️ Removing INSERT_IMAGE_COMMAND listener');
      removeInsertImageCommand();
      
      console.log('🗑️ Removing paste handler');
      removePasteCommand();
    };
  }, [editor]);

  // Handle paste events for images
  useEffect(() => {
    console.log('📋 Registering paste handler...');
    
    // Add global debug function
    if (typeof window !== 'undefined') {
      (window as any).debugImagePlugin = () => {
        console.log('🔍 ImagePlugin Debug Info:');
        console.log('  - currentUser:', currentUser);
        console.log('  - editor:', editor);
        console.log('  - isUploading:', isUploading);
        console.log('  - showImageDialog:', showImageDialog);
        
        const sessionId = localStorage.getItem('sessionId');
        console.log('  - sessionId:', sessionId ? sessionId.substring(0, 8) + '...' : 'Not found');
        
        return {
          currentUser,
          hasEditor: !!editor,
          isUploading,
          showImageDialog,
          sessionId: !!sessionId
        };
      };
    }
    
    // No duplicate PASTE_COMMAND handler needed - the main one handles everything
    console.log('✅ Debug functions registered');
  }, [handleImageUpload, currentUser]);

  // Create image versions (thumbnail and medium)
  const createImageVersions = async (file: File): Promise<{ thumbnail: File; medium: File }> => {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const img = new Image();
      
      img.onload = () => {
        try {
          // Create thumbnail (150x150)
          canvas.width = 150;
          canvas.height = 150;
          
          const scale = Math.min(150 / img.width, 150 / img.height);
          const scaledWidth = img.width * scale;
          const scaledHeight = img.height * scale;
          const offsetX = (150 - scaledWidth) / 2;
          const offsetY = (150 - scaledHeight) / 2;
          
          ctx!.fillStyle = '#f0f0f0';
          ctx!.fillRect(0, 0, 150, 150);
          ctx!.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);
          
          canvas.toBlob((thumbnailBlob) => {
            if (!thumbnailBlob) {
              reject(new Error('Failed to create thumbnail'));
              return;
            }
            
            const thumbnailFile = new File([thumbnailBlob], `thumbnail_${file.name}`, {
              type: file.type,
              lastModified: Date.now()
            });
            
            // Create medium version (800px max)
            const maxDimension = 800;
            let mediumWidth = img.width;
            let mediumHeight = img.height;
            
            if (img.width > maxDimension || img.height > maxDimension) {
              const scale = Math.min(maxDimension / img.width, maxDimension / img.height);
              mediumWidth = img.width * scale;
              mediumHeight = img.height * scale;
            }
            
            canvas.width = mediumWidth;
            canvas.height = mediumHeight;
            ctx!.drawImage(img, 0, 0, mediumWidth, mediumHeight);
            
            canvas.toBlob((mediumBlob) => {
              if (!mediumBlob) {
                reject(new Error('Failed to create medium image'));
                return;
              }
              
              const mediumFile = new File([mediumBlob], `medium_${file.name}`, {
                type: file.type,
                lastModified: Date.now()
              });
              
              resolve({ thumbnail: thumbnailFile, medium: mediumFile });
            }, file.type, 0.9);
          }, file.type, 0.9);
        } catch (error) {
          reject(error);
        }
      };
      
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = URL.createObjectURL(file);
    });
  };

  // Add image button to toolbar
  useEffect(() => {
    const toolbarElement = document.querySelector('.lexical-toolbar');
    if (toolbarElement && !toolbarElement.querySelector('.image-toolbar-button')) {
      const imageButton = document.createElement('button');
      imageButton.className = 'lexical-toolbar-button image-toolbar-button';
      imageButton.innerHTML = '🖼️';
      imageButton.title = 'Insert Image';
      imageButton.type = 'button';
      
      imageButton.addEventListener('click', (e) => {
        e.preventDefault();
        setShowImageDialog(true);
      });
      
      toolbarElement.appendChild(imageButton);
    }
    
    return () => {
      const button = document.querySelector('.image-toolbar-button');
      if (button) {
        button.remove();
      }
    };
  }, []);

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
                      <div className="progress-bar">
                        <div 
                          className="progress-fill" 
                          style={{ width: `${uploadProgress}%` }}
                        />
                      </div>
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

          .progress-bar {
            width: 100%;
            height: 20px;
            background: #f0f0f0;
            border-radius: 10px;
            overflow: hidden;
            margin-bottom: 5px;
          }

          .progress-fill {
            height: 100%;
            background: #4CAF50;
            transition: width 0.3s ease;
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

          .image-toolbar-button {
            background: #f8f9fa;
            border: 1px solid #dee2e6;
            border-radius: 4px;
            padding: 6px 12px;
            margin: 0 2px;
            cursor: pointer;
            font-size: 14px;
          }

          .image-toolbar-button:hover {
            background: #e9ecef;
          }
        `
      }} />
    </>
  );
}