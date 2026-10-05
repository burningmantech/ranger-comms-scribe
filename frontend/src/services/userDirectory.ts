import { useEffect, useMemo, useState } from 'react';
import { API_URL } from '../config';

/**
 * Resolves the user ids (UUIDs) and emails stored on submissions, tracked changes
 * and comments to display names, from GET /api/user/directory. Fetched once per
 * page load and shared; refetched (at most every 30 s) when an unknown id shows up,
 * e.g. a user who registered after the directory was loaded.
 */

export interface DirectoryUser {
  id: string;
  name?: string;
  email: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISS_REFETCH_MS = 30_000;

let directory: Map<string, DirectoryUser> | null = null;
let inflight: Promise<void> | null = null;
let lastLoadAt = 0;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function loadUserDirectory(force = false): Promise<void> {
  if (inflight) return inflight;
  if (directory && !force) return Promise.resolve();
  const sessionId = localStorage.getItem('sessionId');
  if (!sessionId) return Promise.resolve();

  lastLoadAt = Date.now();
  inflight = fetch(`${API_URL}/user/directory`, { headers: { Authorization: `Bearer ${sessionId}` } })
    .then(async (response) => {
      if (!response.ok) return;
      const data = (await response.json()) as { users?: DirectoryUser[] };
      const next = new Map<string, DirectoryUser>();
      for (const user of data.users || []) {
        if (user.id) next.set(user.id, user);
        if (user.email) next.set(user.email.toLowerCase(), user);
      }
      directory = next;
      notify();
    })
    .catch((error) => {
      console.error('Failed to load user directory:', error);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function lookup(value: string): DirectoryUser | undefined {
  return directory?.get(value) ?? directory?.get(value.toLowerCase());
}

/** Display name for a stored user reference (id or email). */
export function resolveUserName(value?: string | null): string {
  if (!value) return '';
  const user = lookup(value);
  if (user) return user.name || user.email;
  if (UUID_RE.test(value)) {
    // Unknown id: maybe a newer user; refresh in the background.
    if (Date.now() - lastLoadAt > MISS_REFETCH_MS) void loadUserDirectory(true);
    return directory ? 'Unknown user' : '…';
  }
  return value; // already an email or a name
}

/** Email for a stored user reference, for tooltips. */
export function resolveUserEmail(value?: string | null): string | undefined {
  if (!value) return undefined;
  return lookup(value)?.email ?? (value.includes('@') ? value : undefined);
}

/**
 * Re-renders the caller when the directory loads; returns the resolver. The
 * function's identity changes on each load, so it can be a useMemo dependency.
 */
export function useUserDirectory(): typeof resolveUserName {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    listeners.add(listener);
    void loadUserDirectory();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return useMemo(() => (value?: string | null) => resolveUserName(value), [version]);
}

export function useUserName(value?: string | null): string {
  useUserDirectory();
  return resolveUserName(value);
}

/** Test hook. */
export function __resetUserDirectory(users?: DirectoryUser[]): void {
  directory = null;
  inflight = null;
  lastLoadAt = 0;
  if (users) {
    directory = new Map();
    for (const user of users) {
      directory.set(user.id, user);
      directory.set(user.email.toLowerCase(), user);
    }
  }
}
