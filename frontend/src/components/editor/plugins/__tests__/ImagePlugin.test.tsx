import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { EditorRefPlugin } from '@lexical/react/LexicalEditorRefPlugin';
import { DRAG_DROP_PASTE, HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListItemNode, ListNode } from '@lexical/list';
import { LinkNode } from '@lexical/link';
import { $generateNodesFromDOM } from '@lexical/html';
import { $insertGeneratedNodes } from '@lexical/clipboard';
import { $createParagraphNode, $getRoot, $getSelection, LexicalEditor, PASTE_COMMAND } from 'lexical';
import { ImagePlugin } from '../ImagePlugin';
import { $getPendingImageNodes, $isImageNode, ImageNode } from '../../nodes/ImageNode';
import { PENDING_IMAGE_STALE_MS, resolveImageSource, uploadImageToGallery } from '../../utils/imageImport';

jest.mock('../../utils/imageImport', () => ({
  ...jest.requireActual('../../utils/imageImport'),
  resolveImageSource: jest.fn(),
  uploadImageToGallery: jest.fn(),
}));

const mockResolve = resolveImageSource as jest.MockedFunction<typeof resolveImageSource>;
const mockUpload = uploadImageToGallery as jest.MockedFunction<typeof uploadImageToGallery>;

function setup(): { editor: LexicalEditor } {
  const ref: { current: LexicalEditor | null } = { current: null };
  render(
    <LexicalComposer
      initialConfig={{
        namespace: 'image-plugin-test',
        nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, ImageNode],
        onError: (e: Error) => {
          throw e;
        },
      }}
    >
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <ImagePlugin currentUser={{ name: 'Ada', email: 'ada@example.com' }} />
      <EditorRefPlugin editorRef={ref} />
    </LexicalComposer>,
  );
  return { editor: ref.current! };
}

/** What RichTextPlugin's paste does with clipboard HTML. */
async function pasteHtml(editor: LexicalEditor, html: string) {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  await act(async () => {
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().clear().append(paragraph);
        paragraph.select();
        $insertGeneratedNodes(editor, $generateNodesFromDOM(editor, dom), $getSelection()!);
      },
      { tag: 'paste' },
    );
  });
}

