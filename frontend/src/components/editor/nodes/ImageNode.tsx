import React from 'react';
import { 
  EditorConfig, 
  NodeKey, 
  SerializedLexicalNode, 
  Spread, 
  ElementNode, 
  SerializedElementNode,
  ElementFormatType
} from 'lexical';

export type ImageAlignment = 'none' | 'left' | 'center' | 'right';

export interface ImagePayload {
  src: string;
  altText?: string;
  width?: string | number;
  height?: string | number;
  alignment?: ImageAlignment;
  fullSizeSrc?: string;
  thumbnailSrc?: string;
  mediumSrc?: string;
  imageId?: string;
  uploadedBy?: string;
  uploadedAt?: string;
}

export type SerializedImageNode = Spread<
  {
    src: string;
    altText: string;
    width?: string | number;
    height?: string | number;
    alignment?: ImageAlignment;
    fullSizeSrc?: string;
    thumbnailSrc?: string;
    mediumSrc?: string;
    imageId?: string;
    uploadedBy?: string;
    uploadedAt?: string;
    type: 'image';
    version: 1;
    children: SerializedLexicalNode[];
    direction: 'ltr' | 'rtl' | null;
    format: ElementFormatType;
    indent: number;
  },
  SerializedElementNode
>;

// We'll use ElementNode instead of LexicalNode
export class ImageNode extends ElementNode {
  __src: string;
  __altText: string;
  __width: string | number | undefined;
  __height: string | number | undefined;
  __alignment: ImageAlignment;
  __fullSizeSrc: string | undefined;
  __thumbnailSrc: string | undefined;
  __mediumSrc: string | undefined;
  __imageId: string | undefined;
  __uploadedBy: string | undefined;
  __uploadedAt: string | undefined;

  static getType(): string {
    return 'image';
  }

  // Block-level image — not inline
  isInline(): boolean {
    return false;
  }

  // Image has no text children
  canBeEmpty(): boolean {
    return true;
  }

