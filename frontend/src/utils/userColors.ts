/**
 * Shared user color palette and assignment utilities.
 * Used for tracked changes, cursor colors, and user presence indicators.
 */

export const USER_COLORS: string[] = [
  '#1a73e8', // Blue
  '#ea4335', // Red
  '#34a853', // Green
  '#fbbc04', // Yellow
  '#ff6d01', // Orange
  '#9c27b0', // Purple
  '#00bcd4', // Cyan
  '#795548', // Brown
  '#607d8b', // Blue Grey
  '#e91e63', // Pink
];

/** Khaki color used for the current user's own changes. Index 10 (beyond the 0–9 palette). */
export const CURRENT_USER_COLOR = '#bdb76b'; // DarkKhaki
export const CURRENT_USER_COLOR_INDEX = 10;

/** Hash a userId to a consistent palette index (0–9). */
export function getUserColorIndex(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(hash) % USER_COLORS.length;
}

/** Return the palette color for the given userId. */
export function getUserColor(userId: string): string {
  return USER_COLORS[getUserColorIndex(userId)];
}

/** Return the color index for a change author, using the current-user khaki when applicable. */
export function getChangeColorIndex(authorId: string, currentUserId?: string): number {
  if (currentUserId && authorId === currentUserId) return CURRENT_USER_COLOR_INDEX;
  return getUserColorIndex(authorId);
}

/** Return the color for a change author, using the current-user khaki when applicable. */
export function getChangeColor(authorId: string, currentUserId?: string): string {
  if (currentUserId && authorId === currentUserId) return CURRENT_USER_COLOR;
  return getUserColor(authorId);
}
