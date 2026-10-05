/**
 * Yjs transport for collaborative editing (contracts §9): the stock y-websocket client
 * against /api/ws/yjs/submissions/:submissionId?sessionId=...
 */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { Provider } from '@lexical/yjs';
import { API_URL } from '../config';

/** API_URL's origin with ws:// or wss:// (e.g. https://host/api -> wss://host). */
export function yjsWebSocketBase(apiUrl: string = API_URL): string {
  const url = new URL(apiUrl);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}`;
}

/** The y-websocket server URL; the provider appends `/<submissionId>?sessionId=...`. */
export function yjsServerUrl(apiUrl: string = API_URL): string {
  return `${yjsWebSocketBase(apiUrl)}/api/ws/yjs/submissions`;
}

/**
 * Provider factory for Lexical's CollaborationPlugin.
 *
 * - Creates a fresh Y.Doc (without garbage collection) on every call and registers it in `yjsDocMap` synchronously,
 *   as CollaborationPlugin requires. A fresh doc per editor mount means a client never
 *   brings an old Yjs history into a room that was seeded again from saved content.
 * - `connect: false`: CollaborationPlugin connects only after it has registered its
 *   'sync' listener. A provider that connected on construction could finish syncing
 *   first, and the seeder would then never bootstrap the saved content.
 * - `disableBc`: no BroadcastChannel shortcut between tabs; every tab goes through the
 *   server, which owns the single-seeder rule.
 */
export function createSubmissionYjsProvider(
  submissionId: string,
  yjsDocMap: Map<string, Y.Doc>,
  sessionId: string,
  options: {
    apiUrl?: string;
    /** Node (integration tests) has no browser WebSocket; pass the `ws` class. */
    WebSocketPolyfill?: unknown;
  } = {},
): { provider: Provider; websocketProvider: WebsocketProvider; doc: Y.Doc } {
  // gc: false keeps deleted content, so a tracked change's before-state can restore text
  // the user deleted (localEditTracker). The doc lives only as long as the editor session.
  const doc = new Y.Doc({ gc: false });
  yjsDocMap.set(submissionId, doc);
  const websocketProvider = new WebsocketProvider(yjsServerUrl(options.apiUrl ?? API_URL), submissionId, doc, {
    params: { sessionId },
    disableBc: true,
    connect: false,
    ...(options.WebSocketPolyfill ? { WebSocketPolyfill: options.WebSocketPolyfill as typeof WebSocket } : {}),
  });
  // WebsocketProvider implements everything Lexical's Provider interface uses (awareness,
  // connect/disconnect, 'sync'/'status' events); only the event typings differ.
  return { provider: websocketProvider as unknown as Provider, websocketProvider, doc };
}
