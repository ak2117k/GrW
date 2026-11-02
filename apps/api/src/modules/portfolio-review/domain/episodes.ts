import { triggerOf } from '../../sentinel-executor/domain/manual-exit';
import { estimateCharges, segmentFor } from '../../trade-sentinel/charges';
import {
  DAY_MS,
  baseCashSymbol,
  isCommodityExchange,
  isDerivativeExchange,
  istDay,
  istDayDiff,
  parseDerivativeSymbol,
  underlyingOf,
} from './symbols';
import type { ClosedBy, Episode, EpisodeBuild, ExitInput, OrderInput, ReviewSegment, TrackerInput } from './types';

/**
 * Tracker rows → real trades ("episodes").
 *
 * Why this exists: trade_trackers is a mirror of the broker book, not a trade
 * log. When a holding or position blinks out of the broker's response the poller
 * CLOSES the row (exit = last tick, pnl = mark-to-market at that moment) and
 * re-opens a fresh row when it reappears. Prod has ~12 rows per holding. Summing
 * `pnl` over CLOSED rows therefore counts the same unrealised loss many times.
 * An episode is a chain of rows on the same holding (by base symbol) or the same
 * contract at the same average price, re-opened within a short gap.
 */

export const EPISODE_RULES = {
  /** A holding row re-opened within this gap of the previous close is the same holding. */
  holdingRejoinMs: 5 * DAY_MS,
  /** A position row re-opened within this gap at the same average price is the same position. */
  positionRejoinMs: 20 * 60 * 60 * 1000,
  /** Same average price tolerance for positions (fraction). */
  samePriceTolerance: 0.001,
  /** Exit prices are the broker fill from this instant on (trade-tracker fix, 2026-11-02 IST). */
  brokerFillSince: Date.parse('2026-11-01T18:30:00.000Z'),
  /** A cash price below this fraction of cost flags a possible unadjusted split / bonus. */
  corporateActionRatio: 0.45,
} as const;

const round2 = (n: number) => Math.round(n * 100) / 100;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function reviewSegment(kind: string, exchange: string, symbol: string): ReviewSegment {
  if (kind === 'HOLDING') return 'CASH_HOLDING';
  if (isCommodityExchange(exchange)) return 'COMMODITY';
  if (isDerivativeExchange(exchange)) return parseDerivativeSymbol(symbol)?.type === 'FUT' ? 'FUTURES' : 'OPTIONS';
  return 'CASH_INTRADAY';
}

function groupKey(t: TrackerInput): string {
  return t.kind === 'HOLDING' ? `H:${baseCashSymbol(t.symbol)}` : `P:${t.exchange}:${t.token}`;
}

function canJoin(prev: TrackerInput, row: TrackerInput): boolean {
  if (prev.status !== 'CLOSED' || !prev.exitTime) return false;
  const gap = row.entryTime.getTime() - prev.exitTime.getTime();
  if (prev.kind === 'HOLDING') return gap <= EPISODE_RULES.holdingRejoinMs;
  if (Math.sign(prev.qty) !== Math.sign(row.qty)) return false;
  const samePrice = Math.abs(row.entryPrice - prev.entryPrice) <= EPISODE_RULES.samePriceTolerance * prev.entryPrice;
  return samePrice && gap <= EPISODE_RULES.positionRejoinMs;
}

function charges(t: TrackerInput, entry: number, exit: number, qty: number, side: 'LONG' | 'SHORT'): number {
  if (!(qty > 0) || !(entry > 0) || !(exit >= 0)) return 0;
  return estimateCharges({ segment: segmentFor(t), entryPrice: entry, exitPrice: exit, qty, side });
}

/** Who closed it, from the app's exit row: man_ = the owner's Exit button, trg_ = a price trigger, else the AI. */
export function closedByOf(exit: ExitInput | undefined): ClosedBy | null {
  if (!exit) return null;
  const t = triggerOf(exit.verdictId);
  return t === 'MANUAL' ? 'MANUAL_IN_APP' : t === 'PRICE_TRIGGER' ? 'PRICE_TRIGGER' : 'AI_EXIT';
}

