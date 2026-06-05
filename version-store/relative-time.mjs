// Pure, dependency-free. Formats `iso` relative to `now` per the version-picker
// ladder. Exported for Node tests; its source is also inlined into the browser
// overlay (the `export ` keyword is stripped at inline time).
export function formatRelativeTime(iso, now) {
  const then = new Date(iso);
  const ref = now instanceof Date ? now : new Date(now);
  const diffMs = ref.getTime() - then.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'just now';
  if (diffMin <= 30) return `${diffMin} min ago`;

  const h = then.getHours();
  const m = then.getMinutes();
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const clock = `${h12}:${String(m).padStart(2, '0')} ${ampm}`;

  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(then, ref)) return `today, ${clock}`;

  const yesterday = new Date(ref);
  yesterday.setDate(ref.getDate() - 1);
  if (sameDay(then, yesterday)) return `yesterday, ${clock}`;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[then.getMonth()]} ${then.getDate()}, ${clock}`;
}
