/**
 * Next-morning trade setups (stream T). PURE: inputs in, setups / outcomes out.
 *
 * ADVISORY ONLY. A setup is text for the owner to act on by hand: nothing here places an order,
 * creates a paper trade or feeds auto-trade, and no hard risk limit is read or changed.
 *
 * Direction comes from the NEWS IDEA (CE_IDEA → long, PE_IDEA → short). Our research shows a
 * price-based direction is unproven; the stock big-move model (and the NIFTY MBM regime) only say
 * a move is likely to be BIG, never which way.
 */

export const RISK_PCT = 0.01;
export const INTRADAY_LEVERAGE = 5;
/** Roll to the next month when the near future has this many NSE sessions left or fewer. */
export const ROLL_SESSIONS = 3;
export const ATR_PERIOD = 14;
/**
 * Stop: 1× daily ATR from entry. The floor used to be 0.5× ATR (the opening range's far end was
 * used when tighter); the level-break research (grw-mbm research/level-break, 2026-10-23) found
 * sub-1-ATR intraday stops get run first and a 1-ATR stop lost far less, so the floor is now
 * 1× ATR — with the 1× cap that means exactly 1× daily ATR. Sizing stays 1 % risk, so a wider
 * stop means fewer shares / lots, never more risk.
 */
export const STOP_ATR_MAX = 1;
export const STOP_ATR_MIN = 1;
export const TARGET1_R = 1.5;
export const TARGET2_R = 2.5;
/** Skip if the open gaps this many daily ATRs against the side. */
export const GAP_SKIP_ATR = 1.5;
/** Futures margin estimate (SPAN + exposure) as a share of contract value; the broker decides the real one. */
export const FUT_MARGIN_EST = 0.2;
export const PER_LAKH = 100_000;
export const TIME_EXIT_IST = '15:10';
export const OPENING_RANGE_IST = '09:15';
const OPENING_RANGE_MIN = 9 * 60 + 15;
const TIME_EXIT_MIN = 15 * 60 + 10;
const IST_OFFSET_MS = 5.5 * 3600_000;

export type SetupSide = 'LONG' | 'SHORT';
export type InstrumentKind = 'FUTURES' | 'CASH_MIS';
export type MarginSource = 'LIVE' | 'LAST_KNOWN' | 'PER_LAKH';

// ─── Trigger ─────────────────────────────────────────────────────────────────

export interface TriggerInput {
  idea: string; // CE_IDEA | PE_IDEA | NO_TRADE
  isIndex: boolean;
  /** Stock big-move reading from the latest book (null = not scored). */
  stock: { bucket: string; resultsInWindow: boolean } | null;
  /** Index only: the NIFTY MBM move-size regime is ACTIVE. */
  mbmActive: boolean;
}

/** News AND model must agree; anything else is skipped. */
export function triggerFor(t: TriggerInput): { ok: true; side: SetupSide; why: string } | { ok: false; why: string } {
  const side: SetupSide | null = t.idea === 'CE_IDEA' ? 'LONG' : t.idea === 'PE_IDEA' ? 'SHORT' : null;
  if (!side) return { ok: false, why: `news idea is ${t.idea} (no direction)` };
  if (t.isIndex) {
    return t.mbmActive
      ? { ok: true, side, why: 'news idea + NIFTY move-size regime ACTIVE' }
      : { ok: false, why: 'index: MBM move-size regime is not ACTIVE' };
  }
  if (!t.stock) return { ok: false, why: 'no stock big-move score in the latest book' };
  if (t.stock.bucket === 'TOP20') return { ok: true, side, why: `news idea + big-move model TOP20${t.stock.resultsInWindow ? ' (results in window)' : ''}` };
  if (t.stock.resultsInWindow) return { ok: true, side, why: `news idea + results in the 5-session window (${t.stock.bucket})` };
  return { ok: false, why: `big-move model ${t.stock.bucket}, no results in window` };
}

// ─── ATR / stop ──────────────────────────────────────────────────────────────