/** Build the de-duplicated trade list. Pure. */
export function buildEpisodes(
  trackers: TrackerInput[],
  exits: ExitInput[],
  orders: OrderInput[],
  now: Date,
): EpisodeBuild {
  const invalid = { rows: 0, claimedPnl: 0, symbols: [] as string[] };
  const churn = { rows: 0, claimedPnl: 0 };
  const valid: TrackerInput[] = [];
  for (const t of trackers) {
    if (!finite(t.entryPrice) || t.entryPrice <= 0 || !finite(t.qty) || t.qty === 0) {
      invalid.rows += 1;
      invalid.claimedPnl += Number(t.pnl ?? 0) || 0;
      if (!invalid.symbols.includes(t.symbol)) invalid.symbols.push(t.symbol);
      continue;
    }
    valid.push(t);
  }

  // Latest live exit per tracker (FILLED beats PLACED).
  const exitByTracker = new Map<string, ExitInput>();
  for (const e of [...exits].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const prev = exitByTracker.get(e.trackerId);
    if (!prev || e.status === 'FILLED' || prev.status !== 'FILLED') exitByTracker.set(e.trackerId, e);
  }

  const groups = new Map<string, TrackerInput[]>();
  for (const t of valid) {
    const k = groupKey(t);
    const g = groups.get(k) ?? [];
    g.push(t);
    groups.set(k, g);
  }

  const trackedSince = valid.reduce<number>((m, t) => Math.min(m, t.entryTime.getTime()), Number.POSITIVE_INFINITY);
  const episodes: Episode[] = [];

  for (const [key, rows] of groups) {
    rows.sort((a, b) => a.entryTime.getTime() - b.entryTime.getTime());
    const chains: TrackerInput[][] = [];
    for (const r of rows) {
      const cur = chains[chains.length - 1];
      if (cur && canJoin(cur[cur.length - 1], r)) cur.push(r);
      else chains.push([r]);
    }
    chains.forEach((chain, i) => episodes.push(episodeOf(`${key}#${i}`, chain, exitByTracker, orders, trackedSince, churn)));
  }

  // Cash POSITION rows on a stock that is also a holding at that time are the holding's
  // buy / sell legs (a CNC buy that settles into the demat, a sale of held shares). Their
  // effect shows up in the holding episode, so they are not separate trades.
  const holdings = episodes.filter((e) => e.kind === 'HOLDING');
  let holdingLegs = 0;
  for (const e of episodes) {
    if (e.segment !== 'CASH_INTRADAY') continue;
    const at = Date.parse(e.firstEntry);
    const leg = holdings.some(
      (h) =>
        h.underlying === e.underlying &&
        at >= Date.parse(h.firstEntry) - DAY_MS &&
        at <= (h.exitTime ? Date.parse(h.exitTime) : now.getTime()) + 3 * DAY_MS,
    );
    if (leg) {
      e.role = 'HOLDING_LEG';
      holdingLegs += 1;
    }
  }

  invalid.claimedPnl = round2(invalid.claimedPnl);
  churn.claimedPnl = round2(churn.claimedPnl);
  episodes.sort((a, b) => Date.parse(a.firstEntry) - Date.parse(b.firstEntry));
  return { episodes, invalid, churn, holdingLegs };
}

