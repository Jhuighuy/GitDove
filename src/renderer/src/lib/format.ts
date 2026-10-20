// The UI is English, so dates are too (mixing languages reads poorly).
const LOCALE = "en";
const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
const dtf = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 days ago" style formatting of a unix timestamp (seconds). */
export const relativeTime = (seconds: number, now = Date.now() / 1000): string => {
  const diff = seconds - now;
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return "just now";
};

export const absoluteTime = (seconds: number): string => dtf.format(new Date(seconds * 1000));

export const shortHash = (hash: string): string => hash.slice(0, 7);

export const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts.at(-1)![0]!).toUpperCase();
};

/** Deterministic hue for a string (e.g. author email). */
export const hueOf = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
};

export const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
export const dirname = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
};

const BYTE_UNITS = ["KB", "MB", "GB"];

/** Formats a byte count, e.g. `512 B`, `4.2 KB`, `13 MB`. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  let n = bytes / 1024;
  let unit = 0;
  while (n >= 1024 && unit < BYTE_UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${BYTE_UNITS[unit]}`;
};
