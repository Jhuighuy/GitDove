import type { DateStyle } from "@shared/settings";

// The UI is English, so dates are too (mixing languages reads poorly).
const LOCALE = "en";
const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
const dtf = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" });

/** Each unit's length, and the count that reads as one of the next larger unit. */
const UNITS: [Intl.RelativeTimeFormatUnit, number, number][] = [
  ["year", 365 * 24 * 3600, Infinity],
  ["month", 30 * 24 * 3600, 12],
  ["week", 7 * 24 * 3600, Infinity],
  ["day", 24 * 3600, 7],
  ["hour", 3600, 24],
  ["minute", 60, 60],
];

/** "3 days ago" style formatting of a unix timestamp (seconds). */
export const relativeTime = (seconds: number, now = Date.now() / 1000): string => {
  const diff = seconds - now;
  for (const [i, [unit, size, next]] of UNITS.entries()) {
    if (Math.abs(diff) < size) continue;
    const count = Math.round(diff / size);
    // Rounding up to e.g. 12 months reads as "last year" instead.
    return Math.abs(count) >= next
      ? rtf.format(Math.sign(count), UNITS[i - 1]![0])
      : rtf.format(count, unit);
  }
  return "just now";
};

export const absoluteTime = (seconds: number): string => dtf.format(new Date(seconds * 1000));

const pad = (n: number) => String(n).padStart(2, "0");

/** A compact local date and time, e.g. `2026-10-27 15:04`, for lists. */
export const compactTime = (seconds: number): string => {
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A date in a list, in the style chosen in the settings. */
export const listTime = (seconds: number, style: DateStyle, now = Date.now() / 1000): string =>
  style === "relative" ? relativeTime(seconds, now) : compactTime(seconds);

export const shortHash = (hash: string): string => hash.slice(0, 7);

/** "Name <email>", as git writes a person: the hover text of an author or committer. */
export const nameAndEmail = (name: string, email: string): string => `${name} <${email}>`;

const graphemes = new Intl.Segmenter();

/**
 * Up to two letters for a name: by grapheme, so that a character (an accented letter, an emoji
 * sequence) is never split in half.
 */
export const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const letters = (s: string, n: number) =>
    Array.from(graphemes.segment(s), (g) => g.segment)
      .slice(0, n)
      .join("");
  if (parts.length === 1) return letters(parts[0]!, 2).toUpperCase();
  return (letters(parts[0]!, 1) + letters(parts.at(-1)!, 1)).toUpperCase();
};

/** Deterministic hue for a string (e.g. author email). */
export const hueOf = (s: string): number => {
  let h = 0;
  // `| 0` wraps to int32 and UTF-16 code units are hashed on purpose.
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; // NOSONAR
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
  // By the number shown: 1023.9 KB would show as 1024 KB.
  while (Math.round(n) >= 1024 && unit < BYTE_UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n < 9.95 ? n.toFixed(1) : Math.round(n)} ${BYTE_UNITS[unit]}`;
};