function episodeOf(
  key: string,
  rows: TrackerInput[],
  exitByTracker: Map<string, ExitInput>,
  orders: OrderInput[],
  trackedSince: number,
  churn: { rows: number; claimedPnl: number },
): Episode {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const side: 'LONG' | 'SHORT' = last.qty < 0 ? 'SHORT' : 'LONG';
  const sign = side === 'LONG' ? 1 : -1;
  const segment = reviewSegment(last.kind, last.exchange, last.symbol);
  const flags: string[] = [];

  let realisedGross = 0;
  let chargeSum = 0;
  let adds = 0;
  let averagedDown = false;
  let partialExits = 0;
  let partialQty = 0;
  let lastPartialAt: Date | null = null;

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const r = rows[i];
    const dq = Math.abs(prev.qty) - Math.abs(r.qty);
    const mark = prev.exitPrice ?? prev.lastLtp ?? null;
    if (dq > 0 && mark !== null) {
      realisedGross += (mark - prev.entryPrice) * dq * sign;
      chargeSum += charges(prev, prev.entryPrice, mark, dq, side);
      partialExits += 1;
      partialQty += dq;
      lastPartialAt = prev.exitTime;
    } else if (dq < 0) {
      adds += 1;
      if (mark !== null && (side === 'LONG' ? mark < prev.entryPrice : mark > prev.entryPrice)) averagedDown = true;
    }
  }
  for (const r of rows.slice(0, -1)) {
    churn.rows += 1;
    churn.claimedPnl += Number(r.pnl ?? 0) || 0;
  }

  const status: 'OPEN' | 'CLOSED' = last.status === 'CLOSED' ? 'CLOSED' : 'OPEN';
  let exitPrice: number | null = null;
  let exitPriceSource: Episode['exitPriceSource'] = null;
  let unrealised = 0;
  let closedBy: ClosedBy | null = null;
  const exit = exitByTracker.get(last.id);
  const parsed = isDerivativeExchange(last.exchange) ? parseDerivativeSymbol(last.symbol) : null;

  if (status === 'CLOSED') {
    if (exit && exit.status === 'FILLED' && finite(exit.fillPrice) && exit.fillPrice > 0) {
      exitPrice = exit.fillPrice;
      exitPriceSource = 'APP_FILL';
    } else if (finite(last.exitPrice)) {
      exitPrice = last.exitPrice;
      exitPriceSource = last.exitTime && last.exitTime.getTime() >= EPISODE_RULES.brokerFillSince ? 'BROKER_FILL' : 'LAST_TICK';
    } else if (finite(last.pnl)) {
      exitPrice = last.entryPrice + last.pnl / last.qty;
      exitPriceSource = 'LAST_TICK';
    }
    if (exitPrice !== null) {
      realisedGross += (exitPrice - last.entryPrice) * last.qty;
      chargeSum += charges(last, last.entryPrice, exitPrice, Math.abs(last.qty), side);
    }
    const viaApp = closedByOf(exit);
    if (viaApp) closedBy = viaApp;
    else if (parsed && last.exitTime && istDay(last.exitTime) >= parsed.expiry) closedBy = 'EXPIRY';
    else closedBy = 'AT_BROKER';
    if (exitPriceSource === 'LAST_TICK') flags.push('LAST_TICK_EXIT');
  } else {
    const ltp = finite(last.lastLtp) && last.lastLtp > 0 ? last.lastLtp : null;
    unrealised = ltp !== null ? (ltp - last.entryPrice) * last.qty : Number(last.pnl ?? 0) || 0;
  }

  const ltp = finite(last.lastLtp) && last.lastLtp > 0 ? last.lastLtp : null;
  const refPrice = status === 'CLOSED' ? exitPrice : ltp;
  if (segment === 'CASH_HOLDING' || segment === 'CASH_INTRADAY') {
    if (refPrice !== null && refPrice / last.entryPrice < EPISODE_RULES.corporateActionRatio) flags.push('POSSIBLE_CORPORATE_ACTION');
  }
  if (last.kind === 'HOLDING' && first.entryTime.getTime() - trackedSince < 2 * DAY_MS) flags.push('HELD_BEFORE_TRACKING');

  const highs = rows.map((r) => r.holdingHigh).filter(finite);
  const lows = rows.map((r) => r.holdingLow).filter(finite);
  const entryNotional = Math.max(...rows.map((r) => Math.abs(r.entryPrice * r.qty)));
  const maxQty = Math.max(...rows.map((r) => Math.abs(r.qty)));
  const exitAt = status === 'CLOSED' ? last.exitTime : null;

  const from = first.entryTime.getTime() - DAY_MS;
  const to = exitAt ? exitAt.getTime() : Number.POSITIVE_INFINITY;
  const order = orders.find((o) => o.token !== null && String(o.token) === String(last.token) && o.at.getTime() >= from && o.at.getTime() <= to);


  return {
    key,
    rowIds: rows.map((r) => r.id),
    symbol: last.symbol,
    underlying: underlyingOf(last.symbol),
    exchange: last.exchange,
    token: last.token,
    kind: last.kind === 'HOLDING' ? 'HOLDING' : 'POSITION',
    segment,
    side,
    status,
    qty: Math.abs(last.qty),
    entryPrice: last.entryPrice,
    firstEntry: first.entryTime.toISOString(),
    exitTime: exitAt ? exitAt.toISOString() : null,
    exitPrice: exitPrice !== null ? round2(exitPrice) : null,
    exitPriceSource,
    ltp,
    realisedGross: round2(realisedGross),
    unrealised: round2(unrealised),
    charges: round2(chargeSum),
    holdingHigh: highs.length ? Math.max(...highs) : null,
    holdingLow: lows.length ? Math.min(...lows) : null,
    entryNotional: round2(entryNotional),
    maxQty,
    adds,
    averagedDown,
    partialExits,
    partialQty,
    lastPartialAt: lastPartialAt ? lastPartialAt.toISOString() : null,
    closedBy,
    openedBy: order ? (String(order.source ?? '').toUpperCase() === 'MANUAL' ? 'MANUAL' : 'MODEL') : 'MANUAL',
    derivative: parsed
      ? {
          type: parsed.type,
          expiry: parsed.expiry,
          strike: parsed.strike,
          dteAtEntry: istDayDiff(istDay(first.entryTime), parsed.expiry),
          premiumPctOfStrike: parsed.type !== 'FUT' && parsed.strike ? round2((first.entryPrice / parsed.strike) * 100) : null,
        }
      : null,
    role: 'TRADE',
    flags,
  };
}
