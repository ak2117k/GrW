import type {
  Band,
  FactorName,
  FactorScore,
  IdeaKind,
  NewsIdea,
  NewsIdeaOutcome,
  NightReportSummary,
  PositionRow,
  Section,
  SectionError,
  SymbolRef,
  VerdictView,
} from '@/types/nightReport.types';

/**
 * Pure view logic for the Night Report page. No React, no DOM: Vitest runs it in node.
 */

export { agoLabel } from '@/components/charts/overnightPlanView';

/** A section the API could not build arrives as `{ error }` in place of its payload. */
export function isSectionError<T>(s: Section<T> | null | undefined): s is SectionError {
  return (
    s == null ||
    (typeof s === 'object' && !Array.isArray(s) && typeof (s as { error?: unknown }).error === 'string')
  );
}

// ---------------------------------------------------------------- verdicts

export type VerdictTone = 'ok' | 'warn' | 'bad' | 'muted';

const VERDICT_TONE: Record<string, VerdictTone> = {
  HOLD_OVERNIGHT: 'ok',
  HOLD: 'ok',
  TIGHTEN_AT_OPEN: 'warn',
  EXIT_ARMED: 'warn',
  ESCALATE: 'warn',
  EXIT_AT_OPEN: 'bad',
  EXIT_NOW: 'bad',
};

/** Exit at open = bad, Tighten = warn, Hold = ok; anything unknown is muted, never guessed. */
export function verdictTone(verdict: string | null | undefined): VerdictTone {
  return (verdict && VERDICT_TONE[verdict.toUpperCase()]) || 'muted';
}

const VERDICT_LABEL: Record<string, string> = {
  HOLD_OVERNIGHT: 'Hold',
  HOLD: 'Hold',
  TIGHTEN_AT_OPEN: 'Tighten at open',
  EXIT_AT_OPEN: 'Exit at open',
  EXIT_ARMED: 'Exit armed',
  EXIT_NOW: 'Exit now',
  ESCALATE: 'Escalate',
};

export function verdictLabel(verdict: string | null | undefined): string {
  if (!verdict) return 'Not judged';
  return VERDICT_LABEL[verdict.toUpperCase()] ?? sentenceCase(verdict);
}

/** Tone to the shared `Badge` variant. */
export function toneVariant(tone: VerdictTone): 'success' | 'warning' | 'danger' | 'neutral' {
  return tone === 'ok' ? 'success' : tone === 'warn' ? 'warning' : tone === 'bad' ? 'danger' : 'neutral';
}

const WINDOW_LABEL: Record<string, string> = {
  OVERNIGHT_REVIEW: 'After-close review',
  PRE_OPEN_REVIEW: 'Pre-open review',
  PRE_OPEN_CHECK: 'Pre-open check',
  LIVE: 'Live',
};

export function windowLabel(window: string): string {
  return WINDOW_LABEL[window] ?? sentenceCase(window);
}

// ---------------------------------------------------------------- holdings

/** A delivery holding (tracker kind `HOLDING`): the overnight review skips these by design. */
export function isHolding(p: Pick<PositionRow, 'kind'>): boolean {
  return String(p.kind ?? '').trim().toUpperCase() === 'HOLDING';
}

/**
 * Splits the open trackers into the positions the overnight review judges (F&O,
 * kind `POSITION`, and anything not a holding) and the long-term holdings it never
 * reviews. Order within each list is kept.
 */
export function splitHoldings<T extends Pick<PositionRow, 'kind'>>(rows: T[]): { positions: T[]; holdings: T[] } {
  const positions: T[] = [];
  const holdings: T[] = [];
  for (const r of rows) (isHolding(r) ? holdings : positions).push(r);
  return { positions, holdings };
}

export const HOLDINGS_TITLE = 'Long-term holdings — not reviewed overnight (F&O positions only)';

// ---------------------------------------------------------------- setups

const RIBBON_TAG: Record<string, string> = { '10_30': 'EMA 10/30', '12_26': 'EMA 12/26' };

const SETUP_LABEL: Record<string, string> = {
  BB_LOWER_TOUCH_UPTREND: 'Bollinger lower-band touch in an uptrend',
  BB_BREAKOUT_UP: 'Bollinger upper-band breakout',
  RETEST_20D_LOW_REBOUND: 'Rebound off a retest of the 20-day low',
  GAP_DOWN_REVERSAL: 'Gap-down reversal (closed above the open)',
};

/** A setup code in plain words, e.g. `BB_LOWER_TOUCH_UPTREND` → "Bollinger lower-band touch in an uptrend". */
export function setupLabel(code: string): string {
  const known = SETUP_LABEL[code];
  if (known) return known;
  const ribbon = /^RIBBON_(UP_MACD_GREEN|UP_TREND|DOWN_MACD_RED)_(\d+_\d+)$/.exec(code);
  if (ribbon) {
    const ema = RIBBON_TAG[ribbon[2]] ?? `EMA ${ribbon[2].replace('_', '/')}`;
    if (ribbon[1] === 'UP_MACD_GREEN') return `${ema} cross up with MACD positive`;
    if (ribbon[1] === 'UP_TREND') return `${ema} cross up above the 200-day EMA`;
    return `${ema} cross down with MACD negative`;
  }
  return sentenceCase(code);
}

export function setupActionLabel(action: string): { label: string; variant: 'success' | 'warning' | 'neutral' } {
  if (action === 'LONG_SETUP') return { label: 'Long setup', variant: 'success' };
  if (action === 'EXIT_OR_TIGHTEN_LONGS') return { label: 'Exit or tighten longs', variant: 'warning' };
  return { label: sentenceCase(action), variant: 'neutral' };
}

/** Basis points as a signed percent ("+1.25%"); null (not yet filled) as an em dash. */
export function bpPct(bp: number | null | undefined, digits = 2): string {
  if (bp == null || !Number.isFinite(bp)) return '—';
  const pct = bp / 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
}

// ---------------------------------------------------------------- time (IST)

const IST = 'Asia/Kolkata';

function istParts(iso: string): Record<string, string> | null {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const out: Record<string, string> = {};
  for (const p of parts) out[p.type] = p.value;
  return out;
}

/** "09:15" in IST. */
export function istTime(iso: string | null | undefined): string {
  const p = iso ? istParts(iso) : null;
  return p ? `${p.hour}:${p.minute}` : '—';
}

/** "Tue 20 Oct, 09:15" in IST. */
export function istDateTime(iso: string | null | undefined): string {
  const p = iso ? istParts(iso) : null;
  return p ? `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}` : '—';
}

/** "Tue 20 Oct" in IST. */
export function istDate(iso: string | null | undefined): string {
  const p = iso ? istParts(iso) : null;
  return p ? `${p.weekday} ${p.day} ${p.month}` : '—';
}

// ---------------------------------------------------------------- summary

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "4 positions · 3 Exit at open · 1 held · 12 headlines on your positions · 2 events today". */
export function summaryLine(s: NightReportSummary): string {
  const parts: string[] = [s.positions === 0 ? 'No open positions' : plural(s.positions, 'position', 'positions')];
  if (s.exitAtOpen > 0) parts.push(`${s.exitAtOpen} Exit at open`);
  if (s.tighten > 0) parts.push(`${s.tighten} Tighten`);
  if (s.held > 0) parts.push(`${s.held} held`);
  if (s.positions > 0 || s.newsOnPositions > 0)
    parts.push(`${plural(s.newsOnPositions, 'headline', 'headlines')} on your positions`);
  parts.push(`${plural(s.eventsToday, 'event', 'events')} today`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- misc

export type SentimentTone = 'positive' | 'negative' | 'neutral';

export function sentimentTone(sentiment: string | null, score: number | null): SentimentTone {
  const s = (sentiment ?? '').toLowerCase();
  if (/(pos|bull)/.test(s)) return 'positive';
  if (/(neg|bear)/.test(s)) return 'negative';
  if (score != null && Number.isFinite(score)) {
    if (score > 0.1) return 'positive';
    if (score < -0.1) return 'negative';
  }
  return 'neutral';
}

export function impactVariant(impact: string | null): 'danger' | 'warning' | 'neutral' {
  const i = (impact ?? '').toUpperCase();
  if (i === 'HIGH') return 'danger';
  if (i === 'MEDIUM' || i === 'MED') return 'warning';
  return 'neutral';
}

export function jobVariant(status: string): 'success' | 'warning' | 'danger' {
  return status === 'ok' ? 'success' : status === 'stale' ? 'warning' : 'danger';
}

/** Money in rupees, Indian grouping, sign kept. */
export function rupees(n: number | null | undefined, signed = false): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const sign = n < 0 ? '−' : signed && n > 0 ? '+' : '';
  return `${sign}₹${abs}`;
}

export function sentenceCase(code: string): string {
  const s = String(code ?? '').replace(/_/g, ' ').trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}


/** An external link target only when it is an absolute http(s) URL; anything else (javascript:, data:, relative) is null. */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- scorecard

type BadgeVariant = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

/** Display order of the scorecard table; also the set of factors a scorecard should carry. */
export const FACTOR_ORDER: FactorName[] = ['oi', 'fii_dii', 'vix', 'expiry', 'news', 'indicators', 'mood'];

const FACTOR_LABEL: Record<FactorName, string> = {
  oi: 'Option chain (OI)',
  fii_dii: 'FII / DII',
  vix: 'India VIX',
  expiry: 'Expiry / time decay',
  news: 'News',
  indicators: 'Indicators (EMA 9/20, MACD, RSI)',
  // Key stays `mood` (stored rows); since 2026-10-20 it is the MBM move-size "expected move" factor.
  mood: 'Expected move',
};

export function factorLabel(name: string): string {
  return FACTOR_LABEL[name as FactorName] ?? sentenceCase(name);
}

/**
 * Factors in table order. A factor the API left out is filled in as unavailable (greyed), so
 * the table always shows what was and was not looked at; unknown extra factors go last.
 */
export function orderedFactors(factors: FactorScore[] | null | undefined): FactorScore[] {
  const list = factors ?? [];
  const byName = new Map(list.map((f) => [f.name, f]));
  const known = FACTOR_ORDER.map(
    (name) => byName.get(name) ?? { name, points: 0 as const, value: '', reason: 'Not computed', available: false },
  );
  return [...known, ...list.filter((f) => !FACTOR_ORDER.includes(f.name))];
}

/** −2…+2 as a signed number with a real minus sign; 0 stays "0". */
export function signedPoints(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

export type PointsTone = 'pos' | 'neg' | 'zero';
export function pointsTone(n: number | null | undefined): PointsTone {
  return n == null || !Number.isFinite(n) || n === 0 ? 'zero' : n > 0 ? 'pos' : 'neg';
}

const BAND_LABEL: Record<Band, string> = {
  STRONG_AGAINST: 'Strongly against',
  AGAINST: 'Against',
  NEUTRAL: 'Neutral',
  SUPPORTS: 'Supports',
  STRONG_SUPPORTS: 'Strongly supports',
};
const BAND_VARIANT: Record<Band, BadgeVariant> = {
  STRONG_AGAINST: 'danger',
  AGAINST: 'warning',
  NEUTRAL: 'neutral',
  SUPPORTS: 'info',
  STRONG_SUPPORTS: 'success',
};

export function bandLabel(band: string | null | undefined): string {
  if (!band) return 'No score';
  return BAND_LABEL[band as Band] ?? sentenceCase(band);
}
export function bandVariant(band: string | null | undefined): BadgeVariant {
  return (band && BAND_VARIANT[band as Band]) || 'neutral';
}

/** Which way a band leans for the position: +1 supports, −1 against, 0 neutral/unknown. */
export function bandLean(band: string | null | undefined): -1 | 0 | 1 {
  if (band === 'SUPPORTS' || band === 'STRONG_SUPPORTS') return 1;
  if (band === 'AGAINST' || band === 'STRONG_AGAINST') return -1;
  return 0;
}

/**
 * Which way an agent verdict leans for the position: keeping it (+1) or getting out / cutting
 * risk (−1). Unknown verdicts and ESCALATE lean nowhere (0) and never raise a disagreement.
 */
export function verdictLean(verdict: string | null | undefined): -1 | 0 | 1 {
  const v = (verdict ?? '').toUpperCase();
  if (v === 'HOLD_OVERNIGHT' || v === 'HOLD') return 1;
  if (v.startsWith('EXIT') || v.startsWith('TIGHTEN')) return -1;
  return 0;
}

/**
 * True when the agent's verdict points the other way from the scorecard band: an exit/tighten
 * while the band supports the position, or a hold while the band is against it. Neutral bands
 * and unknown verdicts never disagree.
 */
export function verdictDisagreesWithBand(verdict: string | null | undefined, band: string | null | undefined): boolean {
  const v = verdictLean(verdict);
  const b = bandLean(band);
  return v !== 0 && b !== 0 && v !== b;
}

/** The verdict a scorecard should be compared against: pre-open card → pre-open verdict (else overnight). */
export function verdictForScorecard(p: Pick<PositionRow, 'overnight' | 'preOpen' | 'scorecard'>): VerdictView | null {
  if (p.scorecard?.window === 'PRE_OPEN') return p.preOpen ?? p.overnight;
  return p.overnight ?? p.preOpen;
}

// ---------------------------------------------------------------- news ideas

const IDEA_BADGE: Record<IdeaKind, { label: string; variant: BadgeVariant }> = {
  CE_IDEA: { label: 'CE idea', variant: 'success' },
  PE_IDEA: { label: 'PE idea', variant: 'danger' },
  NO_TRADE: { label: 'No trade', variant: 'neutral' },
};

export function ideaBadge(idea: string | null | undefined): { label: string; variant: BadgeVariant } {
  return IDEA_BADGE[idea as IdeaKind] ?? { label: idea ? sentenceCase(idea) : 'No idea', variant: 'neutral' };
}

/** A news idea names only symbol + exchange; the chip resolves the token on click. */
export function ideaSymbolRef(row: Pick<NewsIdea, 'symbol' | 'exchange'>): SymbolRef {
  const q = new URLSearchParams({ symbol: row.symbol, exchange: row.exchange });
  return { symbol: row.symbol, exchange: row.exchange, token: null, chartHref: `/charts?${q.toString()}` };
}

/** Newest first; unparseable dates sink to the bottom. */
export function sortIdeasNewestFirst<T extends Pick<NewsIdea, 'createdAt'>>(rows: T[]): T[] {
  const t = (s: string) => {
    const n = Date.parse(s);
    return Number.isFinite(n) ? n : -Infinity;
  };
  return [...rows].sort((a, b) => t(b.createdAt) - t(a.createdAt));
}

/**
 * The idea's outcome once the next session filled it: the underlying's move, judged against the
 * idea's direction (CE wants up, PE wants down; No trade is never right or wrong). Null until filled.
 */
export function ideaOutcome(
  row: Pick<NewsIdea, 'idea'> & NewsIdeaOutcome,
): { label: string; verdict: 'right' | 'wrong' | 'flat' | 'none' } | null {
  if (!row.filledAt || row.moveBp == null || !Number.isFinite(row.moveBp)) return null;
  const label = `Next session ${bpPct(row.moveBp)}`;
  const dir = row.idea === 'CE_IDEA' ? 1 : row.idea === 'PE_IDEA' ? -1 : 0;
  if (dir === 0) return { label, verdict: 'none' };
  if (row.moveBp === 0) return { label, verdict: 'flat' };
  return { label, verdict: Math.sign(row.moveBp) === dir ? 'right' : 'wrong' };
}
