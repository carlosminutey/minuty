// Capture window: the last N hours up to `now` (UTC milliseconds).
// `date` is today's date in IST (UTC+5:30, no daylight saving), for display.
export function lastHoursWindow(now, { windowHours, tzOffsetMin }) {
  const local = new Date(now + tzOffsetMin * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}`;
  return { start: now - windowHours * 3600_000, end: now + 60_000, date };
}

export const inWindow = (iso, w) => {
  const t = new Date(iso).getTime();
  return t >= w.start && t < w.end;
};
