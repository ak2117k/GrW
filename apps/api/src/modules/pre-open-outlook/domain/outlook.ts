import type { NewsTheme } from '../../entry-engine/domain/news-theme';
import type { GlobalMove } from './global-chart';

/**
 * PRE-OPEN OUTLOOK (owner 2026-11-02: "we should have predicted this in the night"). Deterministic
 * code, no LLM. Per underlying, at 08:30 IST:
 *
 *   price    — the global move since the Indian / MCX last close (WTI for crude, GIFT Nifty or S&P
 *              futures for the indices) × a beta, scaled by a "strong move" size → [−1, 1];
 *   theme    — the news theme score over the window since the last close (≥ 24 h, ≤ 72 h);
 *   headline — "oil falls 1 %"-style moves parsed from headlines: the WEAK fallback, used only
 *              when there is no price.
 *
 *   score      = 0.75·price + 0.25·theme              (price present)
 *              = 0.6·theme + 0.4·headline             (no price; confidence capped at 0.5)
 *   bias       = BULLISH / BEARISH when |score| ≥ 0.3, else NEUTRAL
 *   confidence = min(1, |score|) × 0.6 when price and theme disagree × 0.5 when the price is stale
 *   gap        = global move % × beta, in points off the last close.
 *
 * Every number is a named constant in {@link OUTLOOK}. Pure: no I/O, no clock.
 */

export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface UniverseEntry {
  /** Venue whose holiday calendar / session the outlook is for. */
  venue: 'MCX' | 'NSE';
  /** IST minutes of the venue's open; the last close is the last bar before today's open… */
  openMin: number;
  /** …that lies inside a session (IST minutes ≤ this; MCX 23:55 covers the winter close). Off-session bars are junk. */
  closeMin: number;
  /** Yahoo symbols tried in order for the global move. */
  globals: readonly string[];
  /** Beta of the underlying's % gap per 1 % global move, per global symbol (and GIFT). */
  beta: Readonly<Record<string, number>>;
  /** A gap this size (%) scores ±1. */
  strongMovePct: number;
  method: string;
}

export const OUTLOOK_UNIVERSE: Readonly<Record<string, UniverseEntry>> = Object.freeze({
  CRUDEOIL: {
    venue: 'MCX',
    openMin: 9 * 60,
    closeMin: 23 * 60 + 55,
    globals: ['CL=F', 'BZ=F'],
    beta: { 'CL=F': 1, 'BZ=F': 1 },
    strongMovePct: 1.5,
    method: 'NYMEX WTI (CL=F; Brent BZ=F if WTI is unavailable) % move from the MCX last close to now × beta 1.0 — MCX crude is priced off WTI; the USD/INR change is not applied',
  },
  NIFTY: {
    venue: 'NSE',
    openMin: 9 * 60 + 15,
    closeMin: 15 * 60 + 30,
    globals: ['GIFT', 'ES=F'],
    beta: { GIFT: 1, 'ES=F': 0.5 },
    strongMovePct: 0.75,
    method: 'GIFT Nifty vs the NSE NIFTY near-month future close (market-cues, beta 1.0); S&P 500 futures (ES=F) % move since the NSE close × 0.5 when GIFT is unavailable',
  },
  BANKNIFTY: {
    venue: 'NSE',
    openMin: 9 * 60 + 15,
    closeMin: 15 * 60 + 30,
    globals: ['GIFT', 'ES=F'],
    beta: { GIFT: 1.1, 'ES=F': 0.6 },
    strongMovePct: 0.9,
    method: 'GIFT Nifty gap % × 1.1 (BANKNIFTY ~1.1× NIFTY); S&P 500 futures (ES=F) % since the NSE close × 0.6 when GIFT is unavailable',
  },
});

export const OUTLOOK_ORDER: readonly string[] = Object.freeze(['CRUDEOIL', 'NIFTY', 'BANKNIFTY']);

export const OUTLOOK = Object.freeze({
  priceWeight: 0.75,
  themeWeight: 0.25,
  /** Without a price: theme and headline weights, and the confidence cap (below the engine's 0.6). */
  noPriceThemeWeight: 0.6,
  noPriceHeadlineWeight: 0.4,
  noPriceConfidenceCap: 0.5,
  /** |score| needed for a bias. */
  biasMin: 0.3,
  /** |theme net| that scores ±1 (before the not-material factor). */
  themeFullNet: 0.4,
  themeNotMaterialFactor: 0.5,
  /** Headline-parsed moves count at most this much of a strong move. */
  headlineFactor: 0.5,
  /** A parsed headline % above this is a monthly / weekly recap, capped. */
  headlineCapPct: 5,
  /** Price and theme pointing opposite ways (|theme| ≥ this) cut the confidence. */
  disagreeTheme: 0.2,
  disagreeFactor: 0.6,
  staleFactor: 0.5,
  topHeadlines: 5,
});

// ───────────────────────────── headline moves (weak fallback) ─────────────────────────────

