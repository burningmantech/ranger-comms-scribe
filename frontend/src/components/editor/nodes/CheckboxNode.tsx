import React from 'react';
import { EditorConfig, NodeKey, SerializedLexicalNode, Spread, ElementNode, SerializedElementNode, LexicalNode, $createTextNode, $isTextNode, TextNode } from 'lexical';

export type SerializedCheckboxNode = Spread<
  {
    checked: boolean;
    text?: string;
    type: 'checkbox';
  },
  SerializedElementNode
>;

export class CheckboxNode extends ElementNode {
  __checked: boolean;
  __text: string;

  static getType(): string {
    return 'checkbox';
  }

  static clone(node: CheckboxNode): CheckboxNode {
    return new CheckboxNode(node.__checked, node.__text, node.__key);
  }

  constructor(checked: boolean = false, text: string = '', key?: NodeKey) {
    super(key);
    this.__checked = checked;
    this.__text = text;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = document.createElement('div');
    element.className = config.theme.checkbox || 'editor-checkbox';
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.__checked;
    // Make checkbox clickable 
    checkbox.contentEditable = 'false';
    checkbox.addEventListener('change', () => {
      const event = new CustomEvent('checkboxChange', {
        detail: { nodeKey: this.__key, checked: checkbox.checked },
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
    });
    
    // Create a span for text content that is editable
    const label = document.createElement('span');
    label.className = 'checkbox-text';
    // Make the text portion editable
    label.contentEditable = 'true';
    
    element.appendChild(checkbox);
    element.appendChild(label);
    
    return element;
  }

  updateDOM(prevNode: CheckboxNode, dom: HTMLElement): boolean {
    const checkbox = dom.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (checkbox && this.__checked !== prevNode.__checked) {
      checkbox.checked = this.__checked;
    }
    return false;
  }

  setChecked(checked: boolean): void {
    const self = this.getWritable();
    self.__checked = checked;
  }

  getChecked(): boolean {
    return this.__checked;
  }

  setText(text: string): void {
    const self = this.getWritable();
    self.__text = text;
  }

  getText(): string {
    return this.__text;
  }

  decorate(): React.ReactElement {
    return (
      <CheckboxComponent
        checked={this.__checked}
        text={this.__text}
        nodeKey={this.__key}
      />
    );
  }

  exportJSON(): SerializedCheckboxNode {
    return {
      ...super.exportJSON(),
      checked: this.__checked,
      text: this.__text,
      type: 'checkbox',
    };
  }

  static importJSON(serializedNode: SerializedCheckboxNode): CheckboxNode {
    const node = $createCheckboxNode(serializedNode.checked, serializedNode.text);
    return node;
  }

  insertNewAfter(selection: any): ElementNode {
    const newElement = $createCheckboxNode(false);
    this.insertAfter(newElement);
    return newElement;
  }
}

function CheckboxComponent({
  checked,
  text,
  nodeKey,
}: {
  checked: boolean;
  text: string;
  nodeKey: NodeKey;
}): React.ReactElement {
  return (
    <div className="checkbox-component">
      <input 
        type="checkbox" 
        checked={checked} 
        onChange={e => {
          const checkboxElement = document.querySelector(`[data-lexical-node-key="${nodeKey}"]`);
          if (checkboxElement) {
            const event = new CustomEvent('checkboxChange', {
              detail: { nodeKey, checked: e.target.checked },
              bubbles: true,
              cancelable: true,
            });
            checkboxElement.dispatchEvent(event);
          }
        }}
      />
      <span className="checkbox-text">{text}</span>
    </div>
  );
}

export function $createCheckboxNode(checked: boolean = false, text: string = ''): CheckboxNode {
  return new CheckboxNode(checked, text);
}

export function $isCheckboxNode(node: LexicalNode | null | undefined): node is CheckboxNode {
  return node instanceof CheckboxNode;
}