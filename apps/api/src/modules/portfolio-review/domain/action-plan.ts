/**
 * The action plan — "what you can do next" (owner 2026-11-02: "suggest what we can modify so it can turn
 * in our favour … which equity to add or sell based on the current balance, to be on the safe side").
 * Pure and deterministic: per-holding HOLD / ADD / TRIM / EXIT / SET_STOP with a quantity and a
 * protective stop, "safe side" sizing against the current balance, and up to five new ideas from the
 * F&O stock universe. Every threshold is a named constant in PLAN_RULES. The LLM only explains the
 * result (plan-prompt.ts).
 *
 * These are decision-support suggestions, not predictions: the rules lean to protecting capital
 * (cash buffer, weight cap, no averaging down, stops on everything) and never size an idea beyond
 * the caps or the cash above the buffer.
 */
import { buildEvidence, evidenceChips } from './evidence';
import type {
  ActionPlan,
  BalanceRead,
  Evidence,
  HoldingAction,
  HoldingCheck,
  LlmSummary,
  NewIdea,
  Recommendation,
  ScreenStats,
  Sizing,
  WeightRow,
} from './types';

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const inr = (n: number) => `${n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
/** Round DOWN to the NSE equity tick (₹0.05). */
const tickDown = (n: number) => Math.floor(n * 20 + 1e-9) / 20;

export const PLAN_RULES = {
  /** Keep at least this % of total capital (cash + holdings value) in cash. */
  cashBufferPct: 20,
  /** No single stock above this % of total capital (TRIM down to it; ADD never past it). */
  maxWeightPct: 15,
  /** One ADD or one new idea gets at most this % of total capital. */
  maxNewIdeaPct: 5,
  /** No sector above this % of total capital gets a new idea. */
  maxSectorPct: 25,
  /** No averaging down: never ADD to a holding that is down more than this % … */
  maxLossToAddPct: -10,
  /** DEAD-MONEY (same as the holdings check): down at least this % … */
  deadLossPct: -20,
  /** … after at least this many days. */
  deadMinDays: 60,
  /** Protective stop distance: this × ATR(14) below the price … */
  stopAtrMult: 2,
  /** … but at least this % … */
  minStopPct: 3,
  /** … and at most this % below the price. */
  maxStopPct: 12,
  /** Stop distance (%) when there is no ATR (no candles). */
  defaultStopPct: 8,
  /** A new idea must have returned at least this % over ~6 months. */
  minIdeaRet6mPct: 10,
  /** A new idea must not be more than this % above its 20-DMA (no chasing an extended move). */
  maxIdeaExtensionPct: 8,
  /** No ADD / new idea when results are due within this many days. */
  noAddDaysBeforeResults: 3,
  /** At most this many new ideas, and this many per sector. */
  maxIdeas: 5,
  maxIdeasPerSector: 1,
  /** Smaller orders than this (rupees) are not suggested. */
  minOrderRupees: 500,
} as const;

export const PLAN_DISCLAIMER =
  'Analysis, not investment advice: rule-based suggestions from past prices, news and OI — not predictions. Markets can move against any plan; check the numbers with your broker before acting.';

/** A protective stop below `price`: 2×ATR(14), clamped to 3–12% of the price; 8% without an ATR. */
export function protectiveStop(price: number, atr14: number | null): { stop: number; basis: string } {
  if (!(price > 0)) return { stop: 0, basis: 'no price' };
  if (atr14 === null || !(atr14 > 0)) {
    return { stop: tickDown(price * (1 - PLAN_RULES.defaultStopPct / 100)), basis: `${PLAN_RULES.defaultStopPct}% below the price (no ATR)` };
  }
  const raw = PLAN_RULES.stopAtrMult * atr14;
  const lo = (PLAN_RULES.minStopPct / 100) * price;
  const hi = (PLAN_RULES.maxStopPct / 100) * price;
  const dist = Math.min(hi, Math.max(lo, raw));
  const basis = dist === raw ? `${PLAN_RULES.stopAtrMult}×ATR(14) (₹${round2(atr14)}) below the price` : dist === lo ? `${PLAN_RULES.minStopPct}% below the price (ATR is small)` : `${PLAN_RULES.maxStopPct}% below the price (capped; 2×ATR is wider)`;
  return { stop: tickDown(price - dist), basis };
}

/** Days from `now` to the next results event, or null. */
export function daysToResults(e: Evidence, now: Date): number | null {
  const r = e.events.filter((x) => x.kind === 'results').map((x) => Date.parse(x.at)).filter((t) => Number.isFinite(t) && t >= now.getTime() - 86_400_000);
  if (!r.length) return null;
  return Math.max(0, Math.floor((Math.min(...r) - now.getTime()) / 86_400_000));
}

const trendWords = (e: Evidence): string => {
  switch (e.trend) {
    case 'STRONG_UP':
      return `in a strong uptrend — above its 20/50${e.dma200 !== null ? '/200' : ''}-DMA, 6-month ${e.ret6m! > 0 ? '+' : ''}${e.ret6m}%, ${e.fromHigh52wPct}% below the 52-week high`;
    case 'UP':
      return `in an uptrend — above its 50-DMA (${e.dma50})${e.dma200 !== null ? ` and 200-DMA (${e.dma200})` : ''}`;
    case 'WEAK':
      return `below its 50-DMA (${e.dma50}) but above the long trend`;
    case 'DOWN':
      return e.dma200 !== null ? `below its 200-DMA (${e.dma200}) — a long downtrend` : `below its 50-DMA (${e.dma50}) with a negative 6-month return`;
    default:
      return 'without a daily-candle trend (no candles)';
  }
};

const oiWords = (e: Evidence): string | null => {
  const o = e.oi;
  if (o.status === 'NOT_FNO' || o.status === 'NO_DATA' || !o.buildup) return null;
  return `futures OI over ${o.sessions} sessions: ${o.buildup.replace(/_/g, ' ').toLowerCase()} (price ${o.pricePct! > 0 ? '+' : ''}${o.pricePct}%, OI ${o.oiPct! > 0 ? '+' : ''}${o.oiPct}%)`;
};

/** The deterministic class of one holding before cash allocation. */
export interface HoldingVerdict {
  recommendation: Recommendation;
  /** TRIM / EXIT: shares to sell. */
  sellQty: number;
  /** True when every ADD rule passes (the allocation decides whether cash allows it). */
  addEligible: boolean;
  reasons: string[];
  blocked: string[];
  score: number;
}

/**
 * Rules, first match wins:
 *  1. no price                                     → HOLD (nothing sized)
 *  2. DEAD-MONEY AND below the long trend (DOWN) AND negative news or adverse futures OI → EXIT (all)
 *  3. weight > maxWeightPct                        → TRIM down to the cap
 *  4. every ADD rule passes                        → ADD candidate (sized by the allocation)
 *       STRONG_UP trend, momentum not negative, P&L ≥ −10% (no averaging down), not below the 200-DMA,
 *       news not negative, OI not adverse, below the weight cap, no results within 3 days
 *  5. DEAD-MONEY, or DOWN, or negative news / adverse OI, or WEAK with negative momentum → SET_STOP
 *  6. otherwise                                    → HOLD
 * News alone never makes an EXIT or an ADD (the news model is ~coin-flip on direction).
 */
export function classifyHolding(h: HoldingCheck, e: Evidence, capital: number, now: Date): HoldingVerdict {
  const reasons: string[] = [];
  const blocked: string[] = [];
  const price = h.ltp;
  if (price === null || !(price > 0) || !(capital > 0)) {
    return { recommendation: 'HOLD', sellQty: 0, addEligible: false, reasons: ['No live price for this holding — nothing sized; check it at the broker.'], blocked, score: 0 };
  }
  const value = price * h.qty;
  const weight = (value / capital) * 100;
  const dead = h.pnlPct <= PLAN_RULES.deadLossPct && h.daysHeld >= PLAN_RULES.deadMinDays;
  const down = e.trend === 'DOWN';
  const negNews = e.news === 'NEGATIVE';
  const advOi = e.oi.status === 'ADVERSE';
  const oiText = oiWords(e);
  const results = daysToResults(e, now);
  const resultsNote = results !== null ? `Results due in ${results} day(s) (${e.events.find((x) => x.kind === 'results')?.at.slice(0, 10)}) — moves around results can be large.` : null;
  const newsNote = negNews ? `Negative material news this week: “${e.newsItems.find((n) => n.direction === 'BEAR')?.headline ?? ''}” (news is context only).` : null;

  if (dead && down && (negNews || advOi)) {
    reasons.push(`Down ${h.pnlPct}% after ${h.daysHeld} days (dead money: ≤ ${PLAN_RULES.deadLossPct}% and ≥ ${PLAN_RULES.deadMinDays} days).`);
    reasons.push(`Price is ${trendWords(e)}.`);
    if (advOi && oiText) reasons.push(`The ${oiText} — the flow is against it.`);
    if (newsNote) reasons.push(newsNote);
    reasons.push(`Exiting frees ${inr(value)} at the last price.`);
    return { recommendation: 'EXIT', sellQty: h.qty, addEligible: false, reasons, blocked, score: 0 };
  }

  if (weight > PLAN_RULES.maxWeightPct) {
    const excess = value - (PLAN_RULES.maxWeightPct / 100) * capital;
    const sellQty = Math.min(h.qty, Math.ceil(excess / price));
    reasons.push(`${round1(weight)}% of total capital — above the ${PLAN_RULES.maxWeightPct}% cap; selling ${sellQty} brings it to about ${round1((((h.qty - sellQty) * price) / capital) * 100)}%.`);
    reasons.push(`Price is ${trendWords(e)}.`);
    if (oiText) reasons.push(`The ${oiText}.`);
    if (resultsNote) reasons.push(resultsNote);
    return { recommendation: 'TRIM', sellQty, addEligible: false, reasons, blocked, score: 0 };
  }

  // ADD rules (also the "why not" list a HOLD shows).
  if (e.trend !== 'STRONG_UP') blocked.push(e.trend === 'NO_DATA' ? 'no trend data' : 'trend not strong enough to add');
  if (down) blocked.push(`no averaging down: below the ${e.dma200 !== null ? '200' : '50'}-DMA`);
  if (h.pnlPct < PLAN_RULES.maxLossToAddPct) blocked.push(`no averaging down: position is ${h.pnlPct}% (limit ${PLAN_RULES.maxLossToAddPct}%)`);
  if (e.momentum === 'NEGATIVE') blocked.push('1-month momentum is negative');
  if (negNews) blocked.push('negative news this week');
  if (advOi) blocked.push('futures OI is building against it');
  if (weight >= PLAN_RULES.maxWeightPct) blocked.push(`already at the ${PLAN_RULES.maxWeightPct}% weight cap`);
  if (results !== null && results <= PLAN_RULES.noAddDaysBeforeResults) blocked.push(`results within ${PLAN_RULES.noAddDaysBeforeResults} days`);

  if (blocked.length === 0) {
    reasons.push(`Price is ${trendWords(e)}.`);
    if (e.oi.status === 'SUPPORTIVE' && oiText) reasons.push(`The ${oiText} supports it.`);
    reasons.push(`In profit (${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct}%) and ${round1(weight)}% of capital — room under the ${PLAN_RULES.maxWeightPct}% cap.`);
    if (resultsNote) reasons.push(resultsNote);
    return { recommendation: 'ADD', sellQty: 0, addEligible: true, reasons, blocked, score: ideaScore(e, false) };
  }

  const weakAndFalling = e.trend === 'WEAK' && e.momentum === 'NEGATIVE';
  if (dead || down || negNews || advOi || weakAndFalling) {
    if (dead) reasons.push(`Down ${h.pnlPct}% after ${h.daysHeld} days (dead money) — decide a stop and a review date rather than waiting.`);
    reasons.push(`Price is ${trendWords(e)}.`);
    if (weakAndFalling) reasons.push(`1-month return ${e.ret1m}% — still falling.`);
    if (oiText) reasons.push(`The ${oiText}.`);
    if (newsNote) reasons.push(newsNote);
    if (dead && down) reasons.push('Two of the three exit conditions hold (dead money, below the long trend); an exit is suggested only when news or futures OI also turns against it.');
    if (resultsNote) reasons.push(resultsNote);
    return { recommendation: 'SET_STOP', sellQty: 0, addEligible: false, reasons, blocked: blocked.filter((b) => b.startsWith('no averaging down')), score: 0 };
  }

  reasons.push(`Price is ${trendWords(e)}; P&L ${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct}%.`);
  if (oiText) reasons.push(`The ${oiText}.`);
  if (resultsNote) reasons.push(resultsNote);
  return { recommendation: 'HOLD', sellQty: 0, addEligible: false, reasons, blocked, score: 0 };
}

// ---------------------------------------------------------------------------
// New-idea screen
// ---------------------------------------------------------------------------

export interface ScreenCandidate {
  symbol: string;
  exchange: string;
  token: string;
  evidence: Evidence;
}

/**
 * The screen's rules (the same trend rules as an ADD, plus no chasing):
 *  STRONG_UP, momentum not negative, 6-month return ≥ 10%, close ≤ 20-DMA × 1.08, news not negative,
 *  futures OI not adverse (unless `ignoreOi` — the cheap first pass before OI is read), no results
 *  within 3 days. Returns the failed rules (empty = pass).
 */
export function screenFailures(e: Evidence, now: Date, opts: { ignoreOi?: boolean } = {}): string[] {
  const f: string[] = [];
  if (e.trend !== 'STRONG_UP') f.push('trend');
  if (e.momentum === 'NEGATIVE' || e.momentum === 'NO_DATA') f.push('momentum');
  if (e.ret6m === null || e.ret6m < PLAN_RULES.minIdeaRet6mPct) f.push('6m return');
  if (e.close === null || e.dma20 === null || e.close > e.dma20 * (1 + PLAN_RULES.maxIdeaExtensionPct / 100)) f.push('extended');
  if (e.news === 'NEGATIVE') f.push('news');
  if (!opts.ignoreOi && e.oi.status === 'ADVERSE') f.push('oi');
  const r = daysToResults(e, now);
  if (r !== null && r <= PLAN_RULES.noAddDaysBeforeResults) f.push('results');
  return f;
}

/**
 * Rank score (higher first): 6-month return (capped 40), supportive OI +15 / neutral +5, positive
 * 1-month momentum +10, a sector the user does not hold +10, positive news +3 (context), minus the
 * distance from the 52-week high.
 */
export function ideaScore(e: Evidence, sectorHeld: boolean): number {
  let s = Math.min(40, Math.max(0, e.ret6m ?? 0) / 2);
  s += e.oi.status === 'SUPPORTIVE' ? 15 : e.oi.status === 'NEUTRAL' ? 5 : 0;
  s += e.momentum === 'POSITIVE' ? 10 : 0;
  s += sectorHeld ? 0 : 10;
  s += e.news === 'POSITIVE' ? 3 : 0;
  s -= e.fromHigh52wPct ?? 15;
  return round1(s);
}

/**
 * Up to maxIdeas passing candidates, never a held symbol, at most maxIdeasPerSector per sector and no
 * sector already at maxSectorPct of capital; ranked by ideaScore. Pure.
 */
export function pickIdeas(cands: ScreenCandidate[], held: Set<string>, sectorWeights: Map<string, number>, now: Date): ScreenCandidate[] {
  const ranked = cands
    .filter((c) => !held.has(c.symbol) && screenFailures(c.evidence, now).length === 0)
    .filter((c) => !c.evidence.sector || (sectorWeights.get(c.evidence.sector) ?? 0) < PLAN_RULES.maxSectorPct)
    .map((c) => ({ c, score: ideaScore(c.evidence, !!c.evidence.sector && (sectorWeights.get(c.evidence.sector) ?? 0) > 0) }))
    .sort((a, b) => b.score - a.score || a.c.symbol.localeCompare(b.c.symbol));
  const perSector = new Map<string, number>();
  const out: ScreenCandidate[] = [];
  for (const { c } of ranked) {
    if (out.length >= PLAN_RULES.maxIdeas) break;
    const sec = c.evidence.sector ?? `?${c.symbol}`;
    if ((perSector.get(sec) ?? 0) >= PLAN_RULES.maxIdeasPerSector) continue;
    perSector.set(sec, (perSector.get(sec) ?? 0) + 1);
    out.push(c);
  }
  return out;
}

/** Entry zone [max(20-DMA, close − 1 ATR), close] — buy on a pullback, not above the last close — and its stop. */
export function entryZone(e: Evidence): { low: number; high: number; stop: number; basis: string } | null {
  if (e.close === null || !(e.close > 0)) return null;
  const high = e.close;
  const low = Math.min(high, Math.max(e.dma20 ?? 0, e.atr14 ? high - e.atr14 : high * 0.97));
  const ps = protectiveStop(low, e.atr14);
  return { low: tickDown(low), high: tickDown(high), stop: ps.stop, basis: `${ps.basis.replace('the price', 'the bottom of the entry zone')}` };
}

// ---------------------------------------------------------------------------
// The whole plan
// ---------------------------------------------------------------------------

export interface PlanInputs {
  holdings: HoldingCheck[];
  /** Evidence per holding token. */
  evidence: Map<string, Evidence>;
  balance: BalanceRead;
  /** Screen candidates with evidence (the service reads them within its budgets). */
  candidates: ScreenCandidate[];
  screen: Omit<ScreenStats, 'picked'>;
  brokerCalls: { used: number; cap: number };
  dataNotes: string[];
  now: Date;
}

const EMPTY_SUMMARY: LlmSummary = { status: 'SKIPPED', text: null, reason: 'not requested' };

/** At most this many holdings are listed as cash-raising candidates. */
const RAISE_CASH_MAX = 8;

/**
 * When cash after the plan is below the buffer: the weakest holdings by the rules, in the order they
 * would be sold to restore it — (1) dead money AND below the long trend, (2) below the long trend,
 * (3) dead money — larger positions first within a group, until the shortfall is covered. Pure;
 * informational only (never changes a recommendation).
 */
export function raiseCashList(actions: HoldingAction[], cashAfter: number, buffer: number): Sizing['raiseCash'] {
  const needed = buffer - cashAfter;
  if (!(needed > 0)) return null;
  const dead = (a: HoldingAction) => a.pnlPct <= PLAN_RULES.deadLossPct && a.daysHeld >= PLAN_RULES.deadMinDays;
  const group = (a: HoldingAction) => (dead(a) && a.evidence.trend === 'DOWN' ? 0 : a.evidence.trend === 'DOWN' ? 1 : dead(a) ? 2 : 9);
  const left = (a: HoldingAction) => (a.ltp ?? 0) * (a.heldQty - (a.recommendation === 'TRIM' || a.recommendation === 'EXIT' ? a.qty : 0));
  const pool = actions
    .filter((a) => group(a) < 9 && left(a) > 0)
    .sort((a, b) => group(a) - group(b) || left(b) - left(a));
  const candidates: Array<{ symbol: string; value: number; why: string }> = [];
  let covered = 0;
  for (const a of pool) {
    if (covered >= needed || candidates.length >= RAISE_CASH_MAX) break;
    const g = group(a);
    candidates.push({ symbol: a.symbol, value: round2(left(a)), why: g === 0 ? 'dead money and below the long trend' : g === 1 ? 'below the long trend' : 'dead money' });
    covered += left(a);
  }
  return { needed: round2(needed), covered: round2(covered), candidates };
}

export function buildActionPlan(input: PlanInputs): ActionPlan {
  const { holdings, now } = input;
  const cash = input.balance.status !== 'NO_DATA' && input.balance.availableCash !== null ? Math.max(0, input.balance.availableCash) : 0;
  const holdingsValue = holdings.reduce((s, h) => s + (h.ltp !== null ? h.ltp * h.qty : 0), 0);
  const capital = cash + holdingsValue;
  const buffer = (PLAN_RULES.cashBufferPct / 100) * capital;
  const notes: string[] = [];
  if (input.balance.status === 'NO_DATA') notes.push(`Available cash could not be read (${input.balance.reason ?? 'no broker answer'}); the plan assumes ₹0 cash, so only money freed by sales can fund an idea.`);
  if (input.balance.status === 'LAST_KNOWN') notes.push(`Available cash is the last known broker reading (${input.balance.asOf?.slice(0, 16).replace('T', ' ')} UTC), not live.`);

  const evOf = (h: HoldingCheck): Evidence =>
    input.evidence.get(h.token) ?? buildEvidence({ trend: h.trend, price: h.ltp, news: [], oi: { status: 'NO_DATA', source: null, sessions: 0, pricePct: null, oiPct: null, buildup: null, days: [], reason: 'not read' }, events: [], sector: null });

  // 1. Classify every holding.
  const rows = holdings.map((h) => ({ h, e: evOf(h), v: classifyHolding(h, evOf(h), capital, now) }));
  const freed = rows.reduce((s, r) => s + (r.v.sellQty > 0 && r.h.ltp ? r.v.sellQty * r.h.ltp : 0), 0);
  let deployable = cash + freed - buffer;
  const deployableBefore = cash - buffer;
  if (deployable <= 0) notes.push(`No cash above the ${PLAN_RULES.cashBufferPct}% buffer (${inr(buffer)} of ${inr(capital)} capital) even after the suggested sales — ADDs and new ideas are shown as a watchlist with no quantity.`);
  else if (freed > 0) notes.push(`Sales in the plan free ${inr(freed)}; the ADDs and new ideas below are funded from cash above the ${PLAN_RULES.cashBufferPct}% buffer including that money — sell first, then buy.`);

  // 2. Size ADDs (strongest first) within the per-idea and weight caps and the deployable cash.
  const addQty = new Map<string, number>();
  for (const r of rows.filter((x) => x.v.addEligible).sort((a, b) => b.v.score - a.v.score)) {
    const price = r.h.ltp as number;
    const room = (PLAN_RULES.maxWeightPct / 100) * capital - price * r.h.qty;
    const amount = Math.min((PLAN_RULES.maxNewIdeaPct / 100) * capital, room, Math.max(0, deployable));
    const qty = Math.floor(amount / price);
    if (qty < 1 || qty * price < PLAN_RULES.minOrderRupees) {
      const byCap = room < Math.max(0, deployable) && room < PLAN_RULES.minOrderRupees + price;
      const why = byCap ? `only ${inr(Math.max(0, room))} of room under the ${PLAN_RULES.maxWeightPct}% weight cap` : `no spare cash above the ${PLAN_RULES.cashBufferPct}% cash buffer`;
      r.v = { ...r.v, recommendation: 'HOLD', addEligible: false, blocked: [why], reasons: [...r.v.reasons, `It passes the ADD rules, but there is ${why} — hold, with the stop below.`] };
      continue;
    }
    addQty.set(r.h.token, qty);
    deployable -= qty * price;
  }

  // 3. New ideas from the screen, funded from what is left.
  const heldSymbols = new Set(holdings.map((h) => baseSym(h.symbol)));
  const sectorWeights = new Map<string, number>();
  for (const r of rows) {
    if (!r.e.sector || !r.h.ltp || !(capital > 0)) continue;
    sectorWeights.set(r.e.sector, (sectorWeights.get(r.e.sector) ?? 0) + ((r.h.ltp * r.h.qty) / capital) * 100);
  }
  const picked = pickIdeas(input.candidates, heldSymbols, sectorWeights, now);
  const ideas: NewIdea[] = [];
  for (const c of picked) {
    const z = entryZone(c.evidence);
    if (!z) continue;
    const amountCap = Math.min((PLAN_RULES.maxNewIdeaPct / 100) * capital, Math.max(0, deployable));
    let qty = Math.floor(amountCap / z.high);
    if (qty * z.high < PLAN_RULES.minOrderRupees) qty = 0;
    deployable -= qty * z.high;
    const e = c.evidence;
    const reasons = [`Price is ${trendWords(e)}.`];
    const ow = oiWords(e);
    if (ow) reasons.push(`The ${ow}${e.oi.status === 'SUPPORTIVE' ? ' supports it' : ''}.`);
    else if (e.oi.status === 'NO_DATA') reasons.push('Futures OI could not be checked this run.');
    if (e.sector) reasons.push((sectorWeights.get(e.sector) ?? 0) > 0 ? `Sector ${e.sector}: you hold ${round1(sectorWeights.get(e.sector) ?? 0)}% of capital there.` : `Sector ${e.sector}: not in your holdings — diversifies the book.`);
    if (e.news === 'POSITIVE') reasons.push(`Recent material news reads positive (context only): “${e.newsItems[0]?.headline ?? ''}”.`);
    reasons.push(qty > 0 ? `Up to ${inr(qty * z.high)} (${qty} shares) — within the ${PLAN_RULES.maxNewIdeaPct}% per-idea cap; buy in the zone, not above it.` : 'No spare cash above the buffer — a watchlist idea for when cash is freed.');
    ideas.push({
      symbol: c.symbol,
      exchange: c.exchange,
      token: c.token,
      sector: e.sector,
      close: e.close as number,
      qty,
      amount: round2(qty * z.high),
      entryLow: z.low,
      entryHigh: z.high,
      stop: z.stop,
      riskRupees: round2(qty * (z.high - z.stop)),
      score: ideaScore(e, !!e.sector && (sectorWeights.get(e.sector) ?? 0) > 0),
      reasons,
      chips: evidenceChips(e),
      evidence: e,
    });
  }

  // 4. Assemble holding actions + before → after weights.
  const pct = (v: number) => (capital > 0 ? round1((v / capital) * 100) : 0);
  const actions: HoldingAction[] = rows.map(({ h, e, v }) => {
    const price = h.ltp;
    const add = addQty.get(h.token) ?? 0;
    const rec: Recommendation = add > 0 ? 'ADD' : v.recommendation;
    const qtyAfter = h.qty - v.sellQty + add;
    const ps = price ? protectiveStop(price, e.atr14) : null;
    const value = price !== null ? price * h.qty : null;
    return {
      symbol: h.symbol,
      exchange: h.exchange,
      token: h.token,
      recommendation: rec,
      qty: rec === 'ADD' ? add : rec === 'TRIM' || rec === 'EXIT' ? v.sellQty : h.qty,
      heldQty: h.qty,
      ltp: price,
      value: value !== null ? round2(value) : null,
      cashImpact: price ? round2(add * price - v.sellQty * price) : 0,
      stop: rec === 'EXIT' || !ps ? null : ps.stop,
      stopBasis: rec === 'EXIT' ? 'exit — no stop needed' : ps ? ps.basis : 'no price',
      pnl: h.pnl,
      pnlPct: h.pnlPct,
      daysHeld: h.daysHeld,
      weightPct: value !== null ? pct(value) : 0,
      weightAfterPct: price !== null ? pct(qtyAfter * price) : 0,
      reasons: v.reasons,
      blocked: v.blocked,
      chips: evidenceChips(e),
      evidence: e,
    };
  });

  const spent = actions.reduce((s, a) => s + Math.max(0, a.cashImpact), 0) + ideas.reduce((s, i) => s + i.amount, 0);
  const cashAfter = cash + freed - spent;
  const weights: WeightRow[] = [
    ...actions.map((a) => ({ symbol: a.symbol, beforePct: a.weightPct, afterPct: a.weightAfterPct })),
    ...ideas.filter((i) => i.qty > 0).map((i) => ({ symbol: i.symbol, beforePct: 0, afterPct: pct(i.amount) })),
  ].sort((a, b) => Math.max(b.beforePct, b.afterPct) - Math.max(a.beforePct, a.afterPct));
  const downBefore = actions.filter((a) => a.evidence.trend === 'DOWN').reduce((s, a) => s + (a.value ?? 0), 0);
  const downAfter = actions.filter((a) => a.evidence.trend === 'DOWN').reduce((s, a) => s + (a.ltp ? a.ltp * (a.heldQty - (a.recommendation === 'TRIM' || a.recommendation === 'EXIT' ? a.qty : 0)) : 0), 0);
  const riskToStops =
    actions.reduce((s, a) => {
      if (!a.ltp || a.stop === null) return s;
      const q = a.heldQty + (a.recommendation === 'ADD' ? a.qty : 0) - (a.recommendation === 'TRIM' ? a.qty : 0);
      return s + q * Math.max(0, a.ltp - a.stop);
    }, 0) + ideas.reduce((s, i) => s + i.riskRupees, 0);

  const sizing: Sizing = {
    balance: input.balance,
    cash: round2(cash),
    holdingsValue: round2(holdingsValue),
    totalCapital: round2(capital),
    cashPctBefore: pct(cash),
    cashPctAfter: pct(cashAfter),
    bufferRupees: round2(buffer),
    freed: round2(freed),
    spent: round2(spent),
    deployableBefore: round2(deployableBefore),
    maxWeightBeforePct: weights.length ? Math.max(...weights.map((w) => w.beforePct)) : 0,
    maxWeightAfterPct: weights.length ? Math.max(...weights.map((w) => w.afterPct)) : 0,
    overCapBefore: weights.filter((w) => w.beforePct > PLAN_RULES.maxWeightPct).length,
    overCapAfter: weights.filter((w) => w.afterPct > PLAN_RULES.maxWeightPct).length,
    downTrendPctBefore: pct(downBefore),
    downTrendPctAfter: pct(downAfter),
    riskToStops: round2(riskToStops),
    weights: weights.slice(0, 15),
    raiseCash: raiseCashList(actions, cashAfter, buffer),
    notes,
  };
  if (sizing.raiseCash) {
    const r = sizing.raiseCash;
    notes.push(
      `Cash is ${inr(r.needed)} short of the ${PLAN_RULES.cashBufferPct}% buffer after this plan. If you want the buffer back, the rules would sell the weakest first: ${r.candidates
        .map((c) => baseSym(c.symbol))
        .join(', ')} (${inr(r.covered)} together) — a choice for you, not part of the actions above.`,
    );
  }

  const counts: Record<Recommendation, number> = { HOLD: 0, ADD: 0, TRIM: 0, EXIT: 0, SET_STOP: 0 };
  for (const a of actions) counts[a.recommendation]++;
  const order: Record<Recommendation, number> = { EXIT: 0, TRIM: 1, SET_STOP: 2, ADD: 3, HOLD: 4 };
  actions.sort((a, b) => order[a.recommendation] - order[b.recommendation] || (b.value ?? 0) - (a.value ?? 0));

  return {
    generatedAt: now.toISOString(),
    rules: { ...PLAN_RULES },
    holdings: actions,
    ideas,
    sizing,
    screen: { ...input.screen, picked: ideas.length },
    brokerCalls: input.brokerCalls,
    counts,
    explanation: EMPTY_SUMMARY,
    disclaimer: PLAN_DISCLAIMER,
    dataNotes: input.dataNotes,
  };
}

/** HFCL-EQ → HFCL (the screen's symbols are base names). */
export function baseSym(symbol: string): string {
  return String(symbol ?? '').trim().toUpperCase().replace(/-(EQ|BE|BZ|BL|SM|ST|IL|E1|N\d|X\d)$/, '');
}

/** One line of the plan for the advisor digest. */
export function actionPlanDigest(p: ActionPlan): string {
  const c = p.counts;
  const s = p.sizing;
  const named = (r: Recommendation) => p.holdings.filter((h) => h.recommendation === r).slice(0, 4).map((h) => baseSym(h.symbol));
  const parts = [
    `Action plan (rule-based, not advice): ${c.EXIT} exit, ${c.TRIM} trim, ${c.ADD} add, ${c.SET_STOP} set-stop, ${c.HOLD} hold`,
    c.EXIT ? `exit ${named('EXIT').join(', ')}` : '',
    c.TRIM ? `trim ${named('TRIM').join(', ')}` : '',
    c.ADD ? `add ${named('ADD').join(', ')}` : '',
  ].filter(Boolean);
  const cash = `cash ${s.balance.status === 'NO_DATA' ? 'unknown' : inr(s.cash)} (${s.cashPctBefore}% → ${s.cashPctAfter}% of ${inr(s.totalCapital)}; buffer ${PLAN_RULES.cashBufferPct}%)`;
  const ideas = p.ideas.length ? `new ideas: ${p.ideas.map((i) => `${i.symbol}${i.qty ? ` ${inr(i.amount)}` : ' (watch)'}`).join(', ')}` : 'no new idea passed the screen';
  return `${parts.join('; ')}; ${cash}; ${ideas}.`;
}