/** A promise the test resolves, to hold an upload in flight. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => undefined as void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});

const images = (editor: LexicalEditor) =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .filter($isImageNode)
      .map((n) => ({ src: n.getSrc(), pending: n.isPending(), width: n.getWidth(), imageId: n.getImageId() })),
  );

const uploaded = (n: number) => ({
  id: `m${n}`,
  fileName: `f${n}.png`,
  url: `/api/gallery/${n}.png`,
  thumbnailUrl: `/api/gallery/${n}.png/thumbnail`,
  mediumUrl: `/api/gallery/${n}.png/medium`,
});

beforeEach(() => {
  mockResolve.mockReset();
  mockUpload.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

describe('ImagePlugin: pasted HTML images', () => {
  it('uploads each placeholder from its original source and swaps the gallery image in', async () => {
    const { editor } = setup();
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    let n = 0;
    const inFlight = gate();
    mockResolve.mockImplementation(async () => {
      await inFlight.wait;
      return file;
    });
    mockUpload.mockImplementation(async () => uploaded(++n));

    await pasteHtml(
      editor,
      '<p>Intro</p><p><img src="https://lh7-rt.googleusercontent.com/a" width="300" height="200"></p><p><img src="https://example.com/b.jpg"></p><p><img src="/api/gallery/kept.png"></p>',
    );
    // Placeholders appear at once, in place.
    expect(images(editor).map((i) => i.pending)).toEqual([true, true, false]);

    inFlight.open();
    await settle();

    expect(mockResolve.mock.calls.map(([source]) => source)).toEqual([
      { kind: 'url', src: 'https://lh7-rt.googleusercontent.com/a' },
      { kind: 'url', src: 'https://example.com/b.jpg' },
    ]);
    expect(mockUpload).toHaveBeenCalledWith(file, 'Ada', expect.anything());
    const result = images(editor);
    expect(result.map((i) => i.pending)).toEqual([false, false, false]);
    expect(result.map((i) => i.src).sort()).toEqual(['/api/gallery/1.png', '/api/gallery/2.png', '/api/gallery/kept.png']);
    expect(result[0].width).toBe(300); // keeps the pasted size
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('removes images that cannot be imported and shows one notice with the count', async () => {
    const { editor } = setup();
    mockResolve.mockImplementation(async (source) => {
      if (source.kind === 'url' && source.src.startsWith('file:')) throw new Error("can't import file:");
      if (source.kind === 'url' && source.src.includes('broken')) throw new Error('proxy 502');
      return new File(['x'], 'ok.png', { type: 'image/png' });
    });
    mockUpload.mockResolvedValue(uploaded(7));

    await pasteHtml(
      editor,
      '<p><img src="file:///C:/x.png"></p><p><img src="https://example.com/broken.png"></p><p><img src="https://example.com/ok.png"></p>',
    );
    await settle();

    expect(images(editor)).toEqual([{ src: '/api/gallery/7.png', pending: false, width: undefined, imageId: 'm7' }]);
    expect(screen.getByRole('status').textContent).toContain("2 images couldn't be imported");
    editor.getEditorState().read(() => expect($getPendingImageNodes()).toHaveLength(0));
  });
});

describe('ImagePlugin: screenshots and dropped files', () => {
  it('DRAG_DROP_PASTE inserts a placeholder per image file and uploads it', async () => {
    const { editor } = setup();
    const shot = new File(['png'], 'Screenshot.png', { type: 'image/png' });
    const inFlight = gate();
    mockResolve.mockImplementation(async (source) => {
      await inFlight.wait;
      if (source.kind !== 'file') throw new Error('no');
      return source.file;
    });
    mockUpload.mockResolvedValue(uploaded(3));

    await act(async () => {
      editor.update(() => {
        $getRoot().clear().append($createParagraphNode());
        $getRoot().getFirstChildOrThrow<any>().select();
      });
      editor.dispatchCommand(DRAG_DROP_PASTE, [shot, new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' })]);
    });
    expect(images(editor).map((i) => i.pending)).toEqual([true]);

    inFlight.open();
    await settle();
    expect(mockResolve).toHaveBeenCalledWith({ kind: 'file', file: shot }, expect.anything());
    expect(images(editor)).toEqual([{ src: '/api/gallery/3.png', pending: false, width: undefined, imageId: 'm3' }]);
  });

  it('"Copy image" clipboard (file + <img> HTML) uses the file, not the URL', async () => {
    const { editor } = setup();
    const file = new File(['png'], 'image.png', { type: 'image/png' });
    mockResolve.mockImplementation(async (source) => (source.kind === 'file' ? source.file : Promise.reject(new Error('url'))));
    mockUpload.mockResolvedValue(uploaded(4));
    const preventDefault = jest.fn();

    await act(async () => {
      editor.update(() => {
        $getRoot().clear().append($createParagraphNode());
        $getRoot().getFirstChildOrThrow<any>().select();
      });
      editor.dispatchCommand(PASTE_COMMAND, {
        clipboardData: {
          types: ['text/html', 'Files'],
          files: [file],
          getData: (type: string) => (type === 'text/html' ? '<meta charset="utf-8"><img src="https://intranet.example.com/a.png">' : ''),
        },
        preventDefault,
      } as any);
    });
    await settle();

    expect(preventDefault).toHaveBeenCalled();
    expect(mockResolve).toHaveBeenCalledWith({ kind: 'file', file }, expect.anything());
    expect(images(editor).map((i) => i.src)).toEqual(['/api/gallery/4.png']);
  });
});

describe('ImagePlugin: orphaned placeholders', () => {
  it('leaves a fresh placeholder it does not own (another client may be uploading it)', async () => {
    const { editor } = setup();
    await act(async () => {
      editor.setEditorState(editor.parseEditorState(docWithPlaceholder(Date.now())));
    });
    await settle();
    expect(images(editor).map((i) => i.pending)).toEqual([true]);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('removes a stale placeholder nobody owns (its uploader left)', async () => {
    const { editor } = setup();
    await act(async () => {
      editor.setEditorState(editor.parseEditorState(docWithPlaceholder(Date.now() - PENDING_IMAGE_STALE_MS - 1000)));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(images(editor)).toEqual([]);
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe('ImagePlugin: undo after a finished import', () => {
  it('removes a placeholder that an undo of the swap brings back', async () => {
    const { editor } = setup();
    const inFlight = gate();
    mockResolve.mockImplementation(async () => {
      await inFlight.wait;
      return new File(['x'], 'a.png', { type: 'image/png' });
    });
    mockUpload.mockResolvedValue(uploaded(5));
    await pasteHtml(editor, '<p><img src="https://example.com/a.png"></p>');
    const placeholderId = editor.getEditorState().read(() => $getPendingImageNodes()[0].getImageId()!);
    inFlight.open();
    await settle();
    expect(images(editor).map((i) => i.src)).toEqual(['/api/gallery/5.png']);

    // Yjs undo reverts the swap's attributes on the same node: an 'updated' mutation.
    await act(async () => {
      editor.update(() => {
        const writable = $getRoot().getChildren().find($isImageNode)!.getWritable();
        writable.__src = '';
        writable.__imageId = placeholderId;
        writable.__pendingSince = Date.now();
      });
    });
    expect(images(editor).map((i) => i.pending)).toEqual([true]);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(images(editor)).toEqual([]);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });
});

function docWithPlaceholder(pendingSince: number): string {
  return JSON.stringify({
    root: {
      type: 'root', version: 1, format: '', indent: 0, direction: null,
      children: [
        { type: 'paragraph', version: 1, format: '', indent: 0, direction: null, textFormat: 0, textStyle: '', children: [] },
        { type: 'image', version: 1, format: '', indent: 0, direction: null, children: [], src: '', altText: '', imageId: 'pending-elsewhere', pending: true, pendingSince },
      ],
    },
  });
}
