/**
 * Real-time merged editing (COLLAB_MODE=yjs, PRD §14, contracts §9).
 *
 * - YjsCollaboration mounts Lexical's CollaborationPlugin against the server's Yjs room
 *   for one submission. The server lets exactly one client seed an empty room; that
 *   client's CollaborationPlugin bootstraps the saved content (`getSeedContent`).
 * - CollabUpdateListener classifies every committed editor update so tracked changes stay
 *   attributed to the user who typed them.
 *
 * Nothing here runs in legacy mode.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Doc, Transaction, UndoManager, XmlText } from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import { CollaborationPlugin } from '@lexical/react/LexicalCollaborationPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $generateNodesFromDOM } from '@lexical/html';
import {
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_HIGH,
  REDO_COMMAND,
  UNDO_COMMAND,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isDecoratorNode,
  $isElementNode,
  $parseSerializedNode,
  EditorState,
  Klass,
  LexicalEditor,
  LexicalNode,
  ParagraphNode,
} from 'lexical';
import { createSubmissionYjsProvider } from '../../../services/yjsProvider';
import { registerCaretPreservation } from './caretPreservation';
import { createLocalEditTracker, LocalEditTracker } from './localEditTracker';
import { isLexicalJson } from '../../../utils/lexicalUtils';

/**
 * Tag for the editor reset before a new Yjs session binds (see YjsCollaboration). It's
 * Lexical's own "don't sync this to Yjs" tag, and the update listener ignores it too.
 */
export const SKIP_COLLAB_TAG = 'skip-collab';

/**
 * After the Yjs socket has been down this long, the next connection starts from a fresh
 * Y.Doc instead of reusing the old one. The server destroys a room 30 s after its last
 * client leaves; if the room was then seeded again from saved content, an old doc would
 * merge a second copy of the document into it (separate Yjs histories). Shorter outages
 * reconnect with the same doc, so edits typed while offline are merged, not lost.
 */
export const FRESH_DOC_AFTER_OFFLINE_MS = 20_000;

/**
 * Fill the (empty) root from saved content: Lexical JSON, HTML, or plain text. Runs
 * inside CollaborationPlugin's bootstrap update (tag 'history-merge') on the one client
 * the server picked as the seeder. Never throws on odd content: a bootstrap that threw
 * would leave the room unseeded and every other client waiting.
 */
export function $populateRootFromSavedContent(editor: LexicalEditor, content: string): void {
  const root = $getRoot();
  const text = typeof content === 'string' ? content : '';

  try {
    if (text && isLexicalJson(text)) {
      const parsed = JSON.parse(text);
      for (const child of parsed.root.children) {
        root.append($parseSerializedNode(child));
      }
    } else if (text.trim().startsWith('<') && typeof DOMParser !== 'undefined') {
      const dom = new DOMParser().parseFromString(text, 'text/html');
      let paragraph: ParagraphNode | null = null;
      for (const node of $generateNodesFromDOM(editor, dom)) {
        const isBlock = ($isElementNode(node) || $isDecoratorNode(node)) && !node.isInline();
        if (isBlock) {
          paragraph = null;
          root.append(node);
        } else {
          if (!paragraph) {
            paragraph = $createParagraphNode();
            root.append(paragraph);
          }
          paragraph.append(node as LexicalNode);
        }
      }
    } else if (text.trim()) {
      for (const line of text.split('\n')) {
        const paragraph = $createParagraphNode();
        if (line.trim()) paragraph.append($createTextNode(line));
        root.append(paragraph);
      }
    }
  } catch (error) {
    console.error('[YJS] Could not parse saved content for the initial seed; seeding it as text', error);
    root.clear();
    for (const line of text.split('\n')) {
      const paragraph = $createParagraphNode();
      if (line.trim()) paragraph.append($createTextNode(line));
      root.append(paragraph);
    }
  }

  if (root.getChildrenSize() === 0) {
    root.append($createParagraphNode());
  }
}

