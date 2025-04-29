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
}

export type SerializedImageNode = Spread<
  {
    src: string;
    altText: string;
    width?: string | number;
    height?: string | number;
    fullSizeSrc?: string;
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

  static getType(): string {
    return 'image';
  }

  static clone(node: ImageNode): ImageNode {
    return new ImageNode(
      node.__src,
      node.__altText,
      node.__width,
      node.__height,
      node.__fullSizeSrc
    );
  }

  constructor(
    src: string,
    altText: string = '',
    width?: string | number,
    height?: string | number,
    fullSizeSrc?: string,
    key?: NodeKey,
  ) {
    super(key);
    this.__src = src;
    this.__altText = altText;
    this.__width = width;
    this.__height = height;
    this.__fullSizeSrc = fullSizeSrc;
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

  static importJSON(serializedNode: SerializedImageNode): ImageNode {
    const { src, altText, width, height, fullSizeSrc } = serializedNode;
    return new ImageNode(src, altText, width, height, fullSizeSrc);
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
      version: 1,
    };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.className = 'editor-image-wrapper';
    return span;
  }

  updateDOM(): false {
    return false;
  }

  getTextContent(): string {
    return '';
  }
}