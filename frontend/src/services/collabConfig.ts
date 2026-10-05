/**
 * Real-time editing mode, served by the backend as GET /api/config (COLLAB_MODE):
 *   - 'yjs':    merged editing through Lexical's CollaborationPlugin and the Yjs socket
 *               (/api/ws/yjs/submissions/:id, contracts §9);
 *   - 'legacy': whole-document sync over the JSON room (the behavior before Phase 5).
 *
 * Fetched once per page load and cached. Anything other than an explicit 'yjs' (an older
 * backend without the route, a network error, no fetch) means 'legacy'.
 */
import { useEffect, useState } from 'react';
import { API_URL } from '../config';

export type CollabMode = 'yjs' | 'legacy';

let collabModePromise: Promise<CollabMode> | null = null;

async function loadCollabMode(): Promise<CollabMode> {
  try {
    if (typeof fetch !== 'function') return 'legacy';
    const response = await fetch(`${API_URL}/config`);
    if (!response || !response.ok) return 'legacy';
    const body = await response.json();
    return body && body.collabMode === 'yjs' ? 'yjs' : 'legacy';
  } catch {
    return 'legacy';
  }
}

/** The collaboration mode for this page load (one request, shared by every caller). */
export function fetchCollabMode(): Promise<CollabMode> {
  if (!collabModePromise) {
    collabModePromise = loadCollabMode();
  }
  return collabModePromise;
}

/** Tests only: forget the cached mode. */
export function resetCollabModeCache(): void {
  collabModePromise = null;
}

/**
 * The collaboration mode, or null while it's loading. Callers should wait for a value
 * before mounting the editor so it never switches modes mid-session.
 */
export function useCollabMode(): CollabMode | null {
  const [mode, setMode] = useState<CollabMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchCollabMode().then((value) => {
      if (!cancelled) setMode(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return mode;
}
