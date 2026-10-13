// Android's formats: DateFormatter.formatAbbrev (no year within this year)
// and Converter.getDurationStringLong (HH:MM:SS).

export function formatAbbrev(ms: number, now = new Date()): string {
  if (!ms) return "";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }).format(d);
}

export function durationLong(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** durationLocalized is Converter.getDurationStringLocalized: "3 hours 5 minutes" style, for statistics. */
export function hoursMinutes(ms: number): { h: number; m: number } {
  const minutes = Math.floor(ms / 60000);
  return { h: Math.floor(minutes / 60), m: minutes % 60 };
}
