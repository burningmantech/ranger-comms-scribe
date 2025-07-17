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

export interface ImagePayload {
  src: string;
  altText?: string;
  width?: string | number;
  height?: string | number;
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
  __fullSizeSrc: string | undefined;
  __thumbnailSrc: string | undefined;
  __mediumSrc: string | undefined;
  __imageId: string | undefined;
  __uploadedBy: string | undefined;
  __uploadedAt: string | undefined;

  static getType(): string {
    return 'image';
  }

  static clone(node: ImageNode): ImageNode {
    return new ImageNode(
      node.__src,
      node.__altText,
      node.__width,
      node.__height,
      node.__fullSizeSrc,
      node.__thumbnailSrc,
      node.__mediumSrc,
      node.__imageId,
      node.__uploadedBy,
      node.__uploadedAt
    );
  }

  constructor(
    src: string,
    altText: string = '',
    width?: string | number,
    height?: string | number,
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

  static importJSON(serializedNode: SerializedImageNode): ImageNode {
    const { 
      src, 
      altText, 
      width, 
      height, 
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
      fullSizeSrc: this.__fullSizeSrc,
      thumbnailSrc: this.__thumbnailSrc,
      mediumSrc: this.__mediumSrc,
      imageId: this.__imageId,
      uploadedBy: this.__uploadedBy,
      uploadedAt: this.__uploadedAt,
      version: 1,
    };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const img = document.createElement('img');
    img.src = this.__src;
    img.alt = this.__altText;
    img.className = 'editor-image';
    img.style.display = 'block';
    img.style.margin = '8px 0';
    
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
      console.log('🖼️ Applied custom dimensions:', { 
        width: img.style.width, 
        height: img.style.height,
        originalWidth: this.__width,
        originalHeight: this.__height
      });
    } else {
      // Only apply responsive defaults when no custom dimensions
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
      console.log('🖼️ Applied responsive defaults');
    }
    
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

  updateDOM(): false {
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