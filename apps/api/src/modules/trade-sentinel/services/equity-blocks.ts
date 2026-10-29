import type { Segment, Side } from '../charges';
import type { NoiseReading } from '../../exit-discipline/types';
import type { SessionClock } from '../../market-hub/session-clock';
import { istAt, istYmd } from '../../market-cues/fetchers/ist-dates';
import { addDaysYmd } from '../../news-events/events/zoned-time';
import type { Block } from './context-packet.service';
import { NO_EVENTS_PREFIX, type EventsBlocksV2 } from './news-events-blocks';
import type { StockMoveValue } from './market-behaviour-block';

/**
 * The `equity` packet block (spec docs/superpowers/specs/2026-10-29-equity-sentinel-factors.md §4):
 * exit context for a CASH-EQUITY position, built only for EQ_INTRADAY / EQ_DELIVERY so every F&O
 * packet stays byte-identical. PURE — no I/O and no clock of its own: the packet service passes
 * every input, including `now` and the session clock.
 *
 * Owner rule (2026-10-29): "same logic as futures; equity just has lower volatility". So nothing
 * here forecasts direction (prior research: a coin flip). Each factor answers one EXIT question —
 * is this move noise or a regime change (sized in noise units N and in daily ATR), is there a hard
 * deadline, is this the stock or the market — and every distance is in the stock's OWN units, so
 * a quiet large cap and a wild small cap read on one scale.
 *
 * Signs are POSITION-RELATIVE wherever the spec says so: positive = in the position's favour
 * (LONG: up, SHORT: down), so the judge never flips a sign. A missing input is never a 0: a block
 * is absent with the reason, and a missing sub-reading is null with its reason in `unseen`.
 */

/** One tick-source input: a reading with its provenance, or the reason there is none. */
export type EquityLeg<T> = ({ ok: true; at: string; source: string } & T) | { ok: false; reason: string };

/**
 * What the TICK SOURCE reads for the equity block (synchronous peeks and one cached DB read —
 * never a broker call). Carried on the tick for cash positions only; absent for F&O.
 */
export type EquityTickInputs = {
  /** The stock's own day bar: `prevClose` is the PREVIOUS session's close; `open` today's open. */
  day: EquityLeg<{ open: number | null; prevClose: number }>;
  /** NIFTY now, with its previous close when the source reports one. */
  nifty: EquityLeg<{ ltp: number; prevClose: number | null }>;
  /** The close of NIFTY's hub 1-minute bar containing the position's entry time. */
  niftyAtEntry: EquityLeg<{ close: number }>;
};

/**
 * Angel One auto-squares intraday (MIS) equity at 15:15 IST (F&O 15:20, currency 16:45) —
 * https://www.angelone.in/support/your-orders/square-off. Env SENTINEL_EQ_SQUAREOFF_IST overrides.
 */
export const SQUARE_OFF_DEFAULT_MIN_IST = 15 * 60 + 15;

/** 'HH:MM' inside the equity session (09:15–15:30), else the 15:15 default. Never throws. */
export function parseSquareOffIst(raw: string | null | undefined): number {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(raw ?? ''));
  if (!m) return SQUARE_OFF_DEFAULT_MIN_IST;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && min > 9 * 60 + 15 && min <= 15 * 60 + 30 ? min : SQUARE_OFF_DEFAULT_MIN_IST;
}

/** The NSE equity session length the daily ATR is scaled by (09:15–15:30). */
export const EQUITY_SESSION_MINUTES = 375;

/**
 * Day-range regime cut-offs, in multiples of the DAILY ATR14. 1.2 / 1.8 straddle the 1.5 × ATR
 * "big move" definition the stock-move spike validated walk-forward (memory: stock daily model
 * spike, AUC 0.670 for a > 1.5 × ATR move); 0.5 is half a normal day.
 */
export const RANGE_QUIET_ATR = 0.5;
export const RANGE_NORMAL_ATR = 1.2;
export const RANGE_EXPANDED_ATR = 1.8;

/**
 * Relative-strength labels. MARKET-DRIVEN: NIFTY's move since entry has the stock's sign and is
 * 0.7–1.43× its size (the market "explains" ≥ 70 % of it, and the stock did not resist a much
 * bigger market move — that resistance IS stock-specific). STOCK-SPECIFIC: the stock-minus-NIFTY
 * gap is ≥ 0.5 daily ATR. NO-MOVE: the stock has moved < 0.1 ATRd, so there is nothing to attribute.
 */
export const RS_MARKET_SHARE = 0.7;
export const RS_STOCK_SPECIFIC_ATR = 0.5;
export const RS_NO_MOVE_ATR = 0.1;

/** How far ahead F7 looks: today and the next two trading days. */
export const EVENT_HORIZON_TRADING_DAYS = 3;

export type DayRangeRegime = 'QUIET' | 'NORMAL' | 'EXPANDED' | 'BIG-MOVE DAY';
export type RsLabel = 'MARKET-DRIVEN' | 'STOCK-SPECIFIC' | 'MIXED' | 'NO-MOVE';
export type EventClass =
  | 'TODAY-BEFORE-SQUAREOFF'
  | 'TODAY-AFTER-SQUAREOFF'
  | 'TODAY-AFTER-CLOSE'
  | 'TODAY-TIME-NOT-ANNOUNCED'
  | 'NEXT-SESSION'
  | 'LATER'
  | 'NONE';

// `type`, never `interface`: the packet is written to a jsonb column and a declared interface does
// not assign to Prisma.InputJsonValue (see the note on ContextPacket).
export type VwapValue = {
  vwap: number;
  /** ltp − vwap in rupees, position-relative. */
  gapRupees: number;
  /** The same gap in noise units N; negative = the position is on the wrong side of VWAP. */
  gapN: number;
  basis: string;
};

export type DayRangeValue = {
  atrDaily: number;
  /** (todayHigh − todayLow) / daily ATR. */
  rangeUsedAtr: number;
  regime: DayRangeRegime;
  /** (open − prevClose) / daily ATR, signed by the MARKET (a fact about the day, not the trade). */
  gapAtr: number | null;
  /** (ltp − entry) / daily ATR, position-relative. */
  fromEntryAtr: number;
  /** How far ltp sits off the best price since entry, in N (≥ 0). */
  pullbackFromPeakN: number | null;
  unseen?: string[];
};

export type RsLegValue = { stockPct: number; niftyPct: number; rsAtr: number | null };
export type RsValue = {
  sinceEntry: (RsLegValue & { label: RsLabel | null }) | null;
  today: RsLegValue | null;
  unseen?: string[];
};

export type EventRiskValue = {
  when: EventClass;
  event: string | null;
  atIst: string | null;
};

export type EquityBlock = {
  squareOff: Block<number>;
  priceBand: Block<never>;
  vwap: Block<VwapValue>;
  dayRange: Block<DayRangeValue>;
  relativeStrength: Block<RsValue>;
  relativeVolume: Block<never>;
  eventRisk: Block<EventRiskValue>;
};

export interface EquityBlockInput {
  segment: Segment;
  side: Side;
  exchange: string;
  symbol: string;
  ltp: number;
  entryPrice: number;
  /** The best price since entry (money.mfe), or null when none is recorded. */
  peak: number | null;
  /** structure.levelBook as the packet carries it. */
  levelBook: Block<unknown>;
  /** The tick's contract noise unit (T1: for cash it falls back to the daily ATR in the tick source). */
  noise: NoiseReading | null;
  inputs: EquityTickInputs | null | undefined;
  /** The v2 events blocks, or null when NEWS_EVENTS_V2_ENABLED is not true. */
  events: EventsBlocksV2 | null;
  /** The stock-move reading as rendered, or null; `stockMoveShown` false ⇒ the gate hides it. */
  stockMove: StockMoveValue | null;
  stockMoveShown: boolean;
  now: Date;
  clock: Pick<SessionClock, 'isTradingDay' | 'tradingWindow'>;
  squareOffMin: number;
}

const ok = <T>(value: T, source: string, at: string): Block<T> => ({ available: true, value, source, at });
const no = (reason: string): Block<never> => ({ available: false, reason });
const pos = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istMinutes = (d: Date) => {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
};
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function isCashSegment(segment: Segment): boolean {
  return segment === 'EQ_INTRADAY' || segment === 'EQ_DELIVERY';
}

/** The level-book numbers the factors read; each null when not a positive finite number. */
function bookNumbers(levelBook: Block<unknown>) {
  const v = levelBook.available ? ((levelBook.value ?? {}) as Record<string, unknown>) : null;
  const n = (k: string) => (v && pos(v[k]) ? (v[k] as number) : null);
  return { book: v, vwap: n('vwap'), todayHigh: n('todayHigh'), todayLow: n('todayLow'), atr14: n('atr14') };
}

/** N for this stock: the tick's noise unit, else the level book's daily ATR14 / √375. */
function noiseUnit(noise: NoiseReading | null, atr14: number | null): { n: number; basis: string } | null {
  if (noise && pos(noise.n)) {
    return {
      n: noise.n,
      basis: noise.method === 'atr14-daily-scaled' ? 'daily ATR14 / √375 (no hub 1-minute bars)' : `${noise.method} over ${noise.bars} hub 1-minute bars`,
    };
  }
  return atr14 !== null ? { n: atr14 / Math.sqrt(EQUITY_SESSION_MINUTES), basis: 'daily ATR14 / √375 (no tick noise unit)' } : null;
}

const NO_BOOK = "no level book for this stock, so today's range, VWAP and the daily ATR are unseen";

/** F1. Minutes to the broker's MIS auto square-off. */
export function squareOffBlock(
  segment: Segment,
  exchange: string,
  now: Date,
  clock: EquityBlockInput['clock'],
  squareOffMin: number,
): Block<number> {
  if (segment === 'EQ_DELIVERY') {
    return no('delivery (CNC) holding: there is no broker square-off; the position may be carried overnight');
  }
  if (!clock.isTradingDay(exchange, now)) return no(`not a trading day for ${exchange} — no square-off today`);
  const window = clock.tradingWindow(exchange, now) ?? { openMin: 9 * 60 + 15, closeMin: 15 * 60 + 30 };
  const nowMin = istMinutes(now);
  if (nowMin < window.openMin) {
    return no(
      `before the open (${hhmm(window.openMin)} IST): the full session is ahead; the broker squares off MIS equity at ${hhmm(squareOffMin)} IST`,
    );
  }
  if (nowMin >= squareOffMin) {
    return no(`past ${hhmm(squareOffMin)} IST: the broker has already squared off (or is squaring off) an MIS position`);
  }
  return ok(
    squareOffMin - nowMin,
    `IST wall clock: Angel auto-squares MIS equity at ${hhmm(squareOffMin)} IST; ${exchange} closes ${hhmm(window.closeMin)}. ` +
      'Assumed MIS (intraday): trade_trackers carries no product type, and a CNC position is not squared off',
    now.toISOString(),
  );
}

/** F3. Distance from the level book's VWAP, in N, position-relative. */
export function vwapBlock(i: EquityBlockInput, at: string): Block<VwapValue> {
  const b = bookNumbers(i.levelBook);
  if (!b.book) return no(`no VWAP: ${NO_BOOK}`);
  if (b.vwap === null) return no('no VWAP: the level book carries no positive VWAP yet (no bar traded today)');
  const dir = i.side === 'LONG' ? 1 : -1;
  const gap = (i.ltp - b.vwap) * dir;
  const unit = noiseUnit(i.noise, b.atr14);
  if (!unit) {
    return no(
      `no noise unit (no 1-minute bars and no daily ATR), so the VWAP gap cannot be sized: price is ₹${r2(gap)} on the position's side of VWAP ${r2(b.vwap)}`,
    );
  }
  return ok(
    { vwap: r2(b.vwap), gapRupees: r2(gap), gapN: r1(gap / unit.n), basis: 'level book VWAP (15m candles)' },
    `level book VWAP; N = ${unit.basis}`,
    i.levelBook.available ? i.levelBook.at : at,
  );
}

/** F4. Today's range against the stock's normal day, plus the trade's own move. */
export function dayRangeBlock(i: EquityBlockInput, at: string): Block<DayRangeValue> {
  const b = bookNumbers(i.levelBook);
  if (!b.book) return no(NO_BOOK);
  if (b.atr14 === null) return no('the level book carries no positive daily ATR14, so the day cannot be sized');
  if (b.todayHigh === null || b.todayLow === null || b.todayHigh < b.todayLow) {
    return no("the level book has no valid high/low for today yet, so today's range is unseen");
  }
  const atr = b.atr14;
  const dir = i.side === 'LONG' ? 1 : -1;
  const used = (b.todayHigh - b.todayLow) / atr;
  const unseen: string[] = [];

  let gapAtr: number | null = null;
  const day = i.inputs?.day;
  if (!day) unseen.push("gapAtr: the stock's day bar was not read");
  else if (!day.ok) unseen.push(`gapAtr: ${day.reason}`);
  else if (!pos(day.open)) unseen.push(`gapAtr: ${day.source} carried no open`);
  else gapAtr = r2((day.open - day.prevClose) / atr);

  let pullbackFromPeakN: number | null = null;
  const unit = noiseUnit(i.noise, atr);
  if (!pos(i.peak)) unseen.push('pullbackFromPeakN: no best price recorded since entry');
  else if (!unit) unseen.push('pullbackFromPeakN: no noise unit');
  else pullbackFromPeakN = r1(Math.max(0, (i.peak - i.ltp) * dir) / unit.n);

  const value: DayRangeValue = {
    atrDaily: r2(atr),
    rangeUsedAtr: r2(used),
    regime: used < RANGE_QUIET_ATR ? 'QUIET' : used < RANGE_NORMAL_ATR ? 'NORMAL' : used < RANGE_EXPANDED_ATR ? 'EXPANDED' : 'BIG-MOVE DAY',
    gapAtr,
    fromEntryAtr: r2(((i.ltp - i.entryPrice) * dir) / atr),
    pullbackFromPeakN,
    ...(unseen.length ? { unseen } : {}),
  };
  return ok(
    value,
    `level book (today's high/low, DAILY ATR14)${day && day.ok ? `; gap from ${day.source}` : ''}${unit ? `; N = ${unit.basis}` : ''}`,
    i.levelBook.available ? i.levelBook.at : at,
  );
}

function rsLabel(stockF: number, niftyF: number, rsAtr: number, atrFrac: number): RsLabel {
  if (Math.abs(stockF) < RS_NO_MOVE_ATR * atrFrac) return 'NO-MOVE';
  const share = niftyF / stockF;
  if (share >= RS_MARKET_SHARE && share <= 1 / RS_MARKET_SHARE) return 'MARKET-DRIVEN';
  return Math.abs(rsAtr) >= RS_STOCK_SPECIFIC_ATR ? 'STOCK-SPECIFIC' : 'MIXED';
}

/** F5. The stock against NIFTY (beta-unadjusted), today and since entry. */
export function relativeStrengthBlock(i: EquityBlockInput, at: string): Block<RsValue> {
  const nifty = i.inputs?.nifty;
  if (!nifty) return no('NIFTY was not read for this position — market vs stock cannot be separated');
  if (!nifty.ok) return no(`no fresh NIFTY price (${nifty.reason}) — market vs stock cannot be separated`);
  const dir = i.side === 'LONG' ? 1 : -1;
  const { atr14 } = bookNumbers(i.levelBook);
  const day = i.inputs?.day;
  const prevClose = day && day.ok ? day.prevClose : null;
  // The stock's daily ATR as a fraction of price: on prevClose per the spec, else on ltp (stated).
  const atrFrac = atr14 !== null ? atr14 / (prevClose ?? i.ltp) : null;
  const unseen: string[] = [];
  if (atrFrac === null) unseen.push('rsAtr and label: no daily ATR on the level book, so the gap cannot be sized');

  let today: RsLegValue | null = null;
  if (!day) unseen.push("today: the stock's day bar was not read");
  else if (!day.ok) unseen.push(`today: ${day.reason}`);
  else if (!pos(nifty.prevClose)) unseen.push(`today: ${nifty.source} carried no NIFTY previous close`);
  else {
    const sF = (i.ltp - day.prevClose) / day.prevClose;
    const nF = (nifty.ltp - nifty.prevClose) / nifty.prevClose;
    today = { stockPct: r2(sF * 100), niftyPct: r2(nF * 100), rsAtr: atrFrac !== null ? r2((sF - nF) / atrFrac) : null };
  }

  let sinceEntry: RsValue['sinceEntry'] = null;
  const anchor = i.inputs?.niftyAtEntry;
  if (!anchor) unseen.push('sinceEntry: NIFTY at entry was not read');
  else if (!anchor.ok) unseen.push(`sinceEntry: ${anchor.reason}`);
  else {
    const sF = (i.ltp - i.entryPrice) / i.entryPrice;
    const nF = (nifty.ltp - anchor.close) / anchor.close;
    const rs = atrFrac !== null ? ((sF - nF) * dir) / atrFrac : null;
    sinceEntry = {
      stockPct: r2(sF * 100),
      niftyPct: r2(nF * 100),
      rsAtr: rs !== null ? r2(rs) : null,
      label: rs !== null && atrFrac !== null ? rsLabel(sF, nF, rs, atrFrac) : null,
    };
  }
  unseen.push('sector: no sector index is read (it would need its own hub live slot)');

  if (!today && !sinceEntry) return no(`NIFTY is priced but neither leg could be built: ${unseen.join('; ')}`);
  return ok(
    { sinceEntry, today, unseen },
    `beta-unadjusted, in the stock's daily ATR; NIFTY from ${nifty.source}` +
      (anchor && anchor.ok ? `; NIFTY at entry from ${anchor.source}` : '') +
      (day && day.ok ? `; stock previous close from ${day.source}` : ''),
    nifty.at ?? at,
  );
}

type Candidate = { startMs: number; allDay: boolean; event: string; atIst: string };

function classify(c: Candidate, i: EquityBlockInput): EventClass {
  const today = istYmd(i.now);
  const day = istYmd(new Date(c.startMs));
  if (day === today) {
    if (c.allDay) return 'TODAY-TIME-NOT-ANNOUNCED';
    const m = istMinutes(new Date(c.startMs));
    const close = i.clock.tradingWindow(i.exchange, i.now)?.closeMin ?? 15 * 60 + 30;
    return m < i.squareOffMin ? 'TODAY-BEFORE-SQUAREOFF' : m >= close ? 'TODAY-AFTER-CLOSE' : 'TODAY-AFTER-SQUAREOFF';
  }
  for (let d = 1; d <= 14; d++) {
    const next = addDaysYmd(today, d);
    if (i.clock.isTradingDay(i.exchange, istAt(next, 12))) return day === next ? 'NEXT-SESSION' : 'LATER';
  }
  return 'LATER';
}

/** End (IST 23:59:59.999) of the n-th trading day, counting today when it is one. */
function horizonEndMs(i: EquityBlockInput, n: number): number {
  const today = istYmd(i.now);
  let count = 0;
  for (let d = 0; d < 30; d++) {
    const day = addDaysYmd(today, d);
    if (i.clock.isTradingDay(i.exchange, istAt(day, 12)) && ++count === n) return istAt(day, 23, 59).getTime() + 59_999;
  }
  return i.now.getTime() + 7 * 86_400_000;
}

/** F7. The nearest company event from the events calendar and the stock-move book, both as rendered. */
export function eventRiskBlock(i: EquityBlockInput): Block<EventRiskValue> {
  const at = i.now.toISOString();
  const seen: string[] = [];
  const unseen: string[] = [];
  const cands: Candidate[] = [];
  const end = horizonEndMs(i, EVENT_HORIZON_TRADING_DAYS);

  if (!i.events) unseen.push('the events calendar is not rendered (NEWS_EVENTS_V2_ENABLED is not true)');
  else if (i.events.upcoming.available) {
    seen.push('events.upcoming');
    for (const e of i.events.upcoming.value as unknown as Array<Record<string, unknown>>) {
      if (e?.scope !== 'company') continue;
      const atIst = String(e.atIst ?? '');
      const allDay = atIst.endsWith('(time not announced)');
      const startMs = allDay ? istAt(atIst.slice(0, 10), 9, 15).getTime() : i.now.getTime() + Number(e.minutesAway) * 60_000;
      if (Number.isFinite(startMs)) cands.push({ startMs, allDay, event: String(e.title ?? e.kind ?? 'company event'), atIst });
    }
  } else if (i.events.upcoming.reason.startsWith(NO_EVENTS_PREFIX)) seen.push('events.upcoming (none scheduled)');
  else unseen.push(`the events calendar is unavailable: ${i.events.upcoming.reason}`);

  if (!i.stockMoveShown) unseen.push('the stock-move book is hidden (MBM_PACKET is not on)');
  else if (!i.stockMove) unseen.push('the stock-move book has no score for this stock');
  else {
    seen.push('stockMove.results');
    const ymd = i.stockMove.results;
    if (ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      cands.push({ startMs: istAt(ymd, 9, 15).getTime(), allDay: true, event: `${i.stockMove.s} results (stock-move book)`, atIst: `${ymd} (time not announced)` });
    }
  }

  if (seen.length === 0) return no(`${unseen.join(' and ')} — corporate events are UNSEEN, not none`);
  const source = `nearest company event in today and the next ${EVENT_HORIZON_TRADING_DAYS - 1} trading days, from ${seen.join(' + ')}` +
    (unseen.length ? `; not seen: ${unseen.join('; ')}` : '');
  const todayStart = istAt(istYmd(i.now), 0, 0).getTime();
  const near = cands.filter((c) => c.startMs <= end && c.startMs >= todayStart).sort((a, b) => a.startMs - b.startMs)[0];
  if (!near) return ok({ when: 'NONE', event: null, atIst: null }, source, at);
  return ok({ when: classify(near, i), event: near.event.slice(0, 160), atIst: near.atIst }, source, at);
}

export const PRICE_BAND_UNSEEN =
  "circuit limits are not captured for this position yet (the broker quote's band fields are not mapped) — the distance to a price band is UNSEEN, not far";
export const RELATIVE_VOLUME_UNSEEN =
  "no time-of-day volume baseline is built for this stock yet — participation against its normal is UNSEEN (flow.volumeRatio compares the last 15m bar with the previous 20 and reads opening bars as spikes)";

/** The whole `equity` block. Call it only for a cash segment. */
export function equityBlocks(i: EquityBlockInput): EquityBlock {
  const at = i.now.toISOString();
  return {
    squareOff: squareOffBlock(i.segment, i.exchange, i.now, i.clock, i.squareOffMin),
    priceBand: no(PRICE_BAND_UNSEEN),
    vwap: vwapBlock(i, at),
    dayRange: dayRangeBlock(i, at),
    relativeStrength: relativeStrengthBlock(i, at),
    relativeVolume: no(RELATIVE_VOLUME_UNSEEN),
    eventRisk: eventRiskBlock(i),
  };
}

/**
 * SENTINEL_EQUITY_BLOCK: on unless exactly `false`; OFF without a config (tests, a container
 * without ConfigModule) — the judge gate's delta rule. ONE parse, shared by the packet builder and
 * the prompt's `+e1` switch, so the prompt never describes a block the packet does not carry.
 */
export function equityBlockEnabled(config?: { get(key: string): unknown } | null): boolean {
  return !!config && String(config.get('SENTINEL_EQUITY_BLOCK') ?? '').trim().toLowerCase() !== 'false';
}

/** The `flow.oiWalls` reason for a cash position with the equity block on (spec §1: the old text was false). */
export const CASH_OI_WALLS_REASON =
  'OI walls are not captured for cash positions (the wall snapshot runs only for a contract with an expiry) — this says nothing about whether the stock has an options chain';
