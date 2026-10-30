/**
 * OI check on a PAPER trade's entry (owner 2026-10-29). RECORD ONLY: it never blocks, delays or
 * changes the trade — the nightly review checks whether "OI against" trades lose before it is ever
 * a filter. Motivation (prod 2026-10-29, CRUDEOIL): a CE at 14:11 IST while near-money put OI had
 * unwound all day (−22% since open, calls flat), and a PE at 14:39 IST while put OI was building
 * (writers defending the low; crude bounced). OI said AGAINST both.
 *
 * Two sources, in order:
 *  1. CHAIN — the underlying's option strikes in oi_snapshots (the traded contract's expiry, else the
 *     nearest with data): ±{@link OI_CHECK.nearStrikes} strikes around the underlying price, CE and PE
 *     OI summed over the strikes present in BOTH snapshots of a window (like-for-like: a 3-min bucket
 *     missing strikes would otherwise read as unwinding), now vs ~30 min ago and vs the session's
 *     first snapshot. Lean = (ΔPE − ΔCE) / near-money total then: put writing / call unwinding is
 *     bullish, call writing / put unwinding bearish; |lean| < {@link OI_CHECK.chainLeanMin} = neutral.
 *  2. FUTURES — the underlying's current-month future in oi_snapshots, with its 1m closes: OI up +
 *     price up = long buildup (bullish), OI up + price down = short buildup (bearish), OI down + price
 *     up = short covering (weak bullish), OI down + price down = long unwinding (weak bearish).
 * Each window's lean is held against the trade's direction; verdict = AGREES (every leaning window
 * agrees), AGAINST (every leaning window disagrees), MIXED (they disagree with each other, or no
 * window leans), NO_DATA (no usable window, or any error). Pure.
 */

export type OiVerdict = 'AGREES' | 'AGAINST' | 'MIXED' | 'NO_DATA';
export type OiSource = 'CHAIN' | 'FUTURES' | 'NONE';
export type Lean = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type Buildup = 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'NEUTRAL';

/** The thresholds (config constants, documented in the module comment). */
export const OI_CHECK = Object.freeze({
  /** Strikes each side of the one nearest the underlying price (11 strikes → 22 contracts). */
  nearStrikes: 5,
  /** The "~30 min ago" window: the usable snapshot nearest now − 30 min, at most 10 min off. */
  agoMin: 30,
  agoToleranceMin: 10,
  /** The "now" snapshot must be at most this old at the trade's open. */
  nowMaxAgeMin: 15,
  /** A snapshot covering fewer than this share of the best-covered snapshot's near-money contracts is unusable. */
  minCoverage: 0.8,
  /** Like-for-like contracts a chain window needs (fewer = the window is unusable). */
  minChainContracts: 6,
  /** Chain lean (ΔPE − ΔCE) / near-money total then: ≥ +2.5% bullish, ≤ −2.5% bearish. */
  chainLeanMin: 0.025,
  /** Futures: |ΔOI| ≥ 1% of OI then and |Δprice| ≥ 0.1% to call a buildup. */
  futOiMin: 0.01,
  futPriceMin: 0.001,
  /** A 1m close is the price at an OI snapshot when it is at most this far before / after it. */
  priceToleranceMin: 5,
});

/** One oi_snapshots row (timestamps are absolute instants). */
export interface OiRow {
  instrumentId: string;
  oi: number;
  at: Date;
}

export interface ChainContractRef {
  instrumentId: string;
  strike: number;
  optionType: 'CE' | 'PE';
}

export interface OiCheckInput {
  /** The paper trade's open. */
  at: Date;
  /** What the trade wants the underlying to do. */
  want: 'BULLISH' | 'BEARISH';
  /** The venue session's open (NSE 09:15 / MCX 09:00 IST) on the trade's day. */
  sessionStart: Date;
  chain: {
    expiry: string;
    contracts: ChainContractRef[];
    rows: OiRow[];
    /** The underlying price the near-money strikes centre on, and where it came from. */
    center: number | null;
    centerSource: string;
  } | null;
  futures: {
    instrumentId: string;
    symbol: string;
    rows: OiRow[];
    /** 1m closes of the price series (ascending or not). */
    prices: Array<{ at: Date; close: number }>;
    priceSource: string;
  } | null;
}

export interface ChainWindow {
  from: string;
  to: string;
  contracts: number;
  ceThen: number;
  ceNow: number;
  peThen: number;
  peNow: number;
  /** ΔCE / CE then, ΔPE / PE then. */
  cePct: number | null;
  pePct: number | null;
  /** (ΔPE − ΔCE) / (CE + PE then) — positive = bullish. */
  leanPct: number;
  lean: Lean;
}

