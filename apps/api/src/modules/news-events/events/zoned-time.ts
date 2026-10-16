/** Spec §8: all times through Intl IANA zones — no hand-coded offsets. Pure. */
const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    cache.set(tz, f);
  }
  return f;
}

function parts(ms: number, tz: string): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour) % 24, mm: Number(p.minute), ss: Number(p.second) };
}

export function tzOffsetMs(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of wall-clock `ymd hh:mm` in IANA zone `tz`. */
export function zonedToUtc(ymd: string, hhmm: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mi);
  const o1 = tzOffsetMs(guess, tz);
  let t = guess - o1;
  const o2 = tzOffsetMs(t, tz);
  if (o2 !== o1) t = guess - o2;
  return new Date(t);
}

export function ymdInTz(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function istLabel(d: Date): string {
  const p = parts(d.getTime(), 'Asia/Kolkata');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)} IST`;
}

export function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, of the calendar date itself. */
export function weekdayOfYmd(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
