import { DAY_MS, istDay, istMinutes, istMonth } from './symbols';
import type { Breakdowns, Bucket, ClosedTrade, Episode, Headline } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** IST entry-time buckets (the tracker sees a fill within one poll, ~10 min). */
export function entryTimeBucket(at: Date): string {
  const m = istMinutes(at);
  if (m < 9 * 60 + 15) return 'before 09:15';
  if (m < 10 * 60) return '09:15-10:00';
  if (m < 12 * 60) return '10:00-12:00';
  if (m < 14 * 60) return '12:00-14:00';
  if (m <= 15 * 60 + 30) return '14:00-15:30';
  return 'after 15:30 (MCX evening)';
}

export function holdingBucket(firstEntry: string, exitTime: string): ClosedTrade['holdingBucket'] {
  if (istDay(new Date(firstEntry)) === istDay(new Date(exitTime))) return 'INTRADAY';
  const days = (Date.parse(exitTime) - Date.parse(firstEntry)) / DAY_MS;
  return days <= 5 ? '1-5D' : '>5D';
}

/**
 * Realised trades: every CLOSED trade episode, plus the realised part of an
 * OPEN episode that was partly sold (so headline realised = sum of trades).
 */
export function toClosedTrades(episodes: Episode[]): ClosedTrade[] {
  const out: ClosedTrade[] = [];
  for (const e of episodes) {
    if (e.role !== 'TRADE') continue;
    let exitTime: string | null = null;
    let qtyClosed = e.qty;
    if (e.status === 'CLOSED' && e.exitTime) exitTime = e.exitTime;
    else if (e.status === 'OPEN' && e.partialExits > 0 && e.lastPartialAt) {
      exitTime = e.lastPartialAt;
      qtyClosed = e.partialQty;
    }
    if (!exitTime) continue;
    const gross = e.realisedGross;
    const net = round2(gross - e.charges);
    const notional = e.entryPrice * (e.status === 'CLOSED' ? e.qty + e.partialQty : qtyClosed);
    let peak: number | null = null;
    if (e.status === 'CLOSED') {
      if (e.side === 'LONG' && e.holdingHigh !== null) peak = (e.holdingHigh - e.entryPrice) * e.qty;
      if (e.side === 'SHORT' && e.holdingLow !== null) peak = (e.entryPrice - e.holdingLow) * e.qty;
    }
    out.push({
      ...e,
      exitTime,
      net,
      holdingDays: round1((Date.parse(exitTime) - Date.parse(e.firstEntry)) / DAY_MS),
      holdingBucket: holdingBucket(e.firstEntry, exitTime),
      entryHourBucket: entryTimeBucket(new Date(e.firstEntry)),
      returnPct: notional > 0 ? round2((gross / notional) * 100) : 0,
      peakOpenProfit: peak !== null ? round2(peak) : null,
      gaveBack: peak !== null && peak > 0 ? round2(Math.max(0, peak - gross)) : 0,
    });
  }
  return out.sort((a, b) => Date.parse(a.exitTime as string) - Date.parse(b.exitTime as string));
}

/** Aggregate trades into buckets by key. Sorted worst net first. */
export function bucketize(trades: ClosedTrade[], keyOf: (t: ClosedTrade) => string | null): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const t of trades) {
    const key = keyOf(t);
    if (key === null) continue;
    const b = map.get(key) ?? { key, trades: 0, wins: 0, losses: 0, gross: 0, charges: 0, net: 0, winRate: 0, avgNet: 0 };
    b.trades += 1;
    if (t.net > 0) b.wins += 1;
    else if (t.net < 0) b.losses += 1;
    b.gross += t.realisedGross;
    b.charges += t.charges;
    b.net += t.net;
    map.set(key, b);
  }
  return [...map.values()]
    .map((b) => ({
      ...b,
      gross: round2(b.gross),
      charges: round2(b.charges),
      net: round2(b.net),
      winRate: b.trades ? round1((b.wins / b.trades) * 100) : 0,
      avgNet: b.trades ? round2(b.net / b.trades) : 0,
    }))
    .sort((a, b) => a.net - b.net);
}

export function dteBucket(dte: number): string {
  if (dte <= 0) return '0 (expiry day)';
  if (dte <= 2) return '1-2 days';
  if (dte <= 7) return '3-7 days';
  if (dte <= 30) return '8-30 days';
  return '>30 days';
}

