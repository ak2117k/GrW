import type { SourceState } from '@/hooks/useChartContext';
import { sanitizeReason } from './tradePlanView';

/**
 * ONE derivation of the projection zones, consumed twice: by the chart (which
 * draws the entry box and its target) and by the Setup & Context card (which
 * states the same numbers in words). Pure and exported so the "chart and card
 * can never disagree" rule is unit-testable in a repo with no DOM test harness
 * — same pattern as `tradePlanView.ts` / `buildSRView.ts`.
 *
 * The rule this file exists to enforce: a projection is only as good as the
 * history behind it, so a percentage is NEVER rendered without its sample size
 * and its scope, and an absent history renders as "no measured history yet" —
 * never as a blank, a 0%, or a number nobody measured.
 */

// ---------------------------------------------------------------------------
// Wire shape (§3.5 of the projection-zones design). Server-side contract —
// field names are load-bearing, do not rename.
// ---------------------------------------------------------------------------

export interface HitRate {
  /** 0–100. */
  pct: number;
  /** Resolved observations behind `pct`. A pct without this is not reportable. */
  sample: number;
  scope: 'symbol' | 'cohort';
}

export interface ProjectionBox {
  side: 'UP' | 'DOWN';
  state: 'armed' | 'confirmed';
  /** Broken level — the box's near edge. */
  breakLevel: number;
  /** Entry region. nearEdge is always the side closest to breakLevel. */
  entryNear: number;
  entryFar: number;
  stop: number;
  target: number;
  targetSource: 'ZONE' | 'EVIDENCE' | 'POC' | 'VALUE_AREA' | 'MAX_PAIN' | 'ATR';
  cappedByHtf: boolean;
  rr: number;
  /** null = no measured history yet. NEVER a fabricated number. */
  hitRate: HitRate | null;
  reason: string;
}

export interface ProjectionZones {
  up: ProjectionBox | null;
  down: ProjectionBox | null;
}

// ---------------------------------------------------------------------------
// Colours. Hue encodes direction exactly as it does everywhere else on this
// chart: green = up/support, red = down/resistance (`ChartZoneOverlay.baseColor`,
// `tradePlanView.SUPPORT_COLOR`/`RESISTANCE_COLOR`). We modulate ALPHA to
// express armed-vs-confirmed, never hue — a hue change would read as a
// direction change.
// ---------------------------------------------------------------------------

export const UP_COLOR = '#22c55e';
export const DOWN_COLOR = '#ef4444';

/** Alpha suffixes follow ChartZoneOverlay's convention (`cc` / `66`). */
const ARMED_EDGE_ALPHA = '66';
const CONFIRMED_FILL_ALPHA = '33';
const ARMED_FILL_ALPHA = '1a';

/** Card-side opacity for the whole block. Armed is a claim not yet earned. */
const CONFIRMED_OPACITY = 1;
const ARMED_OPACITY = 0.55;

export interface ProjectionBoxStyle {
  /** Full-strength hue for the side. */
  base: string;
  /** Box border. */
  edgeColor: string;
  /** Box interior — the card's background, the chart's band tint. */
  fillColor: string;
  /** The target line. Always the full hue: it is the claim being made. */
  targetColor: string;
  /** lightweight-charts LineStyle: 0 = solid, 1 = dotted, 2 = dashed. */
  edgeLineStyle: 0 | 2;
  edgeLineWidth: 1 | 2;
  /**
   * True for `armed`. Exposed separately so the card can dash a CSS border
   * without re-deriving the rule from `state`.
   */
  dashed: boolean;
  opacity: number;
}

export interface ProjectionBoxView {
  side: 'UP' | 'DOWN';
  state: 'armed' | 'confirmed';
  /** `Break above 24,630 — confirmed`. */
  headline: string;
  /** `24,630 – 24,672`, the region where entry still clears the R:R floor. */
  entryText: string;
  stopText: string;
  targetText: string;
  rrText: string;
  /** Why THAT price. An ATR fallback is labelled as a fallback, never as structure. */
  targetSourceText: string;
  /** `63% · 41 breaks · SBIN`, or `no measured history yet`. Never blank. */
  hitRateText: string;
  /** False when `hitRate` was null — lets the card mute the text rather than hide it. */
  hasMeasuredHistory: boolean;
  /** Sanitized sentence, with the HTF-cap clause folded in when it applies. */
  reason: string;
  cappedByHtf: boolean;
  style: ProjectionBoxStyle;
  /** The SAME wire object the chart draws from. No parallel arithmetic. */
  box: ProjectionBox;
}

export type ProjectionZonesView =
  /** No response yet for this symbol/timeframe. */
  | { kind: 'loading' }
  /** The projection source failed — we do not know, and must not claim "nothing". */
  | { kind: 'unavailable'; message: string }
  /** At least one side has an enterable box. */
  | { kind: 'boxes'; up: ProjectionBoxView | null; down: ProjectionBoxView | null }
  /** Ran, nothing qualified. Stated in words. */
  | { kind: 'none'; message: string };

