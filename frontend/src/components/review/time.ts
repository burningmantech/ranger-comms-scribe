/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffSecs = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (!Number.isFinite(diffSecs)) return '';
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