interface YjsCollaborationProps {
  /** Submission ID: the Yjs room. */
  submissionId: string;
  /** Read when (and only if) this client seeds the room. May return Lexical JSON, HTML, plain text or ''. */
  getSeedContent: () => string;
  username: string;
  cursorColor: string;
  cursorsContainerRef: React.MutableRefObject<HTMLElement | null>;
  /** Editing is enabled only while the room is synced (and not readOnly). */
  readOnly?: boolean;
  /** The editor's node classes (to rebuild documents headlessly for tracked changes). */
  nodes: ReadonlyArray<Klass<LexicalNode>>;
  /** The current Yjs session's API, or null between sessions. */
  onSessionReady?: (session: CollabSession | null) => void;
}

/** What the tracked-changes layer needs from a live Yjs session. */
export interface CollabSession {
  /** The local user's own edits since a point in time (keeps a tracked change open across remote edits). */
  tracker: LocalEditTracker;
}

/**
 * One Yjs session per mount of the inner component. The editor stays read-only until
 * the session has synced, so nothing typed into an empty, unsynced editor can race the
 * bootstrap. A long outage starts a new session with a fresh doc (FRESH_DOC_AFTER_OFFLINE_MS).
 */
export function YjsCollaboration(props: YjsCollaborationProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [session, setSession] = useState(0);
  const readOnlyRef = useRef(props.readOnly);
  readOnlyRef.current = props.readOnly;

  // Read-only until the first sync (YjsSession enables editing once synced).
  useEffect(() => {
    editor.setEditable(false);
    return () => {
      editor.setEditable(!readOnlyRef.current);
    };
  }, [editor]);

  const startFreshSession = useCallback(() => {
    console.info(`[YJS] Socket down for ${FRESH_DOC_AFTER_OFFLINE_MS / 1000} s; reconnecting with a fresh document`);
    editor.setEditable(false);
    setSession((n) => n + 1);
  }, [editor]);

  return (
    <YjsSession
      key={`${props.submissionId}:${session}`}
      {...props}
      isFreshSession={session > 0}
      onLongOutage={startFreshSession}
    />
  );
}