export interface FuturesWindow {
  from: string;
  to: string;
  oiThen: number;
  oiNow: number;
  oiPct: number;
  priceThen: number | null;
  priceNow: number | null;
  pricePct: number | null;
  buildup: Buildup | null;
  lean: Lean | null;
}

export interface OiCheck {
  verdict: OiVerdict;
  source: OiSource;
  want: 'BULLISH' | 'BEARISH';
  at: string;
  /** One line for the page / review. */
  summary: string;
  chain?: {
    expiry: string;
    center: number | null;
    centerSource: string;
    strikes: number[];
    windows: { ago: ChainWindow | null; open: ChainWindow | null };
    note?: string;
  };
  futures?: {
    symbol: string;
    priceSource: string;
    windows: { ago: FuturesWindow | null; open: FuturesWindow | null };
    note?: string;
  };
  error?: string;
}

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const pctText = (x: number | null) => (x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

/** The direction a trade wants: long CE / FUT / EQ and short PE want up; SELL inverts. */
export function wantedLean(kind: string, side: string): 'BULLISH' | 'BEARISH' {
  const buy = String(side).toUpperCase() !== 'SELL';
  const up = String(kind).toUpperCase() === 'PE' ? !buy : buy;
  return up ? 'BULLISH' : 'BEARISH';
}

/** Snapshot buckets: every row of one capture run shares its timestamp. */
export function buckets(rows: readonly OiRow[], keep: ReadonlySet<string> | null): Array<{ at: number; oi: Map<string, number> }> {
  const by = new Map<number, Map<string, number>>();
  for (const r of rows) {
    if (keep && !keep.has(r.instrumentId)) continue;
    if (!Number.isFinite(r.oi) || r.oi < 0) continue;
    const t = r.at.getTime();
    const m = by.get(t) ?? new Map<string, number>();
    m.set(r.instrumentId, r.oi);
    by.set(t, m);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([at, oi]) => ({ at, oi }));
}

/** now = latest usable ≤ at (≤ nowMaxAge old); ago = usable nearest at − 30 min; open = first usable ≥ session start. */
function pickWindows<T extends { at: number }>(usable: readonly T[], at: Date, sessionStart: Date): { now: T | null; ago: T | null; open: T | null; note?: string } {
  const t = at.getTime();
  const inSession = usable.filter((b) => b.at >= sessionStart.getTime() && b.at <= t);
  const now = inSession.length ? inSession[inSession.length - 1] : null;
  if (!now) return { now: null, ago: null, open: null, note: 'no usable snapshot this session before the trade' };
  if (t - now.at > OI_CHECK.nowMaxAgeMin * MIN) return { now: null, ago: null, open: null, note: `latest usable snapshot ${iso(now.at)} is older than ${OI_CHECK.nowMaxAgeMin} min` };
  const before = inSession.filter((b) => b.at < now.at);
  const target = t - OI_CHECK.agoMin * MIN;
  let ago: T | null = null;
  for (const b of before) if (Math.abs(b.at - target) <= OI_CHECK.agoToleranceMin * MIN && (!ago || Math.abs(b.at - target) < Math.abs(ago.at - target))) ago = b;
  const open = before.length ? before[0] : null;
  // The session's first snapshot IS the 30-min one shortly after the open — keep both, they agree by construction.
  return { now, ago, open };
}

function leanOf(x: number, min: number): Lean {
  return x >= min ? 'BULLISH' : x <= -min ? 'BEARISH' : 'NEUTRAL';
}

/** Near-money strikes: ±nearStrikes around the strike nearest `center`, from the strikes that have data. */
export function nearStrikes(strikes: readonly number[], center: number, n: number = OI_CHECK.nearStrikes): number[] {
  const s = [...new Set(strikes.filter((x) => Number.isFinite(x)))].sort((a, b) => a - b);
  if (s.length === 0) return [];
  let i = 0;
  for (let k = 1; k < s.length; k++) if (Math.abs(s[k] - center) < Math.abs(s[i] - center)) i = k;
  return s.slice(Math.max(0, i - n), i + n + 1);
}

export function chainWindow(then: { at: number; oi: Map<string, number> }, now: { at: number; oi: Map<string, number> }, typeOf: Map<string, 'CE' | 'PE'>): ChainWindow | null {
  let ceThen = 0, ceNow = 0, peThen = 0, peNow = 0, n = 0;
  for (const [id, oiNow] of now.oi) {
    const oiThen = then.oi.get(id);
    if (oiThen === undefined) continue; // like-for-like: only contracts present in both
    n++;
    if (typeOf.get(id) === 'CE') { ceThen += oiThen; ceNow += oiNow; } else { peThen += oiThen; peNow += oiNow; }
  }
  const total = ceThen + peThen;
  if (n < OI_CHECK.minChainContracts || total <= 0) return null;
  const leanPct = r4((peNow - peThen - (ceNow - ceThen)) / total);
  return {
    from: iso(then.at),
    to: iso(now.at),
    contracts: n,
    ceThen, ceNow, peThen, peNow,
    cePct: ceThen > 0 ? r4((ceNow - ceThen) / ceThen) : null,
    pePct: peThen > 0 ? r4((peNow - peThen) / peThen) : null,
    leanPct,
    lean: leanOf(leanPct, OI_CHECK.chainLeanMin),
  };
}

/** The chain reading; null windows + note when the data cannot answer. */
export function chainReading(i: OiCheckInput): NonNullable<OiCheck['chain']> | null {
  const c = i.chain;
  if (!c) return null;
  const typeOf = new Map(c.contracts.map((x) => [x.instrumentId, x.optionType]));
  const withData = new Set(c.rows.map((r) => r.instrumentId));
  const strikesWithData = c.contracts.filter((x) => withData.has(x.instrumentId)).map((x) => x.strike);
  const base = { expiry: c.expiry, center: c.center, centerSource: c.centerSource };
  if (c.center === null || !(c.center > 0)) return { ...base, strikes: [], windows: { ago: null, open: null }, note: 'no underlying price to centre the near-money strikes' };
  const strikes = nearStrikes(strikesWithData, c.center);
  if (strikes.length === 0) return { ...base, strikes, windows: { ago: null, open: null }, note: 'no option snapshots for this expiry' };
  const near = new Set(c.contracts.filter((x) => strikes.includes(x.strike)).map((x) => x.instrumentId));
  const all = buckets(c.rows, near);
  const best = Math.max(0, ...all.map((b) => b.oi.size));
  const usable = all.filter((b) => b.oi.size >= best * OI_CHECK.minCoverage);
  const w = pickWindows(usable, i.at, i.sessionStart);
  const ago = w.now && w.ago ? chainWindow(w.ago, w.now, typeOf) : null;
  const open = w.now && w.open ? chainWindow(w.open, w.now, typeOf) : null;
  const dropped = all.length - usable.length;
  const notes = [w.note, dropped > 0 ? `${dropped} snapshot(s) covering < ${OI_CHECK.minCoverage * 100}% of the near-money contracts skipped` : null].filter(Boolean);
  return { ...base, strikes, windows: { ago, open }, ...(notes.length ? { note: notes.join('; ') } : {}) };
}

/** The 1m close nearest `atMs` within the tolerance (the snapshot's price). */
function priceAt(prices: ReadonlyArray<{ at: Date; close: number }>, atMs: number): number | null {
  let best: { d: number; p: number } | null = null;
  for (const p of prices) {
    if (!(p.close > 0)) continue;
    const d = Math.abs(p.at.getTime() - atMs);
    if (d <= OI_CHECK.priceToleranceMin * MIN && (!best || d < best.d)) best = { d, p: p.close };
  }
  return best?.p ?? null;
}

export function buildupOf(oiPct: number, pricePct: number): Buildup {
  const oiUp = oiPct >= OI_CHECK.futOiMin, oiDown = oiPct <= -OI_CHECK.futOiMin;
  const pUp = pricePct >= OI_CHECK.futPriceMin, pDown = pricePct <= -OI_CHECK.futPriceMin;
  if (oiUp && pUp) return 'LONG_BUILDUP';
  if (oiUp && pDown) return 'SHORT_BUILDUP';
  if (oiDown && pUp) return 'SHORT_COVERING';
  if (oiDown && pDown) return 'LONG_UNWINDING';
  return 'NEUTRAL';
}

const BUILDUP_LEAN: Record<Buildup, Lean> = {
  LONG_BUILDUP: 'BULLISH',
  SHORT_COVERING: 'BULLISH',
  SHORT_BUILDUP: 'BEARISH',
  LONG_UNWINDING: 'BEARISH',
  NEUTRAL: 'NEUTRAL',
};

function futuresWindow(then: { at: number; oi: number }, now: { at: number; oi: number }, prices: ReadonlyArray<{ at: Date; close: number }>): FuturesWindow | null {
  if (!(then.oi > 0)) return null;
  const oiPct = r4((now.oi - then.oi) / then.oi);
  const priceThen = priceAt(prices, then.at);
  const priceNow = priceAt(prices, now.at);
  const pricePct = priceThen && priceNow ? r4((priceNow - priceThen) / priceThen) : null;
  const buildup = pricePct === null ? null : buildupOf(oiPct, pricePct);
  return { from: iso(then.at), to: iso(now.at), oiThen: then.oi, oiNow: now.oi, oiPct, priceThen, priceNow, pricePct, buildup, lean: buildup ? BUILDUP_LEAN[buildup] : null };
}

export function futuresReading(i: OiCheckInput): NonNullable<OiCheck['futures']> | null {
  const f = i.futures;
  if (!f) return null;
  const pts = buckets(f.rows, new Set([f.instrumentId])).map((b) => ({ at: b.at, oi: b.oi.get(f.instrumentId) as number }));
  const w = pickWindows(pts, i.at, i.sessionStart);
  const ago = w.now && w.ago ? futuresWindow(w.ago, w.now, f.prices) : null;
  const open = w.now && w.open ? futuresWindow(w.open, w.now, f.prices) : null;
  const noPrice = [ago, open].some((x) => x && x.pricePct === null);
  const notes = [w.note, noPrice ? `no ${f.priceSource} price near a snapshot — buildup unknown` : null].filter(Boolean);
  return { symbol: f.symbol, priceSource: f.priceSource, windows: { ago, open }, ...(notes.length ? { note: notes.join('; ') } : {}) };
}

/** Each leaning window held against the trade: all agree → AGREES, all disagree → AGAINST, else MIXED. */
export function verdictOf(want: 'BULLISH' | 'BEARISH', leans: ReadonlyArray<Lean | null>): OiVerdict {
  const read = leans.filter((l): l is Lean => l !== null);
  if (read.length === 0) return 'NO_DATA';
  const agree = read.some((l) => l === want);
  const against = read.some((l) => l !== 'NEUTRAL' && l !== want);
  return agree && !against ? 'AGREES' : against && !agree ? 'AGAINST' : 'MIXED';
}

function chainSummary(c: NonNullable<OiCheck['chain']>): string {
  const part = (k: string, w: ChainWindow | null) => (w ? `${k}: CE ${pctText(w.cePct)} PE ${pctText(w.pePct)} → ${w.lean.toLowerCase()} (${pctText(w.leanPct)})` : null);
  return [part('30m', c.windows.ago), part('open', c.windows.open)].filter(Boolean).join('; ');
}

function futSummary(f: NonNullable<OiCheck['futures']>): string {
  const part = (k: string, w: FuturesWindow | null) => (w ? `${k}: OI ${pctText(w.oiPct)} price ${pctText(w.pricePct)} → ${w.buildup ? w.buildup.toLowerCase().replace('_', ' ') : 'no price'}` : null);
  return [part('30m', f.windows.ago), part('open', f.windows.open)].filter(Boolean).join('; ');
}

/** The OI check. Never throws: an error is NO_DATA with the error noted. */
export function oiCheck(i: OiCheckInput): OiCheck {
  const head = { want: i.want, at: i.at.toISOString() };
  try {
    const chain = chainReading(i);
    const chainLeans = chain ? [chain.windows.ago?.lean ?? null, chain.windows.open?.lean ?? null] : [];
    if (chain && chainLeans.some((l) => l !== null)) {
      const verdict = verdictOf(i.want, chainLeans);
      return { verdict, source: 'CHAIN', ...head, summary: `${verdict} (chain ${chain.expiry}, want ${i.want.toLowerCase()}) ${chainSummary(chain)}`, chain };
    }
    const fut = futuresReading(i);
    const futLeans = fut ? [fut.windows.ago?.lean ?? null, fut.windows.open?.lean ?? null] : [];
    if (fut && futLeans.some((l) => l !== null)) {
      const verdict = verdictOf(i.want, futLeans);
      return { verdict, source: 'FUTURES', ...head, summary: `${verdict} (${fut.symbol}, want ${i.want.toLowerCase()}) ${futSummary(fut)}`, ...(chain ? { chain } : {}), futures: fut };
    }
    const why = [chain?.note ?? (i.chain ? null : 'no option chain in oi_snapshots'), fut?.note ?? (i.futures ? null : 'no future in oi_snapshots')].filter(Boolean).join('; ');
    return { verdict: 'NO_DATA', source: 'NONE', ...head, summary: `NO_DATA: ${why || 'no usable OI window'}`, ...(chain ? { chain } : {}), ...(fut ? { futures: fut } : {}) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { verdict: 'NO_DATA', source: 'NONE', ...head, summary: `NO_DATA: error ${error}`, error };
  }
}

/** A stored check's verdict (anything unreadable, or no check, is NO_DATA). */
export function oiVerdictOf(record: unknown): OiVerdict {
  const v = record && typeof record === 'object' && !Array.isArray(record) ? (record as Record<string, unknown>).verdict : null;
  return v === 'AGREES' || v === 'AGAINST' || v === 'MIXED' ? v : 'NO_DATA';
}