export interface HeadlineMove {
  clusterId: string;
  headline: string;
  direction: 'BULL' | 'BEAR';
  /** The parsed % (capped), or null when the headline gives none. */
  pct: number | null;
}

const BEAR_VERBS = 'falls?|fell|falling|slips?|slipped|slides?|slid|drops?|dropped|declines?|declined|sinks?|sank|tumbles?|tumbled|plunges?|plunged|slumps?|slumped|eases?|eased|retreats?|retreated|softens?|softened|dips?|dipped|lower|down';
const BULL_VERBS = 'rises?|rose|rising|gains?|gained|climbs?|climbed|jumps?|jumped|surges?|surged|soars?|soared|rall(?:y|ies|ied)|spikes?|spiked|firms?|firmed|higher|up';
const CRUDE_MOVE = new RegExp(`\\b(?:oil|crude|brent|wti)(?:\\s+(?:oil|crude|prices?|futures|benchmarks?))*\\s+(${BEAR_VERBS}|${BULL_VERBS})\\b(.{0,30})`, 'i');
const BEAR_RE = new RegExp(`^(?:${BEAR_VERBS})$`, 'i');
const PCT_RE = /(\d+(?:\.\d+)?)\s*(?:%|per\s*cent)/i;

/** "Oil prices fall over 1% as …" → BEAR 1. Crude only (index headlines quote points, not a price we can use). */
export function parseHeadlineMove(underlying: string, clusterId: string, headline: string): HeadlineMove | null {
  if (underlying.toUpperCase() !== 'CRUDEOIL') return null;
  const m = CRUDE_MOVE.exec(headline);
  if (!m) return null;
  const direction = BEAR_RE.test(m[1]) ? 'BEAR' : 'BULL';
  const p = PCT_RE.exec(m[2] ?? '');
  const pct = p ? Math.min(Number(p[1]), OUTLOOK.headlineCapPct) : null;
  return { clusterId, headline: headline.slice(0, 160), direction, pct };
}

