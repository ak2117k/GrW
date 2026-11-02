import { istDay } from './symbols';
import type { ClosedTrade, Episode, HoldingCheck, Pattern, Severity } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const inr = (n: number) => `${n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

export const BEHAVIOUR_RULES = {
  minSample: 3,
  /** Losers held this many times longer than winners is a HIGH finding. */
  holdRatioHigh: 2,
  holdRatioMedium: 1.3,
  /** Option loss of this % of premium or worse = no stop evident. */
  optionDeepLossPct: -50,
  /** Cash / futures loss of this % of notional or worse = no stop evident. */
  linearDeepLossPct: -10,
  /** The illustrative stop the "no stop" finding prices: −30% of option premium. */
  illustrativeOptionStopPct: 30,
  /** Oversized = entry notional above this multiple of the segment median. */
  oversizeMultiple: 2,
  oversizeMinTrades: 5,
  /** Giving back: peak open profit ≥ max(this, 2 × charges) and the exit kept ≤ half of it. */
  givebackMinPeak: 500,
  givebackKeptFraction: 0.5,
  concentrationTop1High: 25,
  concentrationTop3High: 50,
  concentrationTop1Medium: 15,
} as const;

const examples = (ts: ClosedTrade[], n = 4) =>
  [...ts].sort((a, b) => a.net - b.net).slice(0, n).map((t) => `${t.symbol} ${inr(t.net)} (${istDay(new Date(t.exitTime as string))})`);

/** Losers held much longer than winners? Positions only (holdings were bought before tracking began). */
export function losersHeldLonger(trades: ClosedTrade[]): Pattern {
  const pos = trades.filter((t) => t.kind === 'POSITION');
  const winners = pos.filter((t) => t.net > 0);
  const losers = pos.filter((t) => t.net < 0);
  const w = avg(winners.map((t) => t.holdingDays));
  const l = avg(losers.map((t) => t.holdingDays));
  const ratio = w > 0 ? l / w : l > 0 ? Infinity : 0;
  const enough = winners.length >= BEHAVIOUR_RULES.minSample && losers.length >= BEHAVIOUR_RULES.minSample;
  // "Overstayed": held more than twice the average winner AND past one day (an overnight carry of a loser).
  const cutoff = Math.max(2 * w, 1);
  const longLosers = losers.filter((t) => t.holdingDays > cutoff);
  const severity: Severity = !enough ? 'OK' : ratio >= BEHAVIOUR_RULES.holdRatioHigh ? 'HIGH' : ratio >= BEHAVIOUR_RULES.holdRatioMedium ? 'MEDIUM' : 'OK';
  return {
    id: 'LOSERS_HELD_LONGER',
    title: 'Losers held longer than winners',
    finding: enough
      ? `Losing positions were held ${round1(l)} days on average vs ${round1(w)} days for winners (${Number.isFinite(ratio) ? round1(ratio) : '∞'}×). ${longLosers.length} losers were held more than ${round1(cutoff)} day${cutoff === 1 ? "" : "s"} (2× the average winner, at least a day) and lost ${inr(sum(longLosers.map((t) => t.net)))}.`
      : 'Not enough closed positions to compare.',
    severity,
    rupees: enough ? round2(Math.abs(sum(longLosers.map((t) => t.net)))) : 0,
    evidence: { winners: winners.length, losers: losers.length, winnersAvgDays: round1(w), losersAvgDays: round1(l), overstayed: longLosers.length, overstayedCutoffDays: round1(cutoff), ratio: Number.isFinite(ratio) ? round2(ratio) : null },
    examples: examples(longLosers),
  };
}

/** Bought more of a position or holding while it was below the average price. */
export function averagingDown(episodes: Episode[], trades: ClosedTrade[]): Pattern {
  const eps = episodes.filter((e) => e.role === 'TRADE' && e.averagedDown);
  const closedNet = new Map(trades.map((t) => [t.key, t.net]));
  const outcome = eps.map((e) => (e.status === 'OPEN' ? e.unrealised + e.realisedGross - e.charges : (closedNet.get(e.key) ?? 0)));
  const total = sum(outcome);
  return {
    id: 'AVERAGING_DOWN',
    title: 'Averaging down',
    finding: eps.length
      ? `${eps.length} positions/holdings were added to while below the average price; together they stand at ${inr(total)} (realised + open).`
      : 'No averaging down found in the tracked history.',
    severity: eps.length === 0 ? 'OK' : total < 0 ? (eps.length >= 3 ? 'HIGH' : 'MEDIUM') : 'LOW',
    rupees: total < 0 ? round2(-total) : 0,
    evidence: { count: eps.length, netOutcome: round2(total) },
    examples: eps.slice(0, 6).map((e, i) => `${e.symbol} ${inr(outcome[i])}${e.status === 'OPEN' ? ' (open)' : ''}`),
  };
}

/** The same contract opened again on the same IST day after an earlier trade closed. */
export function sameDayReentries(trades: ClosedTrade[]): Pattern {
  const pos = trades.filter((t) => t.kind === 'POSITION');
  const groups = new Map<string, ClosedTrade[]>();
  for (const t of pos) {
    const k = `${t.token}|${istDay(new Date(t.firstEntry))}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const reentries: ClosedTrade[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => Date.parse(a.firstEntry) - Date.parse(b.firstEntry));
    reentries.push(...g.slice(1));
  }
  const net = sum(reentries.map((t) => t.net));
  return {
    id: 'SAME_DAY_REENTRY',
    title: 'Re-entering the same contract the same day',
    finding: reentries.length
      ? `${reentries.length} re-entries on a contract already traded that day netted ${inr(net)} (win rate ${round1((reentries.filter((t) => t.net > 0).length / reentries.length) * 100)}%).`
      : 'No same-day re-entries found.',
    severity: reentries.length >= BEHAVIOUR_RULES.minSample && net < 0 ? 'MEDIUM' : reentries.length && net < 0 ? 'LOW' : 'OK',
    rupees: net < 0 ? round2(-net) : 0,
    evidence: { reentries: reentries.length, net: round2(net) },
    examples: examples(reentries),
  };
}

