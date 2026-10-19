import type { NightReportSummary, Section, SectionError } from '@/types/nightReport.types';

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