/** Premium as % of strike — a moneyness proxy (no spot at entry is stored). */
export function premiumBucket(pct: number): string {
  if (pct < 0.5) return 'premium <0.5% of strike (far OTM)';
  if (pct < 2) return 'premium 0.5-2% of strike (near OTM)';
  return 'premium >=2% of strike (ATM / ITM)';
}

const isOption = (t: ClosedTrade) => t.derivative !== null && t.derivative.type !== 'FUT';

export function computeBreakdowns(trades: ClosedTrade[]): Breakdowns {
  const positions = trades.filter((t) => t.kind === 'POSITION');
  const options = trades.filter(isOption);
  return {
    bySegment: bucketize(trades, (t) => t.segment),
    byUnderlying: bucketize(trades, (t) => t.underlying).slice(0, 15),
    byHoldingPeriod: bucketize(trades, (t) => t.holdingBucket),
    byClosedBy: bucketize(trades, (t) => t.closedBy ?? 'PARTIAL_SALE'),
    byOpenedBy: bucketize(trades, (t) => t.openedBy),
    byOptionDte: bucketize(options, (t) => dteBucket(t.derivative?.dteAtEntry ?? 0)),
    byOptionPremium: bucketize(options, (t) => (t.derivative?.premiumPctOfStrike != null ? premiumBucket(t.derivative.premiumPctOfStrike) : null)),
    byOptionType: bucketize(options, (t) => t.derivative?.type ?? null),
    byEntryTime: bucketize(positions, (t) => t.entryHourBucket),
  };
}

export function computeHeadline(trades: ClosedTrade[], episodes: Episode[]): Headline {
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net < 0);
  const sumWins = wins.reduce((s, t) => s + t.net, 0);
  const sumLosses = losses.reduce((s, t) => s + t.net, 0);
  const realisedGross = trades.reduce((s, t) => s + t.realisedGross, 0);
  const charges = trades.reduce((s, t) => s + t.charges, 0);
  const realisedNet = realisedGross - charges;
  const open = episodes.filter((e) => e.status === 'OPEN' && e.role === 'TRADE');
  const openHoldings = open.filter((e) => e.kind === 'HOLDING');
  const openPositions = open.filter((e) => e.kind === 'POSITION');
  const unrealisedHoldings = openHoldings.reduce((s, e) => s + e.unrealised, 0);
  const unrealisedPositions = openPositions.reduce((s, e) => s + e.unrealised, 0);

  const months = new Map<string, { trades: number; gross: number; charges: number; net: number }>();
  for (const t of trades) {
    const m = istMonth(new Date(t.exitTime as string));
    const row = months.get(m) ?? { trades: 0, gross: 0, charges: 0, net: 0 };
    row.trades += 1;
    row.gross += t.realisedGross;
    row.charges += t.charges;
    row.net += t.net;
    months.set(m, row);
  }

  const firstSeen = episodes.reduce<string | null>((m, e) => (m === null || e.firstEntry < m ? e.firstEntry : m), null);
  return {
    realisedGross: round2(realisedGross),
    charges: round2(charges),
    realisedNet: round2(realisedNet),
    unrealised: round2(unrealisedHoldings + unrealisedPositions),
    unrealisedHoldings: round2(unrealisedHoldings),
    unrealisedPositions: round2(unrealisedPositions),
    total: round2(realisedNet + unrealisedHoldings + unrealisedPositions),
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? round1((wins.length / trades.length) * 100) : 0,
    avgWin: wins.length ? round2(sumWins / wins.length) : 0,
    avgLoss: losses.length ? round2(sumLosses / losses.length) : 0,
    profitFactor: sumLosses < 0 ? round2(sumWins / Math.abs(sumLosses)) : null,
    expectancy: trades.length ? round2(realisedNet / trades.length) : 0,
    largestLosses: [...losses]
      .sort((a, b) => a.net - b.net)
      .slice(0, 5)
      .map((t) => ({ symbol: t.symbol, net: t.net, exitDay: istDay(new Date(t.exitTime as string)), segment: t.segment, closedBy: t.closedBy })),
    byMonth: [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, r]) => ({ month, trades: r.trades, gross: round2(r.gross), charges: round2(r.charges), net: round2(r.net) })),
    openHoldings: openHoldings.length,
    openPositions: openPositions.length,
    holdingsCost: round2(openHoldings.reduce((s, e) => s + e.entryPrice * e.qty, 0)),
    holdingsValue: round2(openHoldings.reduce((s, e) => s + (e.ltp ?? e.entryPrice) * e.qty, 0)),
    trackedSince: firstSeen ? istDay(new Date(firstSeen)) : null,
  };
}