/** Deep losses or options held into expiry — no stop evident. */
export function noStopEvidence(trades: ClosedTrade[]): Pattern {
  const deep = trades.filter((t) => {
    if (t.net >= 0) return false;
    if (t.closedBy === 'EXPIRY') return true;
    const isOpt = t.derivative !== null && t.derivative.type !== 'FUT';
    return isOpt ? t.returnPct <= BEHAVIOUR_RULES.optionDeepLossPct : t.kind === 'POSITION' && t.returnPct <= BEHAVIOUR_RULES.linearDeepLossPct;
  });
  const loss = sum(deep.map((t) => t.net));
  // What a −30% premium stop would have capped the OPTION losses at (ignores gaps / slippage).
  const stop = BEHAVIOUR_RULES.illustrativeOptionStopPct / 100;
  const optDeep = deep.filter((t) => t.derivative !== null && t.derivative.type !== 'FUT');
  const capped = sum(optDeep.map((t) => -(t.entryPrice * t.qty * stop) - t.charges));
  const optLoss = sum(optDeep.map((t) => t.net));
  const saved = Math.max(0, capped - optLoss);
  return {
    id: 'NO_STOP',
    title: 'Losses without a stop',
    finding: deep.length
      ? `${deep.length} trades lost ≥50% of the option premium (or ≥10% of notional, or ran into expiry): ${inr(loss)} in total.` +
        (optDeep.length ? ` A −30% premium stop on the ${optDeep.length} option trades would have capped them near ${inr(capped)} instead of ${inr(optLoss)} (≈${inr(saved)} less loss; illustrative, ignores gaps).` : '')
      : 'No deep losses found.',
    severity: deep.length >= BEHAVIOUR_RULES.minSample ? 'HIGH' : deep.length ? 'MEDIUM' : 'OK',
    rupees: round2(Math.abs(loss)),
    evidence: { trades: deep.length, loss: round2(loss), optionTrades: optDeep.length, illustrativeSaving: round2(saved) },
    examples: examples(deep),
  };
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Trades far larger than the user's usual size in that segment. */
export function oversized(trades: ClosedTrade[]): Pattern {
  const bySeg = new Map<string, ClosedTrade[]>();
  for (const t of trades.filter((x) => x.kind === 'POSITION')) bySeg.set(t.segment, [...(bySeg.get(t.segment) ?? []), t]);
  const big: ClosedTrade[] = [];
  const rest: ClosedTrade[] = [];
  const medians: Record<string, number> = {};
  for (const [seg, ts] of bySeg) {
    if (ts.length < BEHAVIOUR_RULES.oversizeMinTrades) continue;
    const med = median(ts.map((t) => t.entryNotional));
    medians[seg] = round2(med);
    for (const t of ts) (t.entryNotional > BEHAVIOUR_RULES.oversizeMultiple * med ? big : rest).push(t);
  }
  const net = sum(big.map((t) => t.net));
  // Size only "costs" when the big trades do worse per trade than normal ones.
  const worse = big.length > 0 && net < 0 && avg(big.map((t) => t.net)) < avg(rest.map((t) => t.net));
  return {
    id: 'OVERSIZED',
    title: 'Oversized positions',
    finding: big.length
      ? `${big.length} trades were over ${BEHAVIOUR_RULES.oversizeMultiple}× your median size for their segment and netted ${inr(net)} (avg ${inr(avg(big.map((t) => t.net)))} vs ${inr(avg(rest.map((t) => t.net)))} for normal-size trades).`
      : 'No trades far above your usual size.',
    severity: worse ? (big.length >= BEHAVIOUR_RULES.minSample ? 'HIGH' : 'MEDIUM') : big.length && net < 0 ? 'LOW' : 'OK',
    rupees: worse ? round2(-net) : 0,
    evidence: { trades: big.length, net: round2(net), avgNetBig: round2(avg(big.map((t) => t.net))), avgNetNormal: round2(avg(rest.map((t) => t.net))), ...Object.fromEntries(Object.entries(medians).map(([k, v]) => [`median_${k}`, v])) },
    examples: examples(big),
  };
}

/** Peak open profit given back before the exit. */
export function givingBack(trades: ClosedTrade[]): Pattern {
  const hits = trades.filter(
    (t) =>
      t.kind === 'POSITION' &&
      t.peakOpenProfit !== null &&
      t.peakOpenProfit >= Math.max(BEHAVIOUR_RULES.givebackMinPeak, 2 * t.charges) &&
      t.realisedGross <= BEHAVIOUR_RULES.givebackKeptFraction * t.peakOpenProfit,
  );
  const gave = sum(hits.map((t) => t.gaveBack));
  const turnedLoss = hits.filter((t) => t.net < 0);
  // Counterfactual a trail that locks half the peak would have kept (ignores gaps; peaks are polled LTPs).
  const keep = BEHAVIOUR_RULES.givebackKeptFraction;
  const trailGain = sum(hits.map((t) => Math.max(0, keep * (t.peakOpenProfit ?? 0) - t.realisedGross)));
  return {
    id: 'GIVING_BACK',
    title: 'Giving back open profit',
    finding: hits.length
      ? `${hits.length} trades were up at least ₹${BEHAVIOUR_RULES.givebackMinPeak} but kept less than half of the peak; ${inr(gave)} of open profit was given back, and ${turnedLoss.length} of them closed in loss. A trail locking half of each peak would have kept ≈${inr(trailGain)} more (illustrative).`
      : 'No large giveback of open profit found.',
    severity: hits.length >= BEHAVIOUR_RULES.minSample ? 'HIGH' : hits.length ? 'MEDIUM' : 'OK',
    rupees: round2(trailGain),
    evidence: { trades: hits.length, gaveBack: round2(gave), trailHalfPeakGain: round2(trailGain), turnedToLoss: turnedLoss.length },
    examples: [...hits].sort((a, b) => b.gaveBack - a.gaveBack).slice(0, 4).map((t) => `${t.symbol}: peak +${inr(t.peakOpenProfit ?? 0)}, closed ${inr(t.net)}`),
  };
}

export function concentration(holdings: HoldingCheck[]): Pattern {
  const s = [...holdings].sort((a, b) => b.sharePct - a.sharePct);
  const top1 = s[0]?.sharePct ?? 0;
  const top3 = round1(sum(s.slice(0, 3).map((h) => h.sharePct)));
  const sev: Severity = !s.length
    ? 'OK'
    : top1 >= BEHAVIOUR_RULES.concentrationTop1High || top3 >= BEHAVIOUR_RULES.concentrationTop3High
      ? 'HIGH'
      : top1 >= BEHAVIOUR_RULES.concentrationTop1Medium
        ? 'MEDIUM'
        : 'OK';
  return {
    id: 'CONCENTRATION',
    title: 'Concentration',
    finding: s.length ? `Largest holding ${s[0].symbol} is ${top1}% of the holdings book at cost; the top 3 are ${top3}%.` : 'No open holdings.',
    severity: sev,
    rupees: round2(sum(s.slice(0, 3).map((h) => h.cost))),
    evidence: { holdings: s.length, top1Pct: top1, top3Pct: top3 },
    examples: s.slice(0, 3).map((h) => `${h.symbol} ${h.sharePct}% (${inr(h.cost)} cost, ${h.pnlPct}%)`),
  };
}

export function deadHoldings(holdings: HoldingCheck[]): Pattern {
  const dead = holdings.filter((h) => h.tags.includes('DEAD-MONEY'));
  const loss = sum(dead.map((h) => h.pnl));
  const cost = sum(dead.map((h) => h.cost));
  return {
    id: 'DEAD_HOLDINGS',
    title: 'Dead holdings',
    finding: dead.length
      ? `${dead.length} holdings are down 20% or more after 60+ days: ${inr(cost)} at cost, now ${inr(loss)}. That capital has been idle while losing.`
      : 'No holding is down 20%+ after 60+ days.',
    severity: dead.length >= 3 ? 'HIGH' : dead.length ? 'MEDIUM' : 'OK',
    rupees: round2(Math.abs(loss)),
    evidence: { holdings: dead.length, cost: round2(cost), unrealised: round2(loss) },
    examples: dead.slice(0, 6).map((h) => `${h.symbol} ${h.pnlPct}% (${inr(h.pnl)})`),
  };
}

/** F&O / MCX trades closed by the AI exit vs everything else. */
export function aiVsManualExits(trades: ClosedTrade[]): Pattern {
  const fno = trades.filter((t) => t.segment === 'OPTIONS' || t.segment === 'FUTURES' || t.segment === 'COMMODITY');
  const ai = fno.filter((t) => t.closedBy === 'AI_EXIT');
  const manualApp = fno.filter((t) => t.closedBy === 'MANUAL_IN_APP');
  const broker = fno.filter((t) => t.closedBy === 'AT_BROKER');
  const expiry = fno.filter((t) => t.closedBy === 'EXPIRY');
  const line = (label: string, ts: ClosedTrade[]) => `${label} ${ts.length} trades ${inr(sum(ts.map((t) => t.net)))} (avg ${inr(avg(ts.map((t) => t.net)))})`;
  return {
    id: 'AI_VS_MANUAL_EXITS',
    title: 'Who closed the F&O trades',
    finding: fno.length
      ? [line('AI exit:', ai), line('Exit button:', manualApp), line('at the broker:', broker), line('expiry:', expiry)].join('; ') + '.'
      : 'No F&O trades.',
    severity: ai.length < BEHAVIOUR_RULES.minSample ? 'LOW' : 'OK',
    rupees: 0,
    evidence: {
      aiTrades: ai.length,
      aiNet: round2(sum(ai.map((t) => t.net))),
      manualAppTrades: manualApp.length,
      manualAppNet: round2(sum(manualApp.map((t) => t.net))),
      brokerTrades: broker.length,
      brokerNet: round2(sum(broker.map((t) => t.net))),
      expiryTrades: expiry.length,
      expiryNet: round2(sum(expiry.map((t) => t.net))),
    },
    examples: [],
  };
}

export function chargesDrag(trades: ClosedTrade[]): Pattern {
  const charges = sum(trades.map((t) => t.charges));
  const gross = sum(trades.map((t) => t.realisedGross));
  const share = Math.abs(gross) > 0 ? (charges / Math.abs(gross)) * 100 : 0;
  return {
    id: 'CHARGES',
    title: 'Charges',
    finding: trades.length
      ? `Estimated charges ${inr(charges)} over ${trades.length} trades (avg ${inr(charges / trades.length)} per trade), ${round1(share)}% of the gross P&L's size.`
      : 'No trades.',
    severity: share >= 25 ? 'HIGH' : share >= 10 ? 'MEDIUM' : 'LOW',
    rupees: round2(charges),
    evidence: { charges: round2(charges), gross: round2(gross), pctOfGross: round1(share) },
    examples: [],
  };
}

export function computePatterns(trades: ClosedTrade[], episodes: Episode[], holdings: HoldingCheck[]): Pattern[] {
  return [
    losersHeldLonger(trades),
    noStopEvidence(trades),
    givingBack(trades),
    averagingDown(episodes, trades),
    sameDayReentries(trades),
    oversized(trades),
    deadHoldings(holdings),
    concentration(holdings),
    aiVsManualExits(trades),
    chargesDrag(trades),
  ];
}