export interface DeriveProjectionZonesInput {
  /** Undefined = the server predates the field; treated as absent, not as empty. */
  zones: ProjectionZones | null | undefined;
  /** `sources.projections` — 'failed' means "we don't know", not "nothing". */
  source: SourceState | undefined;
  /** True while the first chart-context response is still in flight. */
  loading: boolean;
  /** Names the symbol scope in the hit-rate text. */
  symbol?: string | null;
  /** Names the cohort scope in the hit-rate text. */
  exchange?: string | null;
}

/** A drawn horizontal line, in the shape the overlay hands to lightweight-charts. */
export interface ProjectionBoxLine {
  /**
   * `break` and `entryFar` are the two box edges; `target` is deliberately a
   * SEPARATE line so the enterable region and the projection can never be read
   * as one shape.
   */
  role: 'break' | 'entryFar' | 'stop' | 'target';
  side: 'UP' | 'DOWN';
  value: number;
  color: string;
  lineWidth: 1 | 2;
  /** 0 = solid, 1 = dotted, 2 = dashed. */
  lineStyle: 0 | 1 | 2;
  label: string;
  axisLabelVisible: boolean;
}

function fmtPrice(n: number): string {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
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

/** The one honest answer when nothing has been measured. */
export const NO_HISTORY_TEXT = 'no measured history yet';

/**
 * The most important string in this slice.
 *
 * `null` is a legitimate, common answer — a symbol the platform has not
 * watched break yet has no history, and saying so is the honest output. It
 * must never collapse to an empty string (reads as a missing field) or to 0%
 * (reads as "this never works").
 *
 * When a percentage IS available it always travels with its sample size and
 * its scope, because "63%" alone is unreadable: 63% of 41 breaks on this
 * symbol and 63% of 2,140 breaks across a cohort are different claims, and the
 * trader is the one who has to tell them apart.
 */
export function formatHitRate(
  hitRate: HitRate | null | undefined,
  symbol?: string | null,
  exchange?: string | null,
): string {
  if (!hitRate) return NO_HISTORY_TEXT;
  const { pct, sample, scope } = hitRate;
  // A sample of zero cannot support a percentage, whatever the server sent.
  if (!Number.isFinite(pct) || !Number.isFinite(sample) || sample <= 0) {
    return NO_HISTORY_TEXT;
  }
  const breaks = `${fmtCount(sample)} ${sample === 1 ? 'break' : 'breaks'}`;
  const scopeText =
    scope === 'symbol'
      ? (symbol || 'this symbol')
      : `all ${exchange || 'NSE'} equities`;
  return `${Math.round(pct)}% · ${breaks} · ${scopeText}`;
}

/** Why the target sits where it does. The ATR case says "fallback" out loud. */
function targetSourceText(box: ProjectionBox): string {
  switch (box.targetSource) {
    case 'ZONE':
      return 'the next opposing zone';
    case 'EVIDENCE':
      return 'a clustered evidence level';
    case 'POC':
      return 'the volume point of control';
    case 'VALUE_AREA':
      return 'the value-area edge';
    case 'MAX_PAIN':
      return 'the options max-pain strike';
    case 'ATR':
      // A fallback presented as structure is the lie this label prevents.
      return 'an ATR fallback — no structure ahead';
    default:
      return 'structure ahead';
  }
}

function styleFor(box: ProjectionBox): ProjectionBoxStyle {
  const base = box.side === 'UP' ? UP_COLOR : DOWN_COLOR;
  const armed = box.state === 'armed';
  return {
    base,
    // Armed = faded + dashed, confirmed = full + solid. The difference is
    // legible at a glance, which is the requirement: a trader must not have to
    // read a label to know whether the break has actually happened.
    edgeColor: armed ? `${base}${ARMED_EDGE_ALPHA}` : base,
    fillColor: `${base}${armed ? ARMED_FILL_ALPHA : CONFIRMED_FILL_ALPHA}`,
    targetColor: base,
    edgeLineStyle: armed ? 2 : 0,
    edgeLineWidth: armed ? 1 : 2,
    dashed: armed,
    opacity: armed ? ARMED_OPACITY : CONFIRMED_OPACITY,
  };
}

/**
 * A capped target is a materially different claim from an uncapped one — the
 * higher timeframe has a wall in the way and the projection stops there — so
 * it is stated in the reason rather than left to a colour or an icon.
 */
function reasonText(box: ProjectionBox): string {
  const base = sanitizeReason(box.reason);
  if (!box.cappedByHtf) return base;
  const capped = 'Target capped by the higher timeframe.';
  return base ? `${base} ${capped}` : capped;
}

function boxView(
  box: ProjectionBox | null | undefined,
  symbol: string | null | undefined,
  exchange: string | null | undefined,
): ProjectionBoxView | null {
  if (!box) return null;
  // Every price the box draws must be real. One unwarmed number invalidates
  // the whole geometry, so a partial box is dropped rather than half-drawn.
  if (
    !isDrawablePrice(box.breakLevel) ||
    !isDrawablePrice(box.entryNear) ||
    !isDrawablePrice(box.entryFar) ||
    !isDrawablePrice(box.stop) ||
    !isDrawablePrice(box.target)
  ) {
    return null;
  }
  const direction = box.side === 'UP' ? 'above' : 'below';
  const stateWord = box.state === 'confirmed' ? 'confirmed' : 'armed';
  const hitRateText = formatHitRate(box.hitRate, symbol, exchange);
  return {
    side: box.side,
    state: box.state,
    headline: `Break ${direction} ${fmtPrice(box.breakLevel)} — ${stateWord}`,
    entryText: `${fmtPrice(box.entryNear)} – ${fmtPrice(box.entryFar)}`,
    stopText: fmtPrice(box.stop),
    targetText: fmtPrice(box.target),
    rrText: fmtRR(box.rr),
    targetSourceText: targetSourceText(box),
    hitRateText,
    hasMeasuredHistory: hitRateText !== NO_HISTORY_TEXT,
    reason: reasonText(box),
    cappedByHtf: box.cappedByHtf,
    style: styleFor(box),
    box,
  };
}

/**
 * State -> what the chart and card show. Loading and "source failed" are
 * decided BEFORE the boxes are looked at, so an absent answer can never render
 * as a definitive "no break is projected".
 */
export function deriveProjectionZonesView(
  input: DeriveProjectionZonesInput,
): ProjectionZonesView {
  const { zones, source, loading, symbol, exchange } = input;

  if (zones == null && loading) return { kind: 'loading' };

  const up = boxView(zones?.up, symbol, exchange);
  const down = boxView(zones?.down, symbol, exchange);
  if (up || down) return { kind: 'boxes', up, down };

  if (source === 'failed') {
    return { kind: 'unavailable', message: 'Projection zones unavailable right now.' };
  }

  return {
    kind: 'none',
    message: 'No break projection on either side right now.',
  };
}

function linesForBox(view: ProjectionBoxView): ProjectionBoxLine[] {
  const { box, style } = view;
  const tag = box.side === 'UP' ? 'UP' : 'DN';
  return [
    {
      // Near edge — the level that broke. Labelled because it is the number
      // the trader is watching.
      role: 'break',
      side: box.side,
      value: box.breakLevel,
      color: style.edgeColor,
      lineWidth: style.edgeLineWidth,
      lineStyle: style.edgeLineStyle,
      label: `${tag} BREAK ${fmtPrice(box.breakLevel)}`,
      axisLabelVisible: true,
    },
    {
      // Far edge — where entry stops clearing the R:R floor. Same style as the
      // near edge so the two read as one box.
      role: 'entryFar',
      side: box.side,
      value: box.entryFar,
      color: style.edgeColor,
      lineWidth: style.edgeLineWidth,
      lineStyle: style.edgeLineStyle,
      label: `${tag} ENTRY TO ${fmtPrice(box.entryFar)}`,
      axisLabelVisible: true,
    },
    {
      role: 'stop',
      side: box.side,
      value: box.stop,
      color: style.edgeColor,
      lineWidth: 1,
      lineStyle: 1, // dotted: the stop is not part of the box
      label: `${tag} SL ${fmtPrice(box.stop)}`,
      axisLabelVisible: true,
    },
    {
      // Deliberately dashed and NOT an edge of the box: the projection is a
      // claim about where price may go, the box is where you may enter, and
      // conflating the two is exactly the misread this slice prevents. The cap
      // rides in the label because a capped target is a weaker claim.
      role: 'target',
      side: box.side,
      value: box.target,
      color: style.targetColor,
      lineWidth: 2,
      lineStyle: 2,
      label: `${tag} TARGET ${fmtPrice(box.target)}${box.cappedByHtf ? ' (HTF cap)' : ''}`,
      axisLabelVisible: true,
    },
  ];
}

/**
 * The lines the chart draws, from the SAME view the card reads — so a chart
 * showing a box while the card says "unavailable" is not expressible. Loading,
 * failed and empty all draw nothing; only `boxes` produces geometry.
 */
export function projectionBoxLines(view: ProjectionZonesView): ProjectionBoxLine[] {
  if (view.kind !== 'boxes') return [];
  const lines: ProjectionBoxLine[] = [];
  if (view.up) lines.push(...linesForBox(view.up));
  if (view.down) lines.push(...linesForBox(view.down));
  return lines;
}
