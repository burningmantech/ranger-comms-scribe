import React from 'react';
import {
  DecoratorNode,
  EditorConfig,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical';

export interface FormattedSegment {
  text: string;
  format: number; // Lexical format bitmask: 1=bold, 2=italic, 4=strikethrough, 8=underline, 16=code, 32=subscript, 64=superscript
  style?: string;
}

export interface DeletedTextPayload {
  changeId: string;
  deletedText: string;
  authorName?: string;
  authorColor?: string;
  isBlockLevel?: boolean;
  /** Optional formatted segments preserving bold/italic from the original text */
  formattedSegments?: FormattedSegment[];
}

export type SerializedDeletedTextNode = Spread<
  {
    changeId: string;
    deletedText: string;
    authorName?: string;
    authorColor?: string;
    isBlockLevel?: boolean;
    formattedSegments?: FormattedSegment[];
    type: 'deleted-text';
    version: 1;
  },
  SerializedLexicalNode
>;

export class DeletedTextNode extends DecoratorNode<React.ReactElement> {
  __changeId: string;
  __deletedText: string;
  __authorName?: string;
  __authorColor?: string;
  __isBlockLevel: boolean;
  __formattedSegments?: FormattedSegment[];

  static getType(): string {
    return 'deleted-text';
  }

  static clone(node: DeletedTextNode): DeletedTextNode {
    return new DeletedTextNode(
      node.__changeId,
      node.__deletedText,
      node.__authorName,
      node.__authorColor,
      node.__isBlockLevel,
      node.__formattedSegments,
      node.__key,
    );
  }

  constructor(
    changeId: string,
    deletedText: string,
    authorName?: string,
    authorColor?: string,
    isBlockLevel: boolean = false,
    formattedSegments?: FormattedSegment[],
    key?: NodeKey,
  ) {
    super(key);
    this.__changeId = changeId;
    this.__deletedText = deletedText;
    this.__authorName = authorName;
    this.__authorColor = authorColor;
    this.__isBlockLevel = isBlockLevel;
    this.__formattedSegments = formattedSegments;
  }

  static importJSON(serializedNode: SerializedDeletedTextNode): DeletedTextNode {
    return $createDeletedTextNode({
      changeId: serializedNode.changeId,
      deletedText: serializedNode.deletedText,
      authorName: serializedNode.authorName,
      authorColor: serializedNode.authorColor,
      isBlockLevel: serializedNode.isBlockLevel,
      formattedSegments: serializedNode.formattedSegments,
    });
  }

  exportJSON(): SerializedDeletedTextNode {
    return {
      changeId: this.__changeId,
      deletedText: this.__deletedText,
      authorName: this.__authorName,
      authorColor: this.__authorColor,
      isBlockLevel: this.__isBlockLevel,
      formattedSegments: this.__formattedSegments,
      type: 'deleted-text',
      version: 1,
    } as SerializedDeletedTextNode;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement(this.__isBlockLevel ? 'div' : 'span');
    element.className = 'tracked-deletion-wrapper';
    element.setAttribute('data-change-id', this.__changeId);
    element.setAttribute('spellcheck', 'false');
    element.setAttribute('contenteditable', 'false');
    // Set initial transition-ready properties for smooth acceptance animation.
    // opacity and max-height are animated by removeDecorationsForChangeAnimated().
    element.style.opacity = '1';
    element.style.overflow = 'visible';
    return element;
  }

  updateDOM(): false {
    return false;
  }

  isInline(): boolean {
    return !this.__isBlockLevel;
  }

  getTextContent(): string {
    // Return empty string so deleted text doesn't count toward char counts
    return '';
  }

  getChangeId(): string {
    return this.__changeId;
  }

  setChangeId(changeId: string): void {
    const writable = this.getWritable();
    writable.__changeId = changeId;
  }

  getDeletedText(): string {
    return this.__deletedText;
  }

  getAuthorName(): string | undefined {
    return this.__authorName;
  }

  getFormattedSegments(): FormattedSegment[] | undefined {
    return this.__formattedSegments;
  }

  decorate(): React.ReactElement {
    return (
      <DeletedTextComponent
        changeId={this.__changeId}
        deletedText={this.__deletedText}
        authorName={this.__authorName}
        authorColor={this.__authorColor}
        isBlockLevel={this.__isBlockLevel}
        formattedSegments={this.__formattedSegments}
        nodeKey={this.__key}
      />
    );
  }
}

interface DeletedTextComponentProps {
  changeId: string;
  deletedText: string;
  authorName?: string;
  authorColor?: string;
  isBlockLevel?: boolean;
  formattedSegments?: FormattedSegment[];
  nodeKey: NodeKey;
}

/** Apply Lexical format bitmask to inline styles */
function formatStyle(format: number): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (format & 1) style.fontWeight = 'bold';
  if (format & 2) style.fontStyle = 'italic';
  if (format & 8) style.textDecoration = 'underline';
  if (format & 16) { style.fontFamily = 'monospace'; style.fontSize = '0.9em'; }
  return style;
}

function DeletedTextComponent({
  changeId,
  deletedText,
  authorName,
  authorColor,
  isBlockLevel,
  formattedSegments,
  nodeKey,
}: DeletedTextComponentProps): React.ReactElement {
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const element = document.querySelector(`[data-lexical-node-key="${nodeKey}"]`);
    if (element) {
      const event = new CustomEvent('tracked-change-click', {
        detail: { changeId },
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
    }
  };

  // Fall back to red if no authorColor provided (backward compat)
  const color = authorColor || '#d32f2f';
  const bgColor = color + '14'; // ~8% opacity hex suffix

  const Wrapper = isBlockLevel ? 'div' : 'span';

  // Render formatted segments if available, otherwise fall back to plain text
  const renderContent = () => {
    if (formattedSegments && formattedSegments.length > 0) {
      return formattedSegments.map((seg, i) => {
        const parts = seg.text.split('\n');
        const style = seg.format ? formatStyle(seg.format) : undefined;
        return (
          <React.Fragment key={i}>
            {parts.map((part, j) => (
              <React.Fragment key={j}>
                {style ? <span style={style}>{part}</span> : part}
                {j < parts.length - 1 && <br />}
              </React.Fragment>
            ))}
          </React.Fragment>
        );
      });
    }

    // Plain text fallback
    const parts = deletedText.split('\n');
    return parts.map((part, i) => (
      <React.Fragment key={i}>
        {part}
        {i < parts.length - 1 && <br />}
      </React.Fragment>
    ));
  };

  const parts = deletedText.split('\n');

  return (
    <Wrapper
      className={`tracked-deletion${isBlockLevel || parts.length > 1 ? ' tracked-deletion-block' : ''}`}
      data-change-id={changeId}
      contentEditable={false}
      spellCheck={false}
      onClick={handleClick}
      title={authorName ? `Deleted by ${authorName}` : 'Deleted text'}
      style={{ color, backgroundColor: bgColor }}
    >
      {renderContent()}
    </Wrapper>
  );
}

export function $createDeletedTextNode(payload: DeletedTextPayload): DeletedTextNode {
  return new DeletedTextNode(
    payload.changeId,
    payload.deletedText,
    payload.authorName,
    payload.authorColor,
    payload.isBlockLevel || false,
    payload.formattedSegments,
  );
}

export function $isDeletedTextNode(node: LexicalNode | null | undefined): node is DeletedTextNode {
  return node instanceof DeletedTextNode;
}
