import type { SourceState, TradePlan, TradeTrigger } from '@/hooks/useChartContext';
import type { AnalysisDto } from '@/components/stock-overview/SetupContextCard';

/**
 * ONE derivation of the trade plan, consumed twice: by the chart (which draws
 * the two trigger prices) and by the Setup & Context card (which reads the
 * same trigger objects). Pure and exported so the "chart and card can never
 * disagree" rule is unit-testable in a repo with no DOM test harness — same
 * pattern as `srChip.ts` / `buildSRView.ts`.
 */

export interface ActiveTradeView {
  side: 'BUY' | 'SELL';
  levelSource: string;
  entryText: string;
  stoplossText: string;
  targetText: string;
  rrText: string;
  /** One letter, the engine's own confidence. Null when the engine gave none. */
  grade: string | null;
  /** Already sanitized: a plain sentence, or '' when nothing safe was given. */
  reason: string;
}

export interface TriggerLineView {
  side: 'BUY' | 'SELL';
  /** 'Above' for the long trigger, 'Below' for the short one. */
  prefix: 'Above' | 'Below';
  triggerPrice: number;
  levelSource: string;
  priceText: string;
  stoplossText: string;
  targetText: string;
  rrText: string;
  /** `Above 24,630 (PDH) → BUY  SL 24,590  T 24,720  1:2.0` */
  text: string;
}

export type TradePlanView =
  /** No response yet for this symbol/timeframe. */
  | { kind: 'loading' }
  /** The plan source failed — we do not know, and must not claim "nothing". */
  | { kind: 'unavailable'; message: string }
  /** A setup is formed right now. */
  | { kind: 'active'; trade: ActiveTradeView }
  /** Nothing formed, but at least one side would trigger if reached. */
  | { kind: 'triggers'; above: TriggerLineView | null; below: TriggerLineView | null }
  /** Nothing on either side. Stated in words — never a debug payload. */
  | { kind: 'none'; message: string };

export interface DeriveTradePlanInput {
  /** Undefined = the server predates the TradePlan field; treated as absent. */
  plan: TradePlan | null | undefined;
  analysis: AnalysisDto | null;
  /** `sources.tradePlan` — 'failed' means "we don't know", not "nothing". */
  source: SourceState | undefined;
  /** True while the first chart-context response is still in flight. */
  loading: boolean;
}

/** A drawn horizontal line, in the shape `LevelOverlay` consumes. */
export interface TradePlanLine {
  type: 'R' | 'S';
  value: number;
  color: string;
  label: string;
}

const RESISTANCE_COLOR = '#ef4444';
const SUPPORT_COLOR = '#22c55e';

