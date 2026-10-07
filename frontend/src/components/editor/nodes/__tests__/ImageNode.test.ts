import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  createEditor,
  LexicalEditor,
} from 'lexical';
import { $generateNodesFromDOM } from '@lexical/html';
import { $insertGeneratedNodes } from '@lexical/clipboard';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListItemNode, ListNode } from '@lexical/list';
import { LinkNode } from '@lexical/link';
import {
  $createImageNode,
  $createPendingImageNode,
  $getPendingImageNodes,
  $hoistImageFromTextBlock,
  $isImageNode,
  $settlePendingImages,
  ImageNode,
  SerializedImageNode,
} from '../ImageNode';
import {
  classifyImageSrc,
  dataUrlToFile,
  PENDING_IMAGE_STALE_MS,
  takePendingImageSource,
} from '../../utils/imageImport';
import { $populateRootFromSavedContent } from '../../collab/YjsCollaboration';
import * as Y from 'yjs';
import { createBinding, Provider, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from '@lexical/yjs';

const OWN = new Set(['https://scrivenly.com', 'http://localhost:3000']);
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeEditor(withHoist = false): LexicalEditor {
  const editor = createEditor({
    namespace: 'image-node-test',
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, ImageNode],
    onError: (e) => {
      throw e;
    },
  });
  if (withHoist) editor.registerNodeTransform(ImageNode, $hoistImageFromTextBlock);
  return editor;
}

function importHtml(editor: LexicalEditor, html: string) {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  let images: ImageNode[] = [];
  editor.update(
    () => {
      const nodes = $generateNodesFromDOM(editor, dom);
      $getRoot().clear().append(...nodes);
      images = $getPendingImageNodes();
    },
    { discrete: true },
  );
  return images;
}

/** Simulate RichTextPlugin's paste: insert HTML at the caret in an empty paragraph. */
function pasteHtml(editor: LexicalEditor, html: string) {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      $getRoot().clear().append(paragraph);
      paragraph.select();
      $insertGeneratedNodes(editor, $generateNodesFromDOM(editor, dom), $getSelection()!);
    },
    { discrete: true },
  );
}

const shape = (editor: LexicalEditor) =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map((n) => (n.getType() === 'image' ? 'image' : `${n.getType()}:${n.getTextContent()}`)),
  );

