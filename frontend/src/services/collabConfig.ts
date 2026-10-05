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

/** The served mode, or null when the request failed (network error, 5xx). */
async function requestCollabMode(): Promise<CollabMode | null> {
  try {
    const response = await fetch(`${API_URL}/config`);
    if (!response) return null;
    // An older backend without the route answers 404: that's a definite 'legacy'.
    if (response.status === 404) return 'legacy';
    if (!response.ok) return null;
    const body = await response.json();
    return body && body.collabMode === 'yjs' ? 'yjs' : 'legacy';
  } catch {
    return null;
  }
}

async function loadCollabMode(): Promise<{ mode: CollabMode; definite: boolean }> {
  if (typeof fetch !== 'function') return { mode: 'legacy', definite: true };
  // One retry: a client that fell back to legacy while everyone else is in a Yjs room
  // would do whole-document saves next to them.
  for (let attempt = 0; attempt < 2; attempt++) {
    const mode = await requestCollabMode();
    if (mode) return { mode, definite: true };
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { mode: 'legacy', definite: false };
}

/**
 * The collaboration mode for this page load (shared by every caller). A failed lookup
 * falls back to 'legacy' but isn't cached, so the next editor mount asks again.
 */
export function fetchCollabMode(): Promise<CollabMode> {
  if (!collabModePromise) {
    const pending = loadCollabMode().then(({ mode, definite }) => {
      if (!definite && collabModePromise === pending) collabModePromise = null;
      return mode;
    });
    collabModePromise = pending;
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