function YjsSession({
  submissionId,
  getSeedContent,
  username,
  cursorColor,
  cursorsContainerRef,
  readOnly,
  nodes,
  onSessionReady,
  isFreshSession,
  onLongOutage,
}: YjsCollaborationProps & { isFreshSession: boolean; onLongOutage: () => void }): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const providersRef = useRef<Array<{ websocketProvider: WebsocketProvider; doc: Doc }>>([]);
  const [websocketProvider, setWebsocketProvider] = useState<WebsocketProvider | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const destroyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const yjsDocMapRef = useRef<Map<string, Doc> | null>(null);

  const getSeedContentRef = useRef(getSeedContent);
  getSeedContentRef.current = getSeedContent;
  const onLongOutageRef = useRef(onLongOutage);
  onLongOutageRef.current = onLongOutage;
  const onSessionReadyRef = useRef(onSessionReady);
  onSessionReadyRef.current = onSessionReady;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Stable identities: CollaborationPlugin re-creates its connection whenever
  // providerFactory or initialEditorState changes.
  const providerFactory = useCallback(
    (id: string, yjsDocMap: Map<string, Doc>) => {
      if (isFreshSession) {
        // The previous session's binding is gone; empty the editor so the new binding
        // starts from an empty tree (the next sync refills it). Not synced to Yjs.
        editor.update(() => {
          $getRoot().clear();
        }, { tag: SKIP_COLLAB_TAG });
      }
      yjsDocMapRef.current = yjsDocMap;
      const sessionId = localStorage.getItem('sessionId') || '';
      const created = createSubmissionYjsProvider(id, yjsDocMap, sessionId);
      providersRef.current.push({ websocketProvider: created.websocketProvider, doc: created.doc });
      setWebsocketProvider(created.websocketProvider);
      setDoc(created.doc);
      return created.provider;
    },
    // Both are fixed for this session (a new session is a new YjsSession instance).
    [editor, isFreshSession],
  );

  const initialEditorState = useCallback((ed: LexicalEditor) => {
    let content = '';
    try {
      content = getSeedContentRef.current() || '';
    } catch (error) {
      console.error('[YJS] getSeedContent failed; seeding an empty document', error);
    }
    $populateRootFromSavedContent(ed, content);
  }, []);

  // Editable only while synced; a long outage starts a fresh session.
  useEffect(() => {
    if (!websocketProvider) return;
    let outageTimer: ReturnType<typeof setTimeout> | null = null;
    let everSynced = false;

    const onSync = (isSynced: boolean) => {
      if (isSynced) {
        everSynced = true;
        if (outageTimer) {
          clearTimeout(outageTimer);
          outageTimer = null;
        }
      }
      editor.setEditable(isSynced && !readOnly);
    };
    const onStatus = ({ status }: { status: string }) => {
      if (status === 'connected') {
        if (outageTimer) {
          clearTimeout(outageTimer);
          outageTimer = null;
        }
        return;
      }
      if (status === 'disconnected') {
        editor.setEditable(false);
        if (everSynced && !outageTimer) {
          outageTimer = setTimeout(() => {
            outageTimer = null;
            // The next session's CollaborationPlugin reads yjsDocMap during its first render
            // (before its factory runs) and would bind to this session's old doc if the
            // entry were still there; this session's cleanup only removes it later.
            yjsDocMapRef.current?.delete(submissionId);
            onLongOutageRef.current();
          }, FRESH_DOC_AFTER_OFFLINE_MS);
        }
      }
    };

    websocketProvider.on('sync', onSync);
    websocketProvider.on('status', onStatus);
    if (websocketProvider.synced) onSync(true);
    return () => {
      websocketProvider.off('sync', onSync);
      websocketProvider.off('status', onStatus);
      if (outageTimer) clearTimeout(outageTimer);
    };
  }, [editor, websocketProvider, readOnly, submissionId]);

  // Undo. CollaborationPlugin's own UndoManager tracks every update the binding writes,
  // including the seed ('history-merge'), approve/reject ('tracked-changes-resolve') and
  // marker renames ('tracked-changes-decoration'): Ctrl+Z would undo a reject (the server
  // keeps it rejected) or even the whole seed. This UndoManager captures only the local
  // user's own edits and takes Ctrl+Z / Ctrl+Y first (HIGH priority); Lexical's is never
  // invoked. Its undo is applied as a 'historic' update, which the editor treats as local.
  //
  // This listener is registered before CollaborationPlugin's (which needs the binding,
  // created on a later render), so for every update the flag is set before the binding
  // writes the update's Yjs transaction.
  const captureNextRef = useRef(false);
  useEffect(() => {
    return editor.registerUpdateListener(({ tags }) => {
      captureNextRef.current = classifyCollabUpdate(tags) === 'local';
    });
  }, [editor]);
  useEffect(() => {
    if (!doc) return;
    const undoManager = new UndoManager(doc.get('root', XmlText), {
      // The binding is a plain object; the provider's remote updates have origin WebsocketProvider.
      trackedOrigins: new Set([Object]),
      captureTransaction: (tr: Transaction) =>
        captureNextRef.current && !!tr.origin && typeof tr.origin === 'object' && 'collabNodeMap' in tr.origin,
    });
    const updateCanUndo = () => {
      editor.dispatchCommand(CAN_UNDO_COMMAND, undoManager.undoStack.length > 0);
      editor.dispatchCommand(CAN_REDO_COMMAND, undoManager.redoStack.length > 0);
    };
    undoManager.on('stack-item-added', updateCanUndo);
    undoManager.on('stack-item-popped', updateCanUndo);
    undoManager.on('stack-cleared', updateCanUndo);
    const removeUndo = editor.registerCommand(UNDO_COMMAND, () => {
      undoManager.undo();
      return true;
    }, COMMAND_PRIORITY_HIGH);
    const removeRedo = editor.registerCommand(REDO_COMMAND, () => {
      undoManager.redo();
      return true;
    }, COMMAND_PRIORITY_HIGH);
    return () => {
      removeUndo();
      removeRedo();
      undoManager.destroy();
    };
  }, [editor, doc]);

  // Caret preservation across remote edits, and the local-edit tracker for tracked changes.
  useEffect(() => {
    if (!doc || !websocketProvider) return;
    const isLocalEdit = (tr: Transaction) =>
      tr.origin instanceof UndoManager ||
      (captureNextRef.current && !!tr.origin && typeof tr.origin === 'object' && 'collabNodeMap' in tr.origin);
    const tracker = createLocalEditTracker(doc, nodesRef.current, isLocalEdit);
    const removeCaret = registerCaretPreservation({
      editor,
      doc,
      isRemoteOrigin: (origin) => origin === websocketProvider,
      isOwnEdit: isLocalEdit,
      getLocalAwarenessState: () => websocketProvider.awareness.getLocalState() as any,
      isFocused: () => {
        const root = editor.getRootElement();
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        return !!root && !!active && (root === active || root.contains(active));
      },
    });
    onSessionReadyRef.current?.({ tracker });
    return () => {
      onSessionReadyRef.current?.(null);
      removeCaret();
      tracker.destroy();
    };
  }, [editor, doc, websocketProvider]);

  // CollaborationPlugin only disconnects its provider on unmount; also destroy it (timers,
  // awareness) and its doc. Deferred so React StrictMode's simulated unmount/remount, which
  // keeps the same provider, cancels it.
  useEffect(() => {
    if (destroyTimerRef.current) {
      clearTimeout(destroyTimerRef.current);
      destroyTimerRef.current = null;
    }
    return () => {
      destroyTimerRef.current = setTimeout(() => {
        for (const { websocketProvider: p, doc } of providersRef.current) {
          try {
            p.destroy();
            doc.destroy();
          } catch (error) {
            console.error('[YJS] Error destroying provider', error);
          }
        }
        providersRef.current = [];
      }, 0);
    };
  }, []);

  return (
    <CollaborationPlugin
      id={submissionId}
      providerFactory={providerFactory}
      shouldBootstrap={true}
      initialEditorState={initialEditorState}
      username={username}
      cursorColor={cursorColor}
      cursorsContainerRef={cursorsContainerRef}
    />
  );
}