function fmtPrice(n: number): string {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** `1:2.0`. One decimal, per the card/chart spec, everywhere. */
function fmtRR(rr: number): string {
  if (!Number.isFinite(rr) || rr <= 0) return '—';
  return `1:${rr.toFixed(1)}`;
}

function isDrawablePrice(n: unknown): n is number {
  // A level book that hasn't warmed reports 0; drawing that collapses the
  // price scale and reads as a real level.
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * The engine's reject reasons carry debug payloads
 * (`reject:confirmation {"type":"ROUND","volumeRatio":0}`). Those are engine
 * internals, not trader-facing text, and shipping one to the card is the exact
 * bug this slice exists to kill — so anything that smells like a payload is
 * dropped entirely rather than rendered.
 */
export function sanitizeReason(reason: string | null | undefined): string {
  if (typeof reason !== 'string') return '';
  const trimmed = reason.trim();
  if (trimmed === '') return '';
  if (/[{}[\]]/.test(trimmed)) return '';
  if (/^\s*reject\s*:/i.test(trimmed)) return '';
  return trimmed;
}

function triggerView(trigger: TradeTrigger, prefix: 'Above' | 'Below'): TriggerLineView | null {
  if (!isDrawablePrice(trigger?.triggerPrice)) return null;
  const priceText = fmtPrice(trigger.triggerPrice);
  const stoplossText = fmtPrice(trigger.stoploss);
  const targetText = fmtPrice(trigger.target);
  const rrText = fmtRR(trigger.rr);
  const levelSource = trigger.levelSource || '—';
  return {
    side: trigger.side,
    prefix,
    triggerPrice: trigger.triggerPrice,
    levelSource,
    priceText,
    stoplossText,
    targetText,
    rrText,
    text: `${prefix} ${priceText} (${levelSource}) → ${trigger.side}  SL ${stoplossText}  T ${targetText}  ${rrText}`,
  };
}

function activeFromTrigger(trigger: TradeTrigger, grade: string | null): ActiveTradeView {
  return {
    side: trigger.side,
    levelSource: trigger.levelSource || '—',
    entryText: fmtPrice(trigger.entry),
    stoplossText: fmtPrice(trigger.stoploss),
    targetText: fmtPrice(trigger.target),
    rrText: fmtRR(trigger.rr),
    grade,
    reason: sanitizeReason(trigger.reason),
  };
}

/**
 * Fallback for a server that has an active setup but no `tradePlan` (older
 * build, or a plan whose `active` slot failed to populate). The numbers come
 * from the same analysis the plan is built from, so the two cannot disagree.
 */
function activeFromAnalysis(analysis: AnalysisDto | null): ActiveTradeView | null {
  if (!analysis || analysis.kind !== 'setup') return null;
  const risk = Math.abs(analysis.entry - analysis.stoploss);
  const reward = Math.abs(analysis.target - analysis.entry);
  return {
    side: analysis.side,
    levelSource: analysis.levelType,
    entryText: fmtPrice(analysis.entry),
    stoplossText: fmtPrice(analysis.stoploss),
    targetText: fmtPrice(analysis.target),
    rrText: risk > 0 ? fmtRR(reward / risk) : '—',
    grade: analysis.grade,
    reason: sanitizeReason(analysis.reason),
  };
}

/**
 * State -> what the card shows. Loading and "source failed" are decided BEFORE
 * the triggers are looked at, so an absent answer can never render as a
 * definitive "nothing is setting up".
 */
export function deriveTradePlanView(input: DeriveTradePlanInput): TradePlanView {
  const { plan, analysis, source, loading } = input;

  if (analysis === null && plan == null && loading) return { kind: 'loading' };

  const grade = analysis?.kind === 'setup' ? analysis.grade : null;

  const active = plan?.active
    ? activeFromTrigger(plan.active, grade)
    : activeFromAnalysis(analysis);
  if (active) return { kind: 'active', trade: active };

  if (source === 'failed') {
    return { kind: 'unavailable', message: 'Trade plan unavailable right now.' };
  }

  const above = plan?.above ? triggerView(plan.above, 'Above') : null;
  const below = plan?.below ? triggerView(plan.below, 'Below') : null;
  if (above || below) return { kind: 'triggers', above, below };

  return { kind: 'none', message: 'No trade set up on either side right now.' };
}

/**
 * The lines the chart draws, from the SAME `TradePlan` fields the card reads.
 * A null side draws nothing — never a fabricated level.
 */
export function tradePlanLines(plan: TradePlan | null | undefined): TradePlanLine[] {
  const lines: TradePlanLine[] = [];
  const above = plan?.above;
  const below = plan?.below;
  if (above && isDrawablePrice(above.triggerPrice)) {
    lines.push({
      type: 'R',
      value: above.triggerPrice,
      color: RESISTANCE_COLOR,
      label: `R ${fmtPrice(above.triggerPrice)} ${above.levelSource || ''}`.trim(),
    });
  }
  if (below && isDrawablePrice(below.triggerPrice)) {
    lines.push({
      type: 'S',
      value: below.triggerPrice,
      color: SUPPORT_COLOR,
      label: `S ${fmtPrice(below.triggerPrice)} ${below.levelSource || ''}`.trim(),
    });
  }
  return lines;
}
