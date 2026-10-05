import {
  $copyNode,
  $createParagraphNode,
  $getSelection,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  DOMConversionMap,
  DOMConversionOutput,
  DOMExportOutput,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
  ElementNode,
  SerializedElementNode,
  ElementFormatType
} from 'lexical';
import { $isHeadingNode, $isQuoteNode } from '@lexical/rich-text';
import { $dfs } from '@lexical/utils';
import {
  classifyImageSrc,
  newPendingImageId,
  parseImageDimension,
  PENDING_IMAGE_STALE_MS,
  registerPendingImageSource,
  skeletonImageDataUrl,
  takePendingImageSource,
} from '../utils/imageImport';

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
    /** Set while the image is still being imported (a skeleton); never permanent content. */
    pending?: true;
    /** When the placeholder was created (ms since epoch), so orphans can be cleaned up. */
    pendingSince?: number;
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
  /** Non-null while this is an import placeholder: when it was created (ms since epoch). */
  __pendingSince: number | null;

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
      node.__pendingSince,
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
    pendingSince: number | null = null,
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
    this.__pendingSince = pendingSince;
  }

  /** True while this is a placeholder for an image that is still being imported. */
  isPending(): boolean {
    return this.__pendingSince !== null;
  }

  getPendingSince(): number | null {
    return this.__pendingSince;
  }

  /** A placeholder nobody finished in time (its uploader left mid-import). */
  isStalePending(now: number = Date.now()): boolean {
    return this.__pendingSince !== null && now - this.__pendingSince > PENDING_IMAGE_STALE_MS;
  }

  /** Swap an import placeholder for the uploaded gallery image (keeps size, alignment and alt text). */
  completeImport(uploaded: Pick<ImagePayload, 'src' | 'fullSizeSrc' | 'thumbnailSrc' | 'mediumSrc' | 'imageId' | 'uploadedBy' | 'uploadedAt'>): void {
    const writable = this.getWritable();
    writable.__src = uploaded.src;
    writable.__fullSizeSrc = uploaded.fullSizeSrc;
    writable.__thumbnailSrc = uploaded.thumbnailSrc;
    writable.__mediumSrc = uploaded.mediumSrc;
    writable.__imageId = uploaded.imageId;
    writable.__uploadedBy = uploaded.uploadedBy;
    writable.__uploadedAt = uploaded.uploadedAt;
    writable.__pendingSince = null;
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
      uploadedAt,
      pending,
      pendingSince
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
      uploadedAt,
      pending ? (typeof pendingSince === 'number' ? pendingSince : 0) : null
    );
  }

  /** `<img>` from pasted or loaded HTML. Gallery images are kept; anything else becomes a placeholder. */
  static importDOM(): DOMConversionMap | null {
    return {
      img: () => ({ conversion: $convertImageElement, priority: 0 }),
    };
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    if (this.isPending()) return { element: null };
    return super.exportDOM(editor);
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
      ...(this.__pendingSince !== null ? { pending: true as const, pendingSince: this.__pendingSince } : {}),
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
    img.alt = this.__altText;
    img.className = 'editor-image';
    if (this.isPending()) {
      const w = typeof this.__width === 'number' ? this.__width : parseImageDimension(this.__width);
      const h = typeof this.__height === 'number' ? this.__height : parseImageDimension(this.__height);
      img.src = skeletonImageDataUrl(w, h);
      img.classList.add('editor-image-pending');
      img.dataset.pending = 'true';
      img.title = 'Importing image…';
      // An orphaned placeholder (its uploader left) shows nothing until it is cleaned up.
      if (this.isStalePending()) img.style.visibility = 'hidden';
    } else {
      img.src = this.__src;
    }

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

  updateDOM(prevNode: ImageNode, dom: HTMLElement): boolean {
    // A finished import (or any new source) gets a fresh <img>.
    if (prevNode.__src !== this.__src || prevNode.__pendingSince !== this.__pendingSince) {
      return true;
    }
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

/**
 * A placeholder for an image that is still being imported. Its imageId identifies it; the
 * source (URL or File) is kept by the creating client (see utils/imageImport), never in the doc.
 */
export function $createPendingImageNode(payload: Pick<ImagePayload, 'altText' | 'width' | 'height'> = {}): ImageNode {
  return new ImageNode(
    '',
    payload.altText || '',
    payload.width,
    payload.height,
    undefined,
    undefined,
    undefined,
    undefined,
    newPendingImageId(),
    undefined,
    undefined,
    Date.now()
  );
}

function $convertImageElement(domNode: HTMLElement): DOMConversionOutput {
  const img = domNode as HTMLImageElement;
  const src = (img.getAttribute('src') || '').trim();
  if (!src) return { node: null };

  const altText = img.getAttribute('alt') || '';
  const width = parseImageDimension(img.getAttribute('width')) ?? parseImageDimension(img.style?.width);
  const height = parseImageDimension(img.getAttribute('height')) ?? parseImageDimension(img.style?.height);

  if (classifyImageSrc(src) === 'gallery') {
    const data = img.dataset || {};
    return {
      node: $createImageNode({
        src,
        altText,
        width,
        height,
        fullSizeSrc: data.fullSrc,
        thumbnailSrc: data.thumbnailSrc,
        mediumSrc: data.mediumSrc,
        imageId: data.imageId,
        uploadedBy: data.uploadedBy,
        uploadedAt: data.uploadedAt,
      }),
    };
  }

  const node = $createPendingImageNode({ altText, width, height });
  registerPendingImageSource(node.getImageId()!, { kind: 'url', src });
  return { node };
}

/**
 * Pasted HTML puts images inside paragraphs (`<p><span><img></span></p>`); an image is a
 * block, so split the paragraph (or heading/quote) around it. Registered as a node transform
 * by ImagePlugin. Transforms don't run on Yjs updates, so only the editing client does this.
 */
export function $hoistImageFromTextBlock(image: ImageNode): void {
  const parent = image.getParent();
  if (!parent || !($isParagraphNode(parent) || $isHeadingNode(parent) || $isQuoteNode(parent))) {
    return;
  }

  const after = image.getNextSiblings();
  if (after.length > 0) {
    const tail = $copyNode(parent);
    tail.append(...after);
    const first = tail.getFirstChild();
    if ($isLineBreakNode(first)) first.remove();
    parent.insertAfter(tail);
  }
  parent.insertAfter(image);
  const last = parent.getLastChild();
  if ($isLineBreakNode(last)) last.remove();
  if (parent.getChildrenSize() === 0) parent.remove();

  $moveCaretOutOfImage(image);
}

/** An image has no text: a caret left inside it (e.g. after a paste) moves to the next block. */
export function $moveCaretOutOfImage(image: ImageNode): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const key = image.getKey();
  if (selection.anchor.key !== key && selection.focus.key !== key) return;

  let next: LexicalNode | null = image.getNextSibling();
  if (!next || $isImageNode(next)) {
    next = $createParagraphNode();
    image.insertAfter(next);
  }
  next.selectStart();
}

// Helper function to check if a node is an ImageNode
export function $isImageNode(node: any): node is ImageNode {
  return node instanceof ImageNode;
}

/** Every import placeholder in the document (or under `start`). */
export function $getPendingImageNodes(start?: LexicalNode): ImageNode[] {
  return $dfs(start)
    .map(({ node }) => node)
    .filter((node): node is ImageNode => $isImageNode(node) && node.isPending());
}

/**
 * For HTML or JSON loaded as saved content (not pasted): nobody will upload these, so an image
 * from pasted-in-the-past HTML keeps its original https/data address, anything else is dropped,
 * and so is any leftover placeholder from saved JSON (its uploader is gone).
 */
export function $settlePendingImages(start?: LexicalNode): void {
  for (const node of $getPendingImageNodes(start)) {
    const source = takePendingImageSource(node.getImageId() || '');
    const kind = source?.kind === 'url' ? classifyImageSrc(source.src) : 'unsupported';
    if (source?.kind === 'url' && (kind === 'remote' || kind === 'data')) {
      node.completeImport({ src: source.src, fullSizeSrc: source.src });
    } else {
      node.remove();
    }
  }
}