export type CollabUpdateKind = 'local' | 'remote' | 'baseline' | 'ignore';

/**
 * How an update must be treated for change tracking:
 * - 'remote': another user's edit merged through Yjs (tag 'collaboration').
 * - 'baseline': not typed by anyone just now, so never a new transaction: the bootstrap
 *   seed ('history-merge') and programmatic tracked-change bookkeeping
 *   ('tracked-changes-resolve', 'tracked-changes-decoration', 'remote-sync').
 * - 'ignore': the local reset before a fresh Yjs session ('skip-collab').
 * - 'local': everything else, including 'historic'. With the HistoryPlugin and the
 *   decoration writes gone in collaborative mode, 'historic' only comes from Yjs's
 *   UndoManager, which undoes the local user's own edits.
 */
export function classifyCollabUpdate(tags: Set<string>): CollabUpdateKind {
  if (tags.has(SKIP_COLLAB_TAG)) return 'ignore';
  if (tags.has('collaboration')) return 'remote';
  if (
    tags.has('history-merge') ||
    tags.has('tracked-changes-resolve') ||
    tags.has('tracked-changes-decoration') ||
    tags.has('remote-sync')
  ) {
    return 'baseline';
  }
  return 'local';
}

interface CollabUpdateListenerProps {
  onUpdate: (json: string, kind: Exclude<CollabUpdateKind, 'ignore'>, editorState: EditorState) => void;
}

/**
 * Sees every committed update (unlike OnChangePlugin, which skips 'history-merge' and any
 * update whose previous state was empty, i.e. the first sync into a fresh editor) and
 * reports content changes with their kind. Selection-only updates are dropped.
 */
export function CollabUpdateListener({ onUpdate }: CollabUpdateListenerProps): null {
  const [editor] = useLexicalComposerContext();
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const lastJsonRef = useRef<string | null>(null);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, tags }) => {
      const kind = classifyCollabUpdate(tags);
      const json = JSON.stringify(editorState);
      if (kind === 'ignore') {
        lastJsonRef.current = json;
        return;
      }
      if (json === lastJsonRef.current) return;
      lastJsonRef.current = json;
      onUpdateRef.current(json, kind, editorState);
    });
  }, [editor]);

  return null;
}
