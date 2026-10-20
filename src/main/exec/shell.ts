/** Quotes a string for a POSIX shell. */
export const shellQuote = (s: string): string =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;

export const shellJoin = (argv: readonly string[]): string => argv.map(shellQuote).join(" ");
