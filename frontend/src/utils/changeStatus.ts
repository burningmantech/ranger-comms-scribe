import type { Change } from '../types/content';

/** Who accepted or rejected a change: a stored user reference (id or email) and a display name. */
export interface ChangeResolver {
  id?: string;
  name?: string;
}

export type ResolvedStatus = 'approved' | 'rejected';

/**
 * Sets the status (and who resolved it) on the changes whose id is in `changeIds`.
 * Returns the same array when nothing matches, so React state setters can skip a re-render.
 */
export function applyChangeStatus<T extends Change>(
  changes: T[],
  changeIds: Iterable<string>,
  status: ResolvedStatus,
  resolver?: ChangeResolver,
): T[] {
  const ids = new Set(changeIds);
  if (ids.size === 0 || !changes.some((change) => ids.has(change.id))) return changes;
  return changes.map((change) => {
    if (!ids.has(change.id)) return change;
    return status === 'approved'
      ? {
          ...change,
          status,
          approvedBy: resolver?.id ?? change.approvedBy,
          approvedByName: resolver?.name ?? change.approvedByName,
        }
      : {
          ...change,
          status,
          rejectedBy: resolver?.id ?? change.rejectedBy,
          rejectedByName: resolver?.name ?? change.rejectedByName,
        };
  });
}

/**
 * The change ids a `change_status_updated` message resolves: the explicit change plus any the
 * server cascade-rejected with it. Empty for a malformed message.
 */
export function resolvedChangeIds(data: any): string[] {
  if (!data || typeof data.changeId !== 'string' || !data.changeId) return [];
  const ids = [data.changeId];
  if (data.status === 'rejected' && Array.isArray(data.cascadeRejectedIds)) {
    for (const id of data.cascadeRejectedIds) {
      if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * The sidebar's change list: the server's changes, then the locally saved changes the server
 * data doesn't have yet. When both have a change, the server's copy (and status) wins.
 */
export function mergeLocalChanges<T extends { id: string }>(serverChanges: T[], localChanges: T[], removedIds: Set<string>): T[] {
  const result = serverChanges.filter((change) => !removedIds.has(change.id));
  const serverIds = new Set(serverChanges.map((change) => change.id));
  for (const local of localChanges) {
    if (!serverIds.has(local.id) && !removedIds.has(local.id)) result.push(local);
  }
  return result;
}
