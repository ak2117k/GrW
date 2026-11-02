import { actionPlanDigest } from './action-plan';
import { computePatterns } from './behaviour';
import { buildEpisodes } from './episodes';
import { holdingChecks } from './holdings';
import { computeBreakdowns, computeHeadline, toClosedTrades } from './metrics';
import { buildSuggestions } from './suggestions';
import type { ExitInput, HoldingTrend, LlmSummary, OrderInput, PortfolioReview, TrackerInput } from './types';

const inr = (n: number) => `${n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

export const CHARGES_METHOD =
  'Estimated with the app charge model (trade-sentinel/charges.ts: Angel One / NSE rates, delivery vs intraday vs F&O; ' +
  'MCX priced on the NSE F&O schedule) per closed round trip — not reconciled to contract notes. Open positions are shown gross.';

export interface ReviewInputs {
  userId: string;
  trackers: TrackerInput[];
  exits: ExitInput[];
  orders: OrderInput[];
  trends: Map<string, HoldingTrend>;
  now: Date;
}

/** The whole deterministic review. Pure: same inputs → same report (summary left SKIPPED). */
export function buildPortfolioReview(input: ReviewInputs): PortfolioReview {
  const built = buildEpisodes(input.trackers, input.exits, input.orders, input.now);
  const trades = toClosedTrades(built.episodes);
  const headline = computeHeadline(trades, built.episodes);
  const breakdowns = computeBreakdowns(trades);
  const holdings = holdingChecks(built.episodes, input.trends, input.now);
  const patterns = computePatterns(trades, built.episodes, holdings);
  const suggestions = buildSuggestions(breakdowns, patterns, holdings);

  const lastTick = trades.filter((t) => t.exitPriceSource === 'LAST_TICK').length;
  const fills = trades.filter((t) => t.exitPriceSource === 'APP_FILL' || t.exitPriceSource === 'BROKER_FILL').length;
  const corp = built.episodes.filter((e) => e.flags.includes('POSSIBLE_CORPORATE_ACTION')).map((e) => e.symbol);
  const noTrend = holdings.filter((h) => h.trend.status === 'NO_DATA').length;

  const notes: string[] = [];
  if (headline.trackedSince) notes.push(`History starts ${headline.trackedSince}, when the app began tracking the broker book; anything bought or sold before that is not in these numbers, and holdings bought earlier show "days held" from that date.`);
  if (lastTick) notes.push(`${lastTick} of ${trades.length} realised trades use the last tick the app saw as the exit price (before 2026-11-02 the tracker did not store the broker fill) — treat those P&Ls as approximate.`);
  if (built.churn.rows) notes.push(`${built.churn.rows} tracker rows were closed and re-opened for the same holding/position (broker-book blinks); they were merged — their closes claimed ${inr(built.churn.claimedPnl)} that was never realised.`);
  if (built.invalid.rows) notes.push(`${built.invalid.rows} tracker rows had no average price (entry 0) and were excluded; they claimed ${inr(built.invalid.claimedPnl)} of P&L (${built.invalid.symbols.slice(0, 5).join(', ')}).`);
  if (built.holdingLegs) notes.push(`${built.holdingLegs} cash positions were buys/sells of a stock you also hold; they are counted inside the holding, not as separate trades.`);
  if (corp.length) notes.push(`Possible split/bonus not adjusted in the average price (price < 45% of cost): ${[...new Set(corp)].join(', ')} — check these against the broker.`);
  if (noTrend) notes.push(`${noTrend} holdings have no daily-candle trend (broker history unavailable).`);
  notes.push('Paper trades are excluded. Opened-by is MANUAL unless a live app order matches the contract.');

  const review: PortfolioReview = {
    userId: input.userId,
    generatedAt: input.now.toISOString(),
    headline,
    breakdowns,
    patterns,
    holdings,
    suggestions,
    dataQuality: {
      notes,
      invalidRows: built.invalid.rows,
      invalidClaimedPnl: built.invalid.claimedPnl,
      churnRows: built.churn.rows,
      churnClaimedPnl: built.churn.claimedPnl,
      holdingLegs: built.holdingLegs,
      lastTickExits: lastTick,
      fillExits: fills,
      chargesMethod: CHARGES_METHOD,
    },
    digest: '',
    summary: { status: 'SKIPPED', text: null, reason: 'not requested' } as LlmSummary,
  };
  review.digest = portfolioReviewDigest(review);
  return review;
}

/**
 * One paragraph the AI advisor can read (plain text, no markup), including the
 * action plan when present. Exported for ai-assist; this module does not wire it in.
 */
export function portfolioReviewDigest(r: Pick<PortfolioReview, 'headline' | 'breakdowns' | 'suggestions' | 'holdings' | 'generatedAt'> & Partial<Pick<PortfolioReview, 'actionPlan'>>): string {
  const h = r.headline;
  const worstSeg = r.breakdowns.bySegment[0];
  const worstUnd = r.breakdowns.byUnderlying[0];
  const dead = r.holdings.filter((x) => x.tags.includes('DEAD-MONEY')).length;
  const top = r.suggestions.slice(0, 3).map((s) => s.title).join('; ');
  return [
    `Portfolio review (${r.generatedAt.slice(0, 10)}, real broker book since ${h.trackedSince ?? 'n/a'}, paper excluded):`,
    `realised ${inr(h.realisedNet)} net after ~${inr(h.charges)} charges over ${h.trades} trades (win rate ${h.winRate}%, avg win ${inr(h.avgWin)} vs avg loss ${inr(h.avgLoss)}, profit factor ${h.profitFactor ?? 'n/a'});`,
    `unrealised ${inr(h.unrealised)} (${h.openHoldings} holdings ${inr(h.unrealisedHoldings)} on ${inr(h.holdingsCost)} cost);`,
    `total ${inr(h.total)}.`,
    worstSeg ? `Worst segment ${worstSeg.key} ${inr(worstSeg.net)} (${worstSeg.trades} trades).` : '',
    worstUnd ? `Worst underlying ${worstUnd.key} ${inr(worstUnd.net)}.` : '',
    dead ? `${dead} dead holdings (≤ −20% after 60+ days).` : '',
    top ? `Top suggestions: ${top}.` : '',
    r.actionPlan ? actionPlanDigest(r.actionPlan) : '',
  ]
    .filter(Boolean)
    .join(' ');
}
