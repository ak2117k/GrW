/** Date helpers for the formats Indian venues print. Pure. */

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');

/** '09-Oct-2026' or 'Oct 09, 2026' / 'Oct 09,2026' → '2026-10-09'; null otherwise. */
export function nseDateToYmd(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(s);
  if (m) return ymd(Number(m[3]), MONTHS[m[2].toUpperCase()], Number(m[1]));
  m = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})/.exec(s);
  if (m) return ymd(Number(m[3]), MONTHS[m[1].toUpperCase()], Number(m[2]));
  return null;
}

function ymd(y: number, mo: number | undefined, d: number): string | null {
  if (!mo || !Number.isFinite(y) || !Number.isFinite(d) || d < 1 || d > 31) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** '10-Oct-2026 02:30:09' (IST wall clock, seconds optional) → ISO UTC; null otherwise. */
export function istDateTimeToIso(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  const date = nseDateToYmd(s);
  const t = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(s);
  if (!date || !t) return null;
  const ms = Date.parse(`${date}T${pad(Number(t[1]))}:${t[2]}:${t[3] ?? '00'}.000Z`) - IST_OFFSET_MS;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** IST calendar date of an instant. */
export function istYmd(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes since IST midnight. */
export function istMinutes(at: Date): number {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** The UTC instant of IST `hh:mm` on IST date `ymd`. */
export function istAt(ymdStr: string, hh: number, mm = 0): Date {
  return new Date(Date.parse(`${ymdStr}T${pad(hh)}:${pad(mm)}:00.000Z`) - IST_OFFSET_MS);
}

/** A number off a venue string: commas, a leading '+', a trailing '%', and accounting parentheses for negatives. Null when not a finite number. */
export function venueNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw ?? '').trim().replace(/,/g, '').replace(/%$/, '');
  let sign = 1;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    s = paren[1];
    sign = -1;
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s) * sign;
  return Number.isFinite(n) ? n : null;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