/** Median signed % of the parsed moves (a headline without a % counts as 1 %); null for none. */
export function headlineMedianPct(moves: readonly HeadlineMove[]): number | null {
  if (moves.length === 0) return null;
  const xs = moves.map((m) => (m.direction === 'BEAR' ? -1 : 1) * (m.pct ?? 1)).sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// ───────────────────────────── outlook ─────────────────────────────

export interface OutlookHeadline {
  headline: string;
  direction: string;
  magnitude: string;
  confidence: number;
  weight: number;
}

export interface OutlookInput {
  underlying: string;
  /** IST session date the outlook is for (YYYY-MM-DD). */
  sessionDate: string;
  at: Date;
  lastClose: { price: number; at: string } | null;
  /** The global move used (null = none tried); `beta` from the universe for its symbol. */
  move: (GlobalMove & { beta: number }) | null;
  theme: NewsTheme;
  headlineMoves: readonly HeadlineMove[];
}

export interface PreOpenOutlook {
  underlying: string;
  sessionDate: string;
  at: string;
  bias: Bias;
  confidence: number;
  score: number;
  components: { price: number | null; theme: number; headline: number | null };
  lastClose: { price: number; at: string } | null;
  global: (GlobalMove & { beta: number }) | null;
  gap: { pct: number; points: number | null; basis: 'GLOBAL_PRICE' | 'HEADLINES' } | null;
  method: string;
  theme: { side: string | null; material: boolean; net: number; stories: number; sources: number; summary: string };
  headlineMoves: { n: number; medianPct: number | null; items: HeadlineMove[] };
  headlines: OutlookHeadline[];
  summary: string;
}

const clamp = (x: number) => Math.max(-1, Math.min(1, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const signed = (x: number, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;

export function outlookOf(i: OutlookInput): PreOpenOutlook {
  const u = OUTLOOK_UNIVERSE[i.underlying.toUpperCase()];
  const strong = u?.strongMovePct ?? 1;
  const priceUsable = !!i.move && i.move.status !== 'NO_DATA' && i.move.movePct !== null;
  const gapPctGlobal = priceUsable ? r2((i.move!.movePct as number) * i.move!.beta) : null;
  const price = gapPctGlobal !== null ? r3(clamp(gapPctGlobal / strong)) : null;

  const th = i.theme;
  const theme = th.side ? r3((th.side === 'BULLISH' ? 1 : -1) * Math.min(1, Math.abs(th.net) / OUTLOOK.themeFullNet) * (th.material ? 1 : OUTLOOK.themeNotMaterialFactor)) : 0;

  const median = headlineMedianPct(i.headlineMoves);
  const headline = median !== null ? r3(clamp(median / strong) * OUTLOOK.headlineFactor) : null;

  let score: number;
  let confidence: number;
  if (price !== null) {
    score = OUTLOOK.priceWeight * price + OUTLOOK.themeWeight * theme;
    confidence = Math.min(1, Math.abs(score));
    if (Math.abs(theme) >= OUTLOOK.disagreeTheme && Math.sign(theme) !== Math.sign(price) && price !== 0) confidence *= OUTLOOK.disagreeFactor;
    if (i.move!.status === 'STALE') confidence *= OUTLOOK.staleFactor;
  } else {
    score = OUTLOOK.noPriceThemeWeight * theme + OUTLOOK.noPriceHeadlineWeight * (headline ?? 0);
    confidence = Math.min(OUTLOOK.noPriceConfidenceCap, Math.abs(score));
  }
  score = r3(score);
  confidence = r3(confidence);
  const bias: Bias = score >= OUTLOOK.biasMin ? 'BULLISH' : score <= -OUTLOOK.biasMin ? 'BEARISH' : 'NEUTRAL';

  const gapPct = gapPctGlobal ?? (median !== null ? r2(median) : null);
  const gap =
    gapPct === null
      ? null
      : { pct: gapPct, points: i.lastClose ? Math.round((i.lastClose.price * gapPct) / 100) : null, basis: (gapPctGlobal !== null ? 'GLOBAL_PRICE' : 'HEADLINES') as 'GLOBAL_PRICE' | 'HEADLINES' };

  const headlines: OutlookHeadline[] = th.items
    .filter((x) => x.direction !== 'NEUTRAL')
    .slice(0, OUTLOOK.topHeadlines)
    .map((x) => ({ headline: x.headline, direction: x.direction, magnitude: x.magnitude, confidence: x.confidence, weight: x.weight }));

  const parts: string[] = [];
  if (priceUsable) {
    const m = i.move!;
    parts.push(`${m.symbol} ${signed(m.movePct as number)}% since the last close (${m.from?.price} → ${m.to?.price}${m.status === 'STALE' ? `, STALE: ${m.reason}` : ''})`);
  } else parts.push(`no global price (${i.move?.reason ?? 'not available'})`);
  if (gap) parts.push(`gap ≈ ${gap.points !== null ? `${signed(gap.points, 0)} pts ` : ''}(${signed(gap.pct)}%${gap.basis === 'HEADLINES' ? ', from headlines — weak' : ''})${i.lastClose ? ` off ${i.lastClose.price}` : ''}`);
  parts.push(th.summary);
  if (median !== null) parts.push(`headlines: ${i.headlineMoves.length} price move(s), median ${signed(median)}%`);
  const summary = `${i.underlying.toUpperCase()} ${bias} (confidence ${confidence}, score ${signed(score, 3)}): ${parts.join('; ')}`;

  return {
    underlying: i.underlying.toUpperCase(),
    sessionDate: i.sessionDate,
    at: i.at.toISOString(),
    bias,
    confidence,
    score,
    components: { price, theme, headline },
    lastClose: i.lastClose,
    global: i.move,
    gap,
    method: u?.method ?? 'no global price method for this underlying',
    theme: { side: th.side, material: th.material, net: th.net, stories: th.stories, sources: th.sources, summary: th.summary },
    headlineMoves: { n: i.headlineMoves.length, medianPct: median, items: [...i.headlineMoves].slice(0, 10) },
    headlines,
    summary,
  };
}

/** Is a 1-minute bar opening at `tsMs` inside the venue session (IST [openMin, closeMin))? */
export function inSession(tsMs: number, openMin: number, closeMin: number): boolean {
  const d = new Date(tsMs + 5.5 * 3_600_000);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= openMin && m < closeMin;
}

/** The theme window for a pre-open read: back to the last close, at least 24 h, at most 72 h (minutes). */
export function preOpenWindowMin(at: Date, lastCloseAt: Date | null, minMin: number, maxMin: number): number {
  if (!lastCloseAt) return minMin;
  const since = Math.ceil((at.getTime() - lastCloseAt.getTime()) / 60_000);
  return Math.max(minMin, Math.min(maxMin, since));
}

/** One Telegram message for the morning's outlooks. */
export function outlookAlertText(xs: readonly PreOpenOutlook[]): string {
  const lines = xs.map((o) => {
    const g = o.gap ? ` gap ≈ ${o.gap.points !== null ? `${signed(o.gap.points, 0)} pts ` : ''}(${signed(o.gap.pct)}%)` : '';
    const heads = o.headlines.slice(0, 2).map((h) => `  · ${h.direction} ${h.magnitude} ${h.headline.slice(0, 90)}`);
    return [`${o.underlying}: ${o.bias} conf ${o.confidence}${g}${o.lastClose ? ` off ${o.lastClose.price}` : ''}`, `  ${o.global?.status === 'OK' || o.global?.status === 'STALE' ? `${o.global.symbol} ${signed(o.global.movePct ?? 0)}%` : 'no global price'} · ${o.theme.summary.slice(0, 120)}`, ...heads].join('\n');
  });
  return `GrW pre-open outlook ${xs[0]?.sessionDate ?? ''} (observe only — no orders)\n${lines.join('\n')}`;
}