export interface HlcBar {
  high: number;
  low: number;
  close: number;
}

/** Wilder-free simple ATR(14) of daily bars (oldest first); null with fewer than period + 1 bars. */
export function atr(bars: readonly HlcBar[], period = ATR_PERIOD): number | null {
  const b = bars.filter((x) => [x.high, x.low, x.close].every(Number.isFinite) && x.high >= x.low && x.close > 0);
  if (b.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = b.length - period; i < b.length; i++) {
    const pc = b[i - 1].close;
    trs.push(Math.max(b[i].high - b[i].low, Math.abs(b[i].high - pc), Math.abs(b[i].low - pc)));
  }
  return trs.reduce((s, x) => s + x, 0) / trs.length;
}

/**
 * Stop distance: the opening range's far end when known, clamped to [STOP_ATR_MIN, STOP_ATR_MAX] ×
 * ATR (currently [1, 1] → always 1× daily ATR). Without an opening range (the night plan): 1 × ATR.
 */
export function stopDistance(atrValue: number, orDistance?: number | null): number {
  const max = STOP_ATR_MAX * atrValue;
  const min = STOP_ATR_MIN * atrValue;
  if (orDistance == null || !Number.isFinite(orDistance) || orDistance <= 0) return max;
  return Math.min(max, Math.max(min, orDistance));
}

// ─── Futures contract ────────────────────────────────────────────────────────

export interface FutureContract {
  tradingSymbol: string;
  token: string;
  /** IST 'YYYY-MM-DD'. */
  expiry: string;
  lotSize: number;
}

/**
 * Near month, rolled to the next when the near one has ≤ {@link ROLL_SESSIONS} NSE sessions left
 * (counted from the setup's session, inclusive). `sessionsLeft(expiry)` is the caller's calendar.
 */
export function pickFuture(
  contracts: readonly FutureContract[],
  sessionDate: string,
  sessionsLeft: (expiry: string) => number,
): { contract: FutureContract; rolled: boolean } | null {
  const live = contracts.filter((c) => c.expiry >= sessionDate).sort((a, b) => a.expiry.localeCompare(b.expiry));
  if (live.length === 0) return null;
  if (sessionsLeft(live[0].expiry) <= ROLL_SESSIONS && live.length > 1) return { contract: live[1], rolled: true };
  return { contract: live[0], rolled: false };
}

// ─── Sizing ──────────────────────────────────────────────────────────────────

