import type { Breakdowns, Bucket, HoldingCheck, Pattern, Suggestion } from './types';

const inr = (n: number) => `${n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

export const SUGGESTION_RULES = {
  /** A bucket must lose at least this much to be worth a suggestion. */
  minBucketLoss: 2_000,
  minBucketTrades: 3,
  maxSuggestions: 12,
  /** "risk at a further 10% move" for a concentrated holding. */
  concentrationShock: 0.1,
} as const;

type Draft = Omit<Suggestion, 'rank'>;

const SEGMENT_LABEL: Record<string, string> = {
  CASH_HOLDING: 'cash holdings (sold)',
  CASH_INTRADAY: 'cash intraday',
  OPTIONS: 'F&O options',
  FUTURES: 'futures',
  COMMODITY: 'MCX / commodities',
};

function worstLosing(buckets: Bucket[]): Bucket | null {
  const b = buckets.find((x) => x.net <= -SUGGESTION_RULES.minBucketLoss && x.trades >= SUGGESTION_RULES.minBucketTrades);
  return b ?? null;
}

const pattern = (ps: Pattern[], id: string) => ps.find((p) => p.id === id);

/**
 * Concrete, evidence-tied suggestions ranked by rupee impact (largest first).
 * Phrased as risk / behaviour changes and decisions for the user — never as a
 * certain outcome or a direct buy/sell instruction.
 */
export function buildSuggestions(breakdowns: Breakdowns, patterns: Pattern[], holdings: HoldingCheck[]): Suggestion[] {
  const out: Draft[] = [];

  // Options bought close to expiry.
  const nearExpiry = breakdowns.byOptionDte.filter((b) => b.key === '0 (expiry day)' || b.key === '1-2 days');
  const ne = nearExpiry.reduce((s, b) => ({ trades: s.trades + b.trades, net: s.net + b.net, wins: s.wins + b.wins }), { trades: 0, net: 0, wins: 0 });
  if (ne.trades >= SUGGESTION_RULES.minBucketTrades && ne.net <= -SUGGESTION_RULES.minBucketLoss) {
    out.push({
      id: 'NEAR_EXPIRY_OPTIONS',
      category: 'RISK',
      title: 'Stop buying options with ≤ 2 days to expiry',
      detail: 'Options bought on expiry day or the day before decay fastest; a small move against you takes most of the premium. Consider a rule: no new option buys with ≤ 2 days left, or half size with a hard stop.',
      evidence: `${ne.trades} option trades entered with ≤ 2 DTE netted ${inr(ne.net)} (${ne.wins} winners).`,
      impactRupees: round2(-ne.net),
    });
  }

  // Far-OTM "lottery" premiums.
  const far = breakdowns.byOptionPremium.find((b) => b.key.startsWith('premium <0.5%'));
  if (far && far.trades >= SUGGESTION_RULES.minBucketTrades && far.net <= -SUGGESTION_RULES.minBucketLoss) {
    out.push({
      id: 'FAR_OTM_OPTIONS',
      category: 'RISK',
      title: 'Cut back on cheap far-OTM options',
      detail: 'Very cheap premiums (under 0.5% of the strike) need a large move to pay; most expire near zero. If you keep them, size them as money you expect to lose.',
      evidence: `${far.trades} trades with premium < 0.5% of strike netted ${inr(far.net)} (win rate ${far.winRate}%).`,
      impactRupees: round2(-far.net),
    });
  }

  // Calls vs puts: one side carries the options loss.
  const ce = breakdowns.byOptionType.find((b) => b.key === 'CE');
  const pe = breakdowns.byOptionType.find((b) => b.key === 'PE');
  for (const [side, other, label] of [[ce, pe, 'calls (CE)'], [pe, ce, 'puts (PE)']] as const) {
    if (side && side.trades >= 10 && side.net <= -SUGGESTION_RULES.minBucketLoss && (!other || other.net > side.net / 2)) {
      out.push({
        id: `OPTION_SIDE_${side.key}`,
        category: 'BEHAVIOUR',
        title: `Most of the options loss is in ${label} — tighten the rules for those entries`,
        detail: `Your ${label} lose far more than the other side. Check whether they are bought after a run-up (chasing) or against the trend; until that is fixed, trade them smaller.`,
        evidence: `${side.trades} ${side.key} trades netted ${inr(side.net)} (win rate ${side.winRate}%) vs ${other ? `${other.trades} ${other.key} trades ${inr(other.net)}` : 'no trades on the other side'}.`,
        impactRupees: round2(-side.net),
      });
    }
  }

  // Expiry: options held into expiry.
  const exp = breakdowns.byClosedBy.find((b) => b.key === 'EXPIRY');
  if (exp && exp.net <= -SUGGESTION_RULES.minBucketLoss) {
    out.push({
      id: 'HELD_TO_EXPIRY',
      category: 'RISK',
      title: 'Decide an exit before expiry day',
      detail: 'Positions that were simply left to expire lost their whole remaining value. Set a calendar rule: every option is closed or consciously rolled by the last trading day.',
      evidence: `${exp.trades} positions ran into expiry and netted ${inr(exp.net)}.`,
      impactRupees: round2(-exp.net),
    });
  }

  // Worst segment.
  const seg = worstLosing(breakdowns.bySegment.filter((b) => b.key !== 'CASH_HOLDING'));
  if (seg) {
    out.push({
      id: `SEGMENT_${seg.key}`,
      category: 'RISK',
      title: `Shrink size in ${SEGMENT_LABEL[seg.key] ?? seg.key} until it is net positive`,
      detail: `This segment is where most of the trading loss sits. Trade it at a smaller size (or paper only) and review after 20 trades, instead of trying to win it back.`,
      evidence: `${seg.trades} trades, win rate ${seg.winRate}%, net ${inr(seg.net)} after ₹${Math.round(seg.charges).toLocaleString('en-IN')} charges.`,
      impactRupees: round2(-seg.net),
    });
  }

  // Worst underlyings.
  const und = breakdowns.byUnderlying.filter((b) => b.net <= -SUGGESTION_RULES.minBucketLoss && b.trades >= 2).slice(0, 2);
  for (const u of und) {
    out.push({
      id: `UNDERLYING_${u.key}`,
      category: 'BEHAVIOUR',
      title: `Review your ${u.key} trades before the next one`,
      detail: `${u.key} has cost you repeatedly. Write down what the setup was each time; if there is no repeatable edge, take it off your list for a month.`,
      evidence: `${u.trades} trades, ${u.wins} winners, net ${inr(u.net)}.`,
      impactRupees: round2(-u.net),
    });
  }

  const stop = pattern(patterns, 'NO_STOP');
  if (stop && stop.severity !== 'OK' && stop.rupees >= SUGGESTION_RULES.minBucketLoss) {
    const saving = Number(stop.evidence.illustrativeSaving ?? 0);
    out.push({
      id: 'USE_STOPS',
      category: 'RISK',
      title: 'Put a stop on every trade when you enter it',
      detail: 'Decide the exit before the entry: for bought options a premium stop (e.g. −30%), for futures and cash a price level. The app\'s price trigger / AI exit can hold it for you.',
      evidence: `${stop.finding}`,
      impactRupees: round2(saving > 0 ? saving : stop.rupees),
    });
  }

  const hold = pattern(patterns, 'LOSERS_HELD_LONGER');
  if (hold && (hold.severity === 'HIGH' || hold.severity === 'MEDIUM') && hold.rupees > 0) {
    out.push({
      id: 'CUT_LOSERS_SOONER',
      category: 'BEHAVIOUR',
      title: 'Cut losers on a time rule too',
      detail: 'Losers are being held longer than winners — the classic "hope" pattern. If a trade has not worked within the time your winners usually take, exit or halve it.',
      evidence: hold.finding,
      impactRupees: hold.rupees,
    });
  }

  const give = pattern(patterns, 'GIVING_BACK');
  if (give && give.severity !== 'OK' && give.rupees >= SUGGESTION_RULES.minBucketLoss) {
    out.push({
      id: 'PROTECT_OPEN_PROFIT',
      category: 'BEHAVIOUR',
      title: 'Protect open profit with a trailing stop or partial booking',
      detail: 'Trades that were well in profit came back to little or a loss. Book part at a first target and trail the rest, or let the app\'s trailing target do it.',
      evidence: give.finding,
      impactRupees: give.rupees,
    });
  }

  const avgDown = pattern(patterns, 'AVERAGING_DOWN');
  if (avgDown && avgDown.rupees >= SUGGESTION_RULES.minBucketLoss) {
    out.push({
      id: 'NO_AVERAGING_DOWN',
      category: 'BEHAVIOUR',
      title: 'Stop averaging down on losing positions',
      detail: 'Adding to a loser increases the size of a trade that is already wrong. Add only to positions that are working, and only with a stop.',
      evidence: avgDown.finding,
      impactRupees: avgDown.rupees,
    });
  }

  const re = pattern(patterns, 'SAME_DAY_REENTRY');
  if (re && re.rupees >= SUGGESTION_RULES.minBucketLoss) {
    out.push({
      id: 'NO_REVENGE_REENTRY',
      category: 'BEHAVIOUR',
      title: 'One attempt per contract per day',
      detail: 'Re-entering the same contract after an exit the same day has lost money overall. After a stop-out, wait for the next session or a fresh setup.',
      evidence: re.finding,
      impactRupees: re.rupees,
    });
  }

  const big = pattern(patterns, 'OVERSIZED');
  if (big && big.rupees >= SUGGESTION_RULES.minBucketLoss) {
    out.push({
      id: 'FIXED_SIZE',
      category: 'RISK',
      title: 'Keep position size within your normal range',
      detail: 'Your largest trades lost more than your normal ones. Fix a maximum per trade (e.g. 2× your median) and size by the stop distance, not by conviction.',
      evidence: big.finding,
      impactRupees: big.rupees,
    });
  }

  // Holdings: dead money — one suggestion with the worst names.
  const dead = holdings.filter((h) => h.tags.includes('DEAD-MONEY')).sort((a, b) => a.pnl - b.pnl);
  if (dead.length) {
    const loss = dead.reduce((s, h) => s + h.pnl, 0);
    out.push({
      id: 'DEAD_HOLDINGS',
      category: 'HOLDING',
      title: `Decide on ${dead.length} dead holding${dead.length > 1 ? 's' : ''}: exit, or set a stop and a review date`,
      detail: `These are down 20%+ after 60+ days. For each, write down why you still hold it; if the reason is "waiting to get back to cost", that is not a reason. ${dead.slice(0, 4).map((h) => `${h.symbol} ${h.pnlPct}%`).join(', ')}.`,
      evidence: `${dead.length} holdings, ${inr(dead.reduce((s, h) => s + h.cost, 0))} at cost, ${inr(loss)} unrealised.`,
      impactRupees: round2(-loss),
    });
  }

  // Holdings in a weak trend that are not already "dead".
  const weak = holdings.filter((h) => h.tags.includes('WEAK-TREND') && !h.tags.includes('DEAD-MONEY') && h.pnl < 0);
  if (weak.length) {
    const loss = weak.reduce((s, h) => s + h.pnl, 0);
    out.push({
      id: 'WEAK_TREND_HOLDINGS',
      category: 'HOLDING',
      title: 'Set a stop on losing holdings that are below their moving averages',
      detail: `Below the 50-DMA and the long-term trend, a loss tends to stay a loss for longer. Decide a level at which you exit. ${weak.slice(0, 4).map((h) => `${h.symbol} ${h.pnlPct}% (50-DMA ${h.trend.dma50})`).join(', ')}.`,
      evidence: `${weak.length} holdings, ${inr(loss)} unrealised.`,
      impactRupees: round2(-loss),
    });
  }

  const conc = holdings.filter((h) => h.tags.includes('CONCENTRATED'));
  if (conc.length) {
    const atRisk = conc.reduce((s, h) => s + (h.value ?? h.cost), 0) * SUGGESTION_RULES.concentrationShock;
    out.push({
      id: 'CONCENTRATION',
      category: 'RISK',
      title: `Reduce concentration in ${conc.map((h) => h.symbol).join(', ')}`,
      detail: 'A single position this large means one stock decides the portfolio. Consider capping any one holding at ~10–15% of the book.',
      evidence: conc.map((h) => `${h.symbol} ${h.sharePct}% of book (${h.pnlPct}%)`).join('; ') + `. A further 10% move = ${inr(atRisk)}.`,
      impactRupees: round2(atRisk),
    });
  }

  const ch = pattern(patterns, 'CHARGES');
  if (ch && (ch.severity === 'HIGH' || ch.severity === 'MEDIUM')) {
    out.push({
      id: 'CHARGES',
      category: 'COST',
      title: 'Trade less often — charges are a big share of the result',
      detail: 'Every round trip pays brokerage, STT and exchange fees whether it wins or not. Fewer, better-planned trades cut this directly.',
      evidence: ch.finding,
      impactRupees: ch.rupees,
    });
  }

  // Worst entry-time window (positions).
  const tod = worstLosing(breakdowns.byEntryTime);
  if (tod) {
    out.push({
      id: `ENTRY_TIME_${tod.key}`,
      category: 'BEHAVIOUR',
      title: `Be stricter about entries in the ${tod.key} window`,
      detail: 'Your entries in this window lose more than the rest. Require a written setup (level + stop) before entering at this time.',
      evidence: `${tod.trades} trades entered ${tod.key} IST netted ${inr(tod.net)} (win rate ${tod.winRate}%).`,
      impactRupees: round2(-tod.net),
    });
  }

  return rankSuggestions(out);
}

/** Rank by rupee impact (largest first), drop non-positive impact, keep the top N. Stable for ties. */
export function rankSuggestions(drafts: Draft[]): Suggestion[] {
  const seen = new Set<string>();
  return drafts
    .filter((d) => d.impactRupees > 0 && !seen.has(d.id) && seen.add(d.id))
    .map((d, i) => ({ d, i }))
    .sort((a, b) => b.d.impactRupees - a.d.impactRupees || a.i - b.i)
    .slice(0, SUGGESTION_RULES.maxSuggestions)
    .map(({ d }, i) => ({ ...d, rank: i + 1 }));
}