  // Prevent text insertion directly before/after within the same container
  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }

  // Treat as an isolated, non-editable block
  isIsolated(): boolean {
    return true;
  }

  static clone(node: ImageNode): ImageNode {
    return new ImageNode(
      node.__src,
      node.__altText,
      node.__width,
      node.__height,
      node.__alignment,
      node.__fullSizeSrc,
      node.__thumbnailSrc,
      node.__mediumSrc,
      node.__imageId,
      node.__uploadedBy,
      node.__uploadedAt,
      node.__key
    );
  }

  constructor(
    src: string,
    altText: string = '',
    width?: string | number,
    height?: string | number,
    alignment?: ImageAlignment,
    fullSizeSrc?: string,
    thumbnailSrc?: string,
    mediumSrc?: string,
    imageId?: string,
    uploadedBy?: string,
    uploadedAt?: string,
    key?: NodeKey,
  ) {
    super(key);
    this.__src = src;
    this.__altText = altText;
    this.__width = width;
    this.__height = height;
    this.__alignment = alignment || 'none';
    this.__fullSizeSrc = fullSizeSrc;
    this.__thumbnailSrc = thumbnailSrc;
    this.__mediumSrc = mediumSrc;
    this.__imageId = imageId;
    this.__uploadedBy = uploadedBy;
    this.__uploadedAt = uploadedAt;
  }

  getSrc(): string {
    return this.__src;
  }

  getAltText(): string {
    return this.__altText;
  }

  getWidth(): string | number | undefined {
    return this.__width;
  }

  getHeight(): string | number | undefined {
    return this.__height;
  }

  getFullSizeSrc(): string | undefined {
    return this.__fullSizeSrc || this.__src;
  }

  getThumbnailSrc(): string | undefined {
    return this.__thumbnailSrc;
  }

  getMediumSrc(): string | undefined {
    return this.__mediumSrc;
  }

  getImageId(): string | undefined {
    return this.__imageId;
  }

  getUploadedBy(): string | undefined {
    return this.__uploadedBy;
  }

  getUploadedAt(): string | undefined {
    return this.__uploadedAt;
  }

  setWidthAndHeight(width: number, height: number): void {
    const writable = this.getWritable();
    writable.__width = width;
    writable.__height = height;
  }

  setAltText(altText: string): void {
    const writable = this.getWritable();
    writable.__altText = altText;
  }

  getAlignment(): ImageAlignment {
    return this.__alignment;
  }

  setAlignment(alignment: ImageAlignment): void {
    const writable = this.getWritable();
    writable.__alignment = alignment;
  }

  static importJSON(serializedNode: SerializedImageNode): ImageNode {
    const {
      src,
      altText,
      width,
      height,
      alignment,
      fullSizeSrc,
      thumbnailSrc,
      mediumSrc,
      imageId,
      uploadedBy,
      uploadedAt
    } = serializedNode;
    return new ImageNode(
      src,
      altText,
      width,
      height,
      alignment,
      fullSizeSrc,
      thumbnailSrc,
      mediumSrc,
      imageId,
      uploadedBy,
      uploadedAt
    );
  }

  exportJSON(): SerializedImageNode {
    return {
      ...super.exportJSON(),
      type: 'image',
      src: this.__src,
      altText: this.__altText,
      width: this.__width,
      height: this.__height,
      alignment: this.__alignment,
      fullSizeSrc: this.__fullSizeSrc,
      thumbnailSrc: this.__thumbnailSrc,
      mediumSrc: this.__mediumSrc,
      imageId: this.__imageId,
      uploadedBy: this.__uploadedBy,
      uploadedAt: this.__uploadedAt,
      version: 1,
    };
  }

  _applyAlignment(img: HTMLImageElement): void {
    // Reset alignment styles
    img.style.float = '';
    img.style.display = '';
    img.style.margin = '';
    img.classList.remove('editor-image-align-left', 'editor-image-align-right', 'editor-image-align-center');

    switch (this.__alignment) {
      case 'left':
        img.style.float = 'left';
        img.style.margin = '4px 16px 8px 0';
        img.classList.add('editor-image-align-left');
        break;
      case 'right':
        img.style.float = 'right';
        img.style.margin = '4px 0 8px 16px';
        img.classList.add('editor-image-align-right');
        break;
      case 'center':
        img.style.display = 'block';
        img.style.margin = '8px auto';
        img.classList.add('editor-image-align-center');
        break;
      default: // 'none'
        img.style.display = 'block';
        img.style.margin = '8px 0';
        break;
    }
  }

  createDOM(config: EditorConfig): HTMLElement {
    const img = document.createElement('img');
    img.src = this.__src;
    img.alt = this.__altText;
    img.className = 'editor-image';

    // Handle dimensions with priority over defaults
    if (this.__width || this.__height) {
      // If custom dimensions are provided, use them exactly
      if (this.__width) {
        const width = typeof this.__width === 'number' ? `${this.__width}px` :
                     this.__width.toString().includes('px') ? this.__width : `${this.__width}px`;
        img.style.width = width;
      }
      if (this.__height) {
        const height = typeof this.__height === 'number' ? `${this.__height}px` :
                      this.__height.toString().includes('px') ? this.__height : `${this.__height}px`;
        img.style.height = height;
      }

      // Don't set maxWidth when custom dimensions are specified to avoid scaling conflicts
    } else {
      // Only apply responsive defaults when no custom dimensions
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
    }

    // Apply alignment
    this._applyAlignment(img);

    // Enable native drag-and-drop repositioning
    img.draggable = true;
    img.dataset.lexicalImageKey = this.getKey();

    // Add image metadata as data attributes
    if (this.__imageId) {
      img.dataset.imageId = this.__imageId;
    }
    if (this.__uploadedBy) {
      img.dataset.uploadedBy = this.__uploadedBy;
    }
    if (this.__uploadedAt) {
      img.dataset.uploadedAt = this.__uploadedAt;
    }
    if (this.__fullSizeSrc) {
      img.dataset.fullSrc = this.__fullSizeSrc;
    }
    if (this.__thumbnailSrc) {
      img.dataset.thumbnailSrc = this.__thumbnailSrc;
    }
    if (this.__mediumSrc) {
      img.dataset.mediumSrc = this.__mediumSrc;
    }
    
    return img;
  }

  updateDOM(prevNode: ImageNode, dom: HTMLElement): false {
    const img = dom as HTMLImageElement;
    if (prevNode.__width !== this.__width || prevNode.__height !== this.__height) {
      if (this.__width) {
        const width = typeof this.__width === 'number' ? `${this.__width}px` :
                     this.__width.toString().includes('px') ? this.__width : `${this.__width}px`;
        img.style.width = width;
      }
      if (this.__height) {
        const height = typeof this.__height === 'number' ? `${this.__height}px` :
                      this.__height.toString().includes('px') ? this.__height : `${this.__height}px`;
        img.style.height = height;
      }
    }
    if (prevNode.__altText !== this.__altText) {
      img.alt = this.__altText;
    }
    if (prevNode.__alignment !== this.__alignment) {
      this._applyAlignment(img);
    }
    return false;
  }

  getTextContent(): string {
    return this.__altText || '';
  }

  // Helper method to get image info for tracking changes
  getImageInfo(): ImagePayload {
    return {
      src: this.__src,
      altText: this.__altText,
      width: this.__width,
      height: this.__height,
      alignment: this.__alignment,
      fullSizeSrc: this.__fullSizeSrc,
      thumbnailSrc: this.__thumbnailSrc,
      mediumSrc: this.__mediumSrc,
      imageId: this.__imageId,
      uploadedBy: this.__uploadedBy,
      uploadedAt: this.__uploadedAt
    };
  }
}

// Factory function to create ImageNode instances
export function $createImageNode(payload: ImagePayload): ImageNode {
  return new ImageNode(
    payload.src,
    payload.altText || '',
    payload.width,
    payload.height,
    payload.alignment,
    payload.fullSizeSrc,
    payload.thumbnailSrc,
    payload.mediumSrc,
    payload.imageId,
    payload.uploadedBy,
    payload.uploadedAt
  );
}

// Helper function to check if a node is an ImageNode
export function $isImageNode(node: any): node is ImageNode {
  return node instanceof ImageNode;
}