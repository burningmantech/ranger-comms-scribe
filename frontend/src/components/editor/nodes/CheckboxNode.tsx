import { EditorConfig, NodeKey, SerializedLexicalNode, Spread, ElementNode, SerializedElementNode, LexicalNode } from 'lexical';

export type SerializedCheckboxNode = Spread<
  {
    checked: boolean;
    type: 'checkbox';
  },
  SerializedElementNode
>;

export class CheckboxNode extends ElementNode {
  __checked: boolean;

  static getType(): string {
    return 'checkbox';
  }

  static clone(node: CheckboxNode): CheckboxNode {
    return new CheckboxNode(node.__checked, node.__key);
  }

  constructor(checked: boolean = false, key?: NodeKey) {
    super(key);
    this.__checked = checked;
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
    const checkbox = dom.querySelector('input');
    if (checkbox && checkbox.checked !== this.__checked) {
      checkbox.checked = this.__checked;
    }
    return false;
  }

  setChecked(checked: boolean): void {
    const writable = this.getWritable();
    writable.__checked = checked;
  }

  getChecked(): boolean {
    return this.__checked;
  }

  static importJSON(serializedNode: SerializedCheckboxNode): CheckboxNode {
    const node = new CheckboxNode(serializedNode.checked);
    // Import any additional properties if needed
    return node;
  }

  exportJSON(): SerializedCheckboxNode {
    return {
      ...super.exportJSON(),
      checked: this.__checked,
      type: 'checkbox',
    };
  }
}

// Utility functions for creating and checking CheckboxNodes
export function $createCheckboxNode(checked: boolean = false): CheckboxNode {
  return new CheckboxNode(checked);
}

export function $isCheckboxNode(node: LexicalNode | null | undefined): node is CheckboxNode {
  return node instanceof CheckboxNode;
}