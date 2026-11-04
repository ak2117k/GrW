import type { SessionClock } from './session-clock';
import { refKey, type HubExchange, type InstrumentRef } from './hub.types';

/**
 * The hub's LINES: the instruments whose 1-minute bars the engines read straight from candles_1m
 * (entry engine trend, pre-open outlook, exit-noise, self-review), so they must get a bar every
 * minute of their whole session — not only while some screen, trigger or position happens to
 * watch them.
 *
 * Prod 2026-11-03: CRUDEOIL19NOV26FUT (MCX 573422) had no watcher of its own. Its tick bars lasted
 * only while a transient watch held it (a browser chart / an AI trigger / a 60 s entry watch) and
 * stopped at 18:04 IST; its 'broker' bars were only ever a side effect of someone reading
 * hub.candles() (the last read ~17:57). The entry engine then froze crude at 9218 for 2 h while
 * crude fell to 8881. The day before it stopped at 19:24. MCX positions never held the future
 * either: the position underlying lookup had no `future` resolver, so an MCX option resolved to
 * no underlying at all.
 *
 * So the lines are: the index spot tokens, plus the near-month future of every name in
 * HUB_LINE_FUTURES. The engine watches them pinned at priority 1 (a live slot before any position
 * token; polled on the Critical lane when the socket is down), builds bars from polled quotes too,
 * and refills from the broker's 1m history when a line's bars go stale.
 *
 * 2026-11-04: GOLD and SILVER joined the default (2 slots). On the US-midterm day GOLD moved ~3.5k
 * points and candles_1m held ZERO bars for GOLD04DEC26FUT (MCX 495213): the judge, the noise units
 * and the entry engine read gold blind. Full GOLD, not GOLDM (owner). Rollback: set
 * HUB_LINE_FUTURES=NIFTY,BANKNIFTY,SENSEX,CRUDEOIL,CRUDEOILM.
 */
export const DEFAULT_LINE_FUTURES = 'NIFTY,BANKNIFTY,SENSEX,CRUDEOIL,CRUDEOILM,GOLD,SILVER';

/** Hub watch owner of the lines. */
export const LINES_OWNER = 'hub:lines';

/** A line whose newest bar ENDED longer ago than this (while its exchange is open) is refilled from the broker. */
export const LINE_STALE_MS = 90_000;

/** HUB_LINE_FUTURES → upper-cased, de-duplicated master names. Unset/blank ⇒ the default list; 'none' ⇒ []. */
export function parseLineFutures(raw: string | undefined): string[] {
  const s = (raw ?? '').trim();
  if (s.toLowerCase() === 'none') return [];
  const names = (s === '' ? DEFAULT_LINE_FUTURES : s)
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(names)];
}

const NFO_NAMES: ReadonlySet<string> = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']);
const BFO_NAMES: ReadonlySet<string> = new Set(['SENSEX', 'BANKEX', 'SENSEX50']);

/** Where a name's futures trade: index names on NFO / BFO, anything else is a commodity on MCX (stock futures are not lines). */
export function futureExchangeFor(name: string): HubExchange {
  const n = name.toUpperCase();
  if (NFO_NAMES.has(n)) return 'NFO';
  if (BFO_NAMES.has(n)) return 'BFO';
  return 'MCX';
}

/** The master's nearest active future of `name` on `exchange` expiring on/after `onOrAfter`. */
export type NearestFutureLookup = (
  name: string,
  exchange: HubExchange,
  onOrAfter: Date,
) => Promise<{ token: string; symbol?: string | null } | null>;

/**
 * Each name's near-month future (the same pick as signal-trader / exit-noise `nearestFuture`:
 * earliest active FUT expiring on/after today's IST midnight). A name that fails or is missing is
 * reported, never thrown: one bad name must not cost the others their line.
 */
export async function resolveLineFutures(
  names: readonly string[],
  lookup: NearestFutureLookup,
  todayMidnight: Date,
): Promise<{ found: Map<string, InstrumentRef>; missing: string[] }> {
  const found = new Map<string, InstrumentRef>();
  const missing: string[] = [];
  for (const name of names) {
    const exchange = futureExchangeFor(name);
    try {
      const f = await lookup(name, exchange, todayMidnight);
      if (f?.token) found.set(name, { exchange, token: String(f.token), symbol: f.symbol || name });
      else missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  return { found, missing };
}

/** Index lines first, then futures; one entry per EXCHANGE:token. */
export function mergeLines(...groups: ReadonlyArray<readonly InstrumentRef[]>): InstrumentRef[] {
  const out = new Map<string, InstrumentRef>();
  for (const g of groups) for (const r of g) if (!out.has(refKey(r))) out.set(refKey(r), r);
  return [...out.values()];
}

/**
 * The underlyings of open STOCK-option positions that become pinned lines (spec 2026-11-04 carry
 * §5.5). Prod 2026-11-04: a LAURUSLABS option was open all session and candles_1m held 4 bars for
 * LAURUSLABS-EQ (NSE 19234). A position's underlying was only a P1 watch: tick-only (no bars from
 * polled quotes) and no broker refill when its ticks stopped, so the sentinel's underlying read had
 * nothing to stand on. A line gets both.
 *
 * Only cash underlyings (NSE / BSE, not already a line): index spots and the near-month futures are
 * lines already, and an MCX option's future is a P1 position underlying as before. One slot per
 * distinct underlying, released when no open position needs it (the caller recomputes on every
 * position refresh). Budget: pinned lines take live slots BEFORE position contracts
 * (slot-allocator.ts), so a pinned underlying must never cost a held contract its slot — at most
 * `cap − base lines − position contracts` are pinned; the rest stay plain P1 watches. Pure.
 */
export function positionUnderlyingLines(
  underlyings: readonly InstrumentRef[],
  opts: { base: readonly InstrumentRef[]; positions: number; cap: number },
): InstrumentRef[] {
  const taken = new Set(opts.base.map(refKey));
  let budget = Math.max(0, Math.floor(opts.cap) - taken.size - Math.max(0, opts.positions));
  const out: InstrumentRef[] = [];
  for (const u of underlyings) {
    if (budget <= 0) break;
    if (u.exchange !== 'NSE' && u.exchange !== 'BSE') continue;
    const k = refKey(u);
    if (taken.has(k)) continue;
    taken.add(k);
    out.push(u);
    budget--;
  }
  return out;
}

/**
 * The lines due a broker refill at `now`: exchange open, and no bar yet this process
 * (`lastBarStart` unset — heals the day after a restart) or the newest bar ended more than
 * {@link LINE_STALE_MS} ago (the ticks stopped). Pure.
 */
export function staleLines(
  lines: readonly InstrumentRef[],
  lastBarStart: ReadonlyMap<string, number>,
  clock: Pick<SessionClock, 'isOpen'>,
  now: number,
): InstrumentRef[] {
  const at = new Date(now);
  return lines.filter((r) => {
    if (!clock.isOpen(r.exchange, at)) return false;
    const last = lastBarStart.get(refKey(r));
    return last === undefined || now - (last + 60_000) > LINE_STALE_MS;
  });
}
