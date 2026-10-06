/**
 * Which transaction each of this client's new deletion markers belongs to (collaborative
 * mode).
 *
 * A deletion marker (DeletedTextNode) starts with the placeholder change id
 * `__pending_deletion__` and gets the real id when the transaction whose edit created it
 * is saved. Each marker this client creates carries a unique `pendingKey`; the keys are
 * noted here when the marker is created, claimed by the transaction that settles next,
 * and handed to the stamp once that transaction is saved. So a save stamps exactly the
 * markers its own edits made: never a stray pending marker left in the document by an
 * earlier session, and never one of the next transaction's.
 */

let unclaimed = new Set<string>();
const claimed = new Map<string, Set<string>>();

let counter = 0;

/** A new, unique pending key for a marker created by this client. */
export function newPendingKey(): string {
  counter += 1;
  const random = typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function'
    ? (crypto as any).randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${random}-${counter}`;
}

/** A marker with this pending key was just created by the local user's edit. */
export function notePendingMarker(pendingKey: string): void {
  unclaimed.add(pendingKey);
}

/**
 * The transaction `txId` settled: it owns every marker created since the previous settle.
 * Returns how many it claimed.
 */
export function claimPendingMarkers(txId: string): number {
  if (unclaimed.size === 0) return 0;
  claimed.set(txId, unclaimed);
  unclaimed = new Set();
  return claimed.get(txId)!.size;
}

/** The pending keys transaction `txId` claimed (once: they are forgotten here). */
export function takeClaimedMarkers(txId: string): string[] {
  const keys = claimed.get(txId);
  claimed.delete(txId);
  return keys ? Array.from(keys) : [];
}

/** Forget everything (tests; a new editing session). */
export function resetPendingMarkers(): void {
  unclaimed = new Set();
  claimed.clear();
}
