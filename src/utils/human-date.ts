// Terse human-readable date labels for user-facing memory surfaces.
// Lowercase brand voice: "jun 6", "yesterday", "3d ago" — never "June 6th" or "2026-06-06".

export function humanDate(isoDate: string | null | undefined, nowIso?: string): string {
  if (!isoDate) return '';
  const now = nowIso ? new Date(nowIso) : new Date();
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return '';
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (diffDays < 1) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}