// Google Docs clipboard HTML, trimmed: everything sits in a <b id="docs-internal-guid-..."> and each
// image is a <span> inside a <p>.
const GOOGLE_DOCS_HTML = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234">
<h2 dir="ltr"><span style="font-size:16pt;">A heading</span></h2>
<p dir="ltr"><span style="font-weight:700;">Bold intro</span></p>
<p dir="ltr"><span style="font-size:11pt;"><span style="border:none;display:inline-block;overflow:hidden;width:624px;height:351px;"><img src="https://lh7-rt.googleusercontent.com/docsz/AD_4nX-abc?key=xyz" width="624" height="351" style="margin-left:0px;margin-top:0px;"></span></span></p>
<p dir="ltr"><span>Text before</span><span><img src="https://lh7-rt.googleusercontent.com/docsz/second?key=1" width="100" height="50"></span><span>text after</span></p>
</b>`;

describe('classifyImageSrc', () => {
  it.each([
    ['/api/gallery/123_cat.png', 'gallery'],
    ['https://scrivenly.com/api/gallery/123_cat.png', 'gallery'],
    ['http://localhost:3000/api/gallery/1.png', 'gallery'],
    ['https://other.example.com/api/gallery/1.png', 'remote'],
    ['https://lh7-rt.googleusercontent.com/docsz/abc?key=1', 'remote'],
    ['https://docs.google.com/drawings/d/abc/image?w=1', 'remote'],
    ['https://upload.wikimedia.org/a/b/cat.jpg', 'remote'],
    [PNG_1PX, 'data'],
    ['data:image/jpeg;base64,/9j/4AAQ', 'data'],
    ['data:image/svg+xml;utf8,<svg></svg>', 'unsupported'],
    ['data:text/html;base64,PGgxPg==', 'unsupported'],
    ['http://example.com/cat.png', 'unsupported'],
    ['file:///Users/me/Pictures/cat.png', 'unsupported'],
    ['blob:https://scrivenly.com/1b2c3d', 'blob'],
    ['blob:https://evil.example.com/1b2c3d', 'unsupported'],
    ['images/cat.png', 'unsupported'],
    ['', 'unsupported'],
    ['javascript:alert(1)', 'unsupported'],
  ])('%s -> %s', (src, kind) => {
    expect(classifyImageSrc(src, OWN)).toBe(kind);
  });
});

describe('ImageNode.importDOM', () => {
  it('turns every non-gallery <img> into a placeholder and remembers its source on this client', () => {
    const editor = makeEditor();
    const images = importHtml(editor, GOOGLE_DOCS_HTML);
    expect(images).toHaveLength(2);

    editor.getEditorState().read(() => {
      const [first, second] = $getPendingImageNodes();
      expect(first.isPending()).toBe(true);
      expect(first.getSrc()).toBe(''); // the source URL is not put in the document
      expect(first.getWidth()).toBe(624);
      expect(first.getHeight()).toBe(351);
      expect(first.getImageId()).toMatch(/^pending-/);
      expect(takePendingImageSource(first.getImageId()!)).toEqual({
        kind: 'url',
        src: 'https://lh7-rt.googleusercontent.com/docsz/AD_4nX-abc?key=xyz',
      });
      // Taken once: only one client (and one job) can own it.
      expect(takePendingImageSource(first.getImageId()!)).toBeUndefined();
      expect(takePendingImageSource(second.getImageId()!)).toEqual({
        kind: 'url',
        src: 'https://lh7-rt.googleusercontent.com/docsz/second?key=1',
      });
    });
  });

  it('keeps gallery images as finished images, with their metadata', () => {
    const editor = makeEditor();
    importHtml(
      editor,
      '<p><img src="/api/gallery/1_cat.png" alt="Cat" data-image-id="m1" data-thumbnail-src="/api/gallery/1_cat.png/thumbnail" style="width: 200px; height: 100px"></p>',
    );
    editor.getEditorState().read(() => {
      expect($getPendingImageNodes()).toHaveLength(0);
      const image = $getRoot().getFirstChildOrThrow<any>().getFirstChild() as ImageNode;
      expect($isImageNode(image)).toBe(true);
      expect(image.getSrc()).toBe('/api/gallery/1_cat.png');
      expect(image.getAltText()).toBe('Cat');
      expect(image.getImageId()).toBe('m1');
      expect(image.getThumbnailSrc()).toBe('/api/gallery/1_cat.png/thumbnail');
      expect(image.getWidth()).toBe(200);
      expect(image.getHeight()).toBe(100);
    });
  });

  it('makes placeholders for data: images and ignores <img> without a src', () => {
    const editor = makeEditor();
    const images = importHtml(editor, `<p><img src="${PNG_1PX}"><img alt="no src"></p>`);
    expect(images).toHaveLength(1);
    editor.getEditorState().read(() => {
      expect(takePendingImageSource($getPendingImageNodes()[0].getImageId()!)).toEqual({ kind: 'url', src: PNG_1PX });
    });
  });
});

describe('pasting HTML with images (built-in paste path + hoist transform)', () => {
  it('keeps text, formatting and images in order, each image its own block', () => {
    const editor = makeEditor(true);
    pasteHtml(editor, GOOGLE_DOCS_HTML);
    expect(shape(editor)).toEqual([
      'heading:A heading',
      'paragraph:Bold intro',
      'image',
      'paragraph:Text before',
      'image',
      'paragraph:text after',
    ]);
    editor.getEditorState().read(() => {
      const bold = $getRoot().getChildAtIndex<any>(1)!.getFirstChild();
      expect(bold.hasFormat('bold')).toBe(true);
      // The caret never ends up inside an image.
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if ($isRangeSelection(selection)) {
        expect($isImageNode(selection.anchor.getNode())).toBe(false);
      }
    });
  });

  it('moves the caret out of an image that ends the paste', () => {
    const editor = makeEditor(true);
    pasteHtml(editor, '<p><img src="https://example.com/a.png"></p>');
    expect(shape(editor)).toEqual(['image', 'paragraph:']);
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection) && $isImageNode(selection.anchor.getNode())).toBe(false);
    });
  });
});

describe('placeholder lifecycle', () => {
  it('serializes the pending flag (so orphans are identifiable) and exports no HTML for it', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const placeholder = $createPendingImageNode({ width: 10, height: 20 });
        $getRoot().clear().append(placeholder);
        const json = placeholder.exportJSON();
        expect(json.pending).toBe(true);
        expect(typeof json.pendingSince).toBe('number');
        expect(json.src).toBe('');

        const restored = ImageNode.importJSON(json as SerializedImageNode);
        expect(restored.isPending()).toBe(true);
        expect(restored.getPendingSince()).toBe(json.pendingSince);
        expect(placeholder.exportDOM(editor).element).toBeNull();
      },
      { discrete: true },
    );
  });

  it('completeImport swaps in the gallery image and clears the flag', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const placeholder = $createPendingImageNode({ width: 10, altText: 'diagram' });
        $getRoot().clear().append(placeholder);
        placeholder.completeImport({ src: '/api/gallery/9_x.png', fullSizeSrc: '/api/gallery/9_x.png', imageId: 'm9' });
        const json = placeholder.exportJSON();
        expect(json.pending).toBeUndefined();
        expect(json.pendingSince).toBeUndefined();
        expect(json).toMatchObject({ src: '/api/gallery/9_x.png', imageId: 'm9', width: 10, altText: 'diagram' });
      },
      { discrete: true },
    );
  });

  it('isStalePending only after the stale window', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const placeholder = $createPendingImageNode();
        const since = placeholder.getPendingSince()!;
        expect(placeholder.isStalePending(since + 1000)).toBe(false);
        expect(placeholder.isStalePending(since + PENDING_IMAGE_STALE_MS + 1)).toBe(true);
        expect($createImageNode({ src: '/api/gallery/x.png' }).isStalePending(Date.now() + 10 * PENDING_IMAGE_STALE_MS)).toBe(false);
      },
      { discrete: true },
    );
  });

  it('$settlePendingImages: saved HTML keeps usable addresses, drops the rest and orphaned placeholders', () => {
    const editor = makeEditor();
    importHtml(
      editor,
      '<p>a</p><p><img src="https://example.com/a.png"></p><p><img src="file:///C:/x.png"></p><p><img src="/api/gallery/g.png"></p>',
    );
    editor.update(
      () => {
        $getRoot().append($createParagraphNode().append($createTextNode('b')), $createPendingImageNode());
        $settlePendingImages();
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      expect($getPendingImageNodes()).toHaveLength(0);
      const srcs: string[] = [];
      $getRoot().getChildren().forEach((block: any) => {
        const nodes = $isImageNode(block) ? [block] : block.getChildren();
        nodes.filter($isImageNode).forEach((img: ImageNode) => srcs.push(img.getSrc()));
      });
      expect(srcs).toEqual(['https://example.com/a.png', '/api/gallery/g.png']);
    });
  });

  it('the collaborative seed drops placeholders left in saved JSON and keeps images from saved HTML', () => {
    const editor = makeEditor();
    const saved = JSON.stringify({
      root: {
        type: 'root', version: 1, format: '', indent: 0, direction: null,
        children: [
          { type: 'paragraph', version: 1, format: '', indent: 0, direction: null, textFormat: 0, textStyle: '', children: [
            { type: 'text', version: 1, text: 'kept', format: 0, style: '', mode: 'normal', detail: 0 },
          ] },
          { type: 'image', version: 1, format: '', indent: 0, direction: null, children: [], src: '', altText: '', imageId: 'pending-x', pending: true, pendingSince: 1 },
          { type: 'image', version: 1, format: '', indent: 0, direction: null, children: [], src: '/api/gallery/ok.png', altText: '' },
        ],
      },
    });
    editor.update(() => $populateRootFromSavedContent(editor, saved), { discrete: true });
    expect(shape(editor)).toEqual(['paragraph:kept', 'image']);

    editor.update(() => {
      $getRoot().clear();
      $populateRootFromSavedContent(editor, '<p>x</p><p><img src="https://example.com/b.png"></p>');
    }, { discrete: true });
    editor.getEditorState().read(() => {
      expect($getPendingImageNodes()).toHaveLength(0);
      const image = $getRoot().getChildAtIndex<any>(1)!.getFirstChild() as ImageNode;
      expect(image.getSrc()).toBe('https://example.com/b.png');
    });
  });
});

describe('dataUrlToFile', () => {
  it('decodes a base64 PNG', () => {
    const file = dataUrlToFile(PNG_1PX);
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(70);
    expect(file.name).toMatch(/\.png$/);
  });

  it('rejects malformed input', () => {
    expect(() => dataUrlToFile('data:nope')).toThrow();
  });
});

describe('placeholders over Yjs', () => {
  const provider = {
    awareness: {
      getLocalState: () => null, getStates: () => new Map(), off: () => {}, on: () => {},
      setLocalState: () => {}, setLocalStateField: () => {},
    },
    connect: () => {}, disconnect: () => {}, off: () => {}, on: () => {},
  } as unknown as Provider;

  function client(name: string): { editor: LexicalEditor; doc: Y.Doc } {
    const editor = makeEditor();
    const doc = new Y.Doc({ gc: false });
    const binding = createBinding(editor, provider, 'room', doc, new Map([['room', doc]]));
    binding.root.getSharedType().observeDeep((events, tr) => {
      if (tr.origin !== binding) syncYjsChangesToLexical(binding, provider, events as any, false, () => {});
    });
    editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
    });
    return { editor, doc };
  }

  const pendingOn = (editor: LexicalEditor) =>
    editor.getEditorState().read(() =>
      $getRoot().getChildren().filter($isImageNode).map((n) => ({ id: n.getImageId(), src: n.getSrc(), pendingSince: n.getPendingSince() })),
    );

  it('syncs the placeholder (with its flag) and the swap as ordinary updates', () => {
    const a = client('a');
    const b = client('b');
    a.doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(b.doc, u, 'remote'); });
    b.doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(a.doc, u, 'remote'); });

    let id = '';
    let since = 0;
    a.editor.update(() => {
      const placeholder = $createPendingImageNode({ width: 40 });
      id = placeholder.getImageId()!;
      since = placeholder.getPendingSince()!;
      $getRoot().clear().append($createParagraphNode(), placeholder, $createParagraphNode());
    }, { discrete: true });
    b.editor.update(() => {}, { discrete: true });
    expect(pendingOn(b.editor)).toEqual([{ id, src: '', pendingSince: since }]);

    a.editor.update(() => {
      $getPendingImageNodes()[0].completeImport({ src: '/api/gallery/1.png', fullSizeSrc: '/api/gallery/1.png', imageId: 'm1' });
    }, { discrete: true });
    b.editor.update(() => {}, { discrete: true });
    expect(pendingOn(b.editor)).toEqual([{ id: 'm1', src: '/api/gallery/1.png', pendingSince: null }]);
  });
});