export interface Sizing {
  qty: number;
  lots: number | null;
  riskRs: number;
  riskPct: number;
  rewardT1Rs: number;
  rewardT2Rs: number;
  marginUsed: number;
  exceedsRisk: boolean;
  notes: string[];
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Intraday cash (MIS): 1 % risk, capped so qty × entry ≤ 5 × available margin. */
export function sizeCash(margin: number, entry: number, dist: number): Sizing {
  const notes: string[] = [];
  const budget = margin * RISK_PCT;
  let qty = dist > 0 ? Math.floor(budget / dist) : 0;
  const cap = entry > 0 ? Math.floor((INTRADAY_LEVERAGE * margin) / entry) : 0;
  if (qty > cap) {
    qty = cap;
    notes.push(`capped at ${cap} shares by ${INTRADAY_LEVERAGE}x intraday leverage (risk under 1 %)`);
  }
  if (qty <= 0) notes.push('1 share risks more than 1 % of margin or exceeds 5x leverage: size is 0');
  return finish(qty, null, margin, dist, (qty * entry) / INTRADAY_LEVERAGE, false, notes);
}

/** Futures: 1 % risk in whole lots; a single lot over 1 % is still shown, flagged. */
export function sizeFutures(margin: number, entry: number, dist: number, lotSize: number): Sizing {
  const notes: string[] = [];
  const perLot = lotSize * dist;
  let lots = perLot > 0 ? Math.floor((margin * RISK_PCT) / perLot) : 0;
  let exceeds = false;
  if (lots < 1) {
    lots = 1;
    exceeds = true;
    notes.push(`exceeds 1% risk — 1 lot risks ₹${Math.round(perLot)} (${((perLot / margin) * 100).toFixed(1)}%)`);
  }
  const qty = lots * lotSize;
  const marginUsed = qty * entry * FUT_MARGIN_EST;
  if (marginUsed > margin) notes.push(`est. margin ₹${Math.round(marginUsed)} is above the available ₹${Math.round(margin)}`);
  return finish(qty, lots, margin, dist, marginUsed, exceeds, notes);
}

function finish(qty: number, lots: number | null, margin: number, dist: number, marginUsed: number, exceedsRisk: boolean, notes: string[]): Sizing {
  const riskRs = qty * dist;
  return {
    qty,
    lots,
    riskRs: round2(riskRs),
    riskPct: margin > 0 ? round2((riskRs / margin) * 100) : 0,
    rewardT1Rs: round2(riskRs * TARGET1_R),
    rewardT2Rs: round2(riskRs * TARGET2_R),
    marginUsed: round2(marginUsed),
    exceedsRisk,
    notes,
  };
}

// ─── The setup ───────────────────────────────────────────────────────────────

export interface MarginInput {
  value: number | null;
  asOf: string | null;
  source: 'LIVE' | 'LAST_KNOWN' | null;
}

export interface SetupInput {
  sessionDate: string;
  symbol: string;
  isIndex: boolean;
  side: SetupSide;
  triggerWhy: string;
  /** The underlying's last close and daily ATR (levels are on the cash / index chart). */
  close: number;
  priceAsOf: string | null;
  atr: number;
  /** Null ⇒ no futures: intraday cash (MIS). */
  future: { contract: FutureContract; rolled: boolean } | null;
  margin: MarginInput;
  context: ContextLine[];
  headlines: string[];
  newsIdeaId: string | null;
  vixLast: number | null;
}

export interface ContextLine {
  label: string;
  text: string;
  available: boolean;
}

export interface TradeSetupDraft {
  sessionDate: string;
  symbol: string;
  exchange: string;
  instrument: string;
  instrumentKind: InstrumentKind;
  instrumentToken: string | null;
  expiry: string | null;
  lotSize: number | null;
  side: SetupSide;
  newsIdeaId: string | null;
  entryRule: string;
  entryRef: number;
  stop: number;
  stopDistance: number;
  target1: number;
  target2: number;
  atr: number;
  qty: number;
  lots: number | null;
  riskRs: number;
  riskPct: number;
  rewardT1Rs: number;
  rewardT2Rs: number;
  marginUsed: number;
  marginAvailable: number | null;
  marginAsOf: string | null;
  marginSource: MarginSource;
  exceedsRisk: boolean;
  inputs: {
    trigger: string;
    direction: string;
    priceAsOf: string | null;
    sizingBasis: string;
    sizingNotes: string[];
    stopRule: string;
    targetsRule: string;
    timeExit: string | null;
    levelsNote: string;
    context: ContextLine[];
    skipIf: string[];
    headlines: string[];
    advisory: string;
  };
}

export const ADVISORY_NOTE = 'Advisory only — you place the order. The app never places, paper-trades or auto-trades this setup.';
export const DIRECTION_NOTE = 'Direction is from the news idea, not price: price-based direction is unproven in our research; the model only predicts move SIZE.';

const px = (x: number) => round2(x);

export function buildSetup(i: SetupInput): TradeSetupDraft {
  const long = i.side === 'LONG';
  const dist = stopDistance(i.atr);
  const sgn = long ? 1 : -1;
  const entry = i.close;
  const stop = entry - sgn * dist;
  const t1 = entry + sgn * TARGET1_R * dist;
  const t2 = entry + sgn * TARGET2_R * dist;

  const basis: MarginSource = i.margin.value != null && i.margin.value > 0 ? (i.margin.source ?? 'LAST_KNOWN') : 'PER_LAKH';
  const margin = basis === 'PER_LAKH' ? PER_LAKH : (i.margin.value as number);
  const sizingBasis =
    basis === 'PER_LAKH'
      ? 'per ₹1 lakh of margin (no broker margin known yet — scale to your account)'
      : `margin ₹${Math.round(margin).toLocaleString('en-IN')} ${basis === 'LIVE' ? 'live' : 'last known'}${i.margin.asOf ? ` as of ${i.margin.asOf}` : ''}`;

  const fut = i.future?.contract ?? null;
  const sizing = fut ? sizeFutures(margin, entry, dist, fut.lotSize) : sizeCash(margin, entry, dist);
  const word = long ? 'high' : 'low';
  const orRule = `Wait for the first 15-min candle (${OPENING_RANGE_IST}–09:30 IST) to close; enter ${long ? 'LONG' : 'SHORT'} only on a break of its ${word}${long ? ' (buy above it)' : ' (sell below it)'}. No break by 13:00 IST: no trade.`;
  const instrument = fut ? `${fut.tradingSymbol} (NFO futures${i.future?.rolled ? ', rolled: near month has ≤ 3 sessions left' : ', near month'})` : `${i.symbol} intraday cash (MIS)`;
  const skipIf = [
    `${i.symbol} opens more than ${GAP_SKIP_ATR}× ATR (${px(GAP_SKIP_ATR * i.atr)}) ${long ? 'below' : 'above'} ${px(entry)}, against the side`,
    `${i.symbol} opens more than ${GAP_SKIP_ATR}× ATR ${long ? 'above' : 'below'} the close: the move may be done`,
    `India VIX opens more than 10 % above its last close${i.vixLast ? ` (${i.vixLast.toFixed(2)})` : ''}: volatility spike`,
    'the first 15-min candle is wider than 1× ATR (its far end is beyond the 1× ATR stop — take it smaller or skip)',
  ];
  if (fut && !i.isIndex) skipIf.push(`${i.symbol} is in today's NSE F&O ban list (not fetched by the app — check before entering)`);

  return {
    sessionDate: i.sessionDate,
    symbol: i.symbol,
    exchange: fut ? 'NFO' : 'NSE',
    instrument,
    instrumentKind: fut ? 'FUTURES' : 'CASH_MIS',
    instrumentToken: fut?.token ?? null,
    expiry: fut?.expiry ?? null,
    lotSize: fut?.lotSize ?? null,
    side: i.side,
    newsIdeaId: i.newsIdeaId,
    entryRule: orRule,
    entryRef: px(entry),
    stop: px(stop),
    stopDistance: px(dist),
    target1: px(t1),
    target2: px(t2),
    atr: px(i.atr),
    qty: sizing.qty,
    lots: sizing.lots,
    riskRs: sizing.riskRs,
    riskPct: sizing.riskPct,
    rewardT1Rs: sizing.rewardT1Rs,
    rewardT2Rs: sizing.rewardT2Rs,
    marginUsed: sizing.marginUsed,
    marginAvailable: basis === 'PER_LAKH' ? null : margin,
    marginAsOf: basis === 'PER_LAKH' ? null : i.margin.asOf,
    marginSource: basis,
    exceedsRisk: sizing.exceedsRisk,
    inputs: {
      trigger: i.triggerWhy,
      direction: DIRECTION_NOTE,
      priceAsOf: i.priceAsOf,
      sizingBasis,
      sizingNotes: [
        ...sizing.notes,
        `sized on the 1× daily ATR stop (${px(dist)}) at ${RISK_PCT * 100} % risk — a wider stop means fewer shares/lots, never more risk; never size up`,
      ],
      stopRule: `Stop: 1× daily ATR (${px(dist)}) from your fill — not the first candle's ${long ? 'low' : 'high'} (stops under 1× ATR get run first intraday).`,
      targetsRule: `Targets from your fill: T1 = ${TARGET1_R}R, T2 = ${TARGET2_R}R (R = your stop distance). Shown from the last close ${px(entry)}.`,
      timeExit: `Intraday plan: exit by ${TIME_EXIT_IST} IST if neither target nor stop is hit${fut ? '' : ' (MIS is squared off by the broker later anyway)'}.`,
      levelsNote: fut
        ? `Levels are on the ${i.symbol} ${i.isIndex ? 'index' : 'cash'} chart; the future trades at a small premium (basis) — apply the same point distances to your futures fill.`
        : `Levels are on the ${i.symbol} cash chart (NSE, product MIS).`,
      context: i.context,
      skipIf,
      headlines: i.headlines,
      advisory: ADVISORY_NOTE,
    },
  };
}

// ─── Outcome (next session, from 15-min bars) ────────────────────────────────

export interface IntradayBar {
  /** Bar start (epoch ms). */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type OutcomeStatus = 'NOT_TRIGGERED' | 'TARGET1' | 'STOP' | 'TIME_EXIT' | 'NO_DATA';

export interface SetupOutcome {
  status: OutcomeStatus;
  entryAt: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  r: number | null;
  hitT1: boolean | null;
  details: Record<string, unknown>;
}

const istMinute = (ts: number) => {
  const d = new Date(ts + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const istDay = (ts: number) => new Date(ts + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Replays the setup's rule on the session's 15-min bars: opening range = the 09:15 bar; entry on a
 * break of its high (long) / low (short) before 15:10; stop = stopDistance (1× daily ATR);
 * T1 = 1.5R. Within one bar a stop touch counts first (conservative).
 */
export function evaluateOutcome(
  setup: { side: SetupSide; atr: number; prevClose: number },
  session: string,
  bars: readonly IntradayBar[],
): SetupOutcome {
  const day = bars.filter((b) => istDay(b.ts) === session).sort((a, b) => a.ts - b.ts);
  const none = (why: string): SetupOutcome => ({ status: 'NO_DATA', entryAt: null, entryPrice: null, exitPrice: null, r: null, hitT1: null, details: { why } });
  const or = day.find((b) => istMinute(b.ts) === OPENING_RANGE_MIN);
  if (!or) return none('no 09:15 bar for the session');
  const long = setup.side === 'LONG';
  const sgn = long ? 1 : -1;
  const level = long ? or.high : or.low;
  const dist = stopDistance(setup.atr, or.high - or.low);
  const gapAtr = setup.atr > 0 ? round2(((or.open - setup.prevClose) / setup.atr) * sgn) : null;
  const details: Record<string, unknown> = { orHigh: or.high, orLow: or.low, stopDistance: round2(dist), gapAtr, gapAgainstSkip: gapAtr !== null && gapAtr < -GAP_SKIP_ATR };

  let entry: number | null = null;
  let entryAt: number | null = null;
  let stop = 0;
  let t1 = 0;
  let last: IntradayBar | null = null;
  for (const b of day) {
    if (b.ts <= or.ts || istMinute(b.ts) >= TIME_EXIT_MIN) continue;
    last = b;
    if (entry === null) {
      const broke = long ? b.high > level : b.low < level;
      if (!broke) continue;
      entry = long ? Math.max(level, b.open) : Math.min(level, b.open);
      entryAt = b.ts;
      stop = entry - sgn * dist;
      t1 = entry + sgn * TARGET1_R * dist;
    }
    const stopHit = long ? b.low <= stop : b.high >= stop;
    const t1Hit = long ? b.high >= t1 : b.low <= t1;
    if (stopHit) return done('STOP', stop, false);
    if (t1Hit) return done('TARGET1', t1, true);
  }
  if (entry === null) return { status: 'NOT_TRIGGERED', entryAt: null, entryPrice: null, exitPrice: null, r: null, hitT1: null, details };
  return done('TIME_EXIT', last!.close, false);

  function done(status: OutcomeStatus, exit: number, hit: boolean): SetupOutcome {
    const r = round2(((exit - (entry as number)) * sgn) / dist);
    return { status, entryAt, entryPrice: round2(entry as number), exitPrice: round2(exit), r, hitT1: hit, details: { ...details, stop: round2(stop), target1: round2(t1) } };
  }
}
