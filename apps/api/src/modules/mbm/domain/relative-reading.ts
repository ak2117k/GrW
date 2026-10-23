// apps/api/src/modules/mbm/domain/relative-reading.ts
// The MBM RELATIVE reading (2026-10-23), shared by every place an MBM reading is shown or consumed: the
// sentinel packet block, the overnight scorecard's expected-move ('mood') factor, the Night Report mood
// panel and the self-review MBM_RELATIVE verification. PURE.
//
// Why: the model's label is "range above the median of the same minute over the previous 60 sessions".
// In a high-volatility regime nearly every window beats that (2026-10-21/22: 117 of 120), so p sits at the
// 0.97 cap and the regime reads ACTIVE all day — a quiet drift and a spike look the same. The MBM service
// now also compares its own median range forecast (q50) with the realised range at the same minute over
// the last 10 sessions (ai-engine/src/mbm/relative.py): rel_ratio = q50 / ref_range, and a label.
// The old p / regime stays visible, as "vs 60-day norm".

export const REL_LABELS = ['QUIETER', 'NORMAL', 'BUSIER', 'MUCH_BUSIER'] as const;
export type RelLabel = (typeof REL_LABELS)[number];

/** Band edges, identical to ai-engine/src/mbm/relative.py. */
export const QUIETER_BELOW = 0.8;
export const NORMAL_UPTO = 1.25;
export const BUSIER_UPTO = 1.75;

const PHRASE: Record<RelLabel, string> = {
  QUIETER: 'quieter than recent days',
  NORMAL: 'about normal for recent days',
  BUSIER: 'busier than recent days',
  MUCH_BUSIER: 'much busier than recent days',
};

export const isRelLabel = (x: unknown): x is RelLabel => typeof x === 'string' && (REL_LABELS as readonly string[]).includes(x);

/** Same bands as the Python side: < 0.8 QUIETER, ≤ 1.25 NORMAL, ≤ 1.75 BUSIER, else MUCH_BUSIER. */
export function relLabelFor(ratio: number | null | undefined): RelLabel | null {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return null;
  if (ratio < QUIETER_BELOW) return 'QUIETER';
  if (ratio <= NORMAL_UPTO) return 'NORMAL';
  if (ratio <= BUSIER_UPTO) return 'BUSIER';
  return 'MUCH_BUSIER';
}

export function relPhrase(label: string | null | undefined): string | null {
  return isRelLabel(label) ? PHRASE[label] : null;
}

/** The horizon fields this module reads (MbmHorizon, a stored mbm_predictions row, a Night Report view). */
export interface RelativeHorizon {
  p: number;
  regime: string;
  q25Bp?: number | null;
  q50Bp?: number | null;
  q75Bp?: number | null;
  relRatio?: number | null;
  relLabel?: string | null;
  refRangeBp?: number | null;
  /** [q25, q50, q75] in index points, when the MBM service computed them. */
  rangePts?: ReadonlyArray<number | null> | null;
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** [q25, q50, q75] in index points: the service's own, else bp × spot / 1e4; null when neither is possible. */
export function expectedPoints(h: RelativeHorizon, spot: number | null | undefined): [number, number, number] | null {
  const own = h.rangePts;
  if (own && own.length === 3 && own.every(fin)) return [Math.round(own[0] as number), Math.round(own[1] as number), Math.round(own[2] as number)];
  if (!fin(spot) || spot <= 0 || !fin(h.q25Bp) || !fin(h.q50Bp) || !fin(h.q75Bp)) return null;
  const pt = (bp: number) => Math.round((bp * spot) / 1e4);
  return [pt(h.q25Bp), pt(h.q50Bp), pt(h.q75Bp)];
}

/** '30m' → 'Next 30 min', '60m' → 'Next 60 min', anything else → 'Next <key>'. */
function horizonText(key: string): string {
  const m = /^(\d+)m$/i.exec(key.trim());
  return m ? `Next ${m[1]} min` : `Next ${key}`;
}

/**
 * The headline: "Next 30 min: ~80 pts (60–105) · busier than recent days". Falls back to basis points
 * without a spot, and drops the relative part for a prediction made before the relative reading
 * existed. Null when there is no range at all.
 */
export function mbmHeadline(key: string, h: RelativeHorizon, spot?: number | null): string | null {
  const pts = expectedPoints(h, spot);
  let range: string;
  if (pts) range = `~${pts[1]} pts (${pts[0]}–${pts[2]})`;
  else if (fin(h.q25Bp) && fin(h.q50Bp) && fin(h.q75Bp)) range = `~${Math.round(h.q50Bp)} bp (${Math.round(h.q25Bp)}–${Math.round(h.q75Bp)} bp)`;
  else return null;
  const phrase = relPhrase(h.relLabel ?? relLabelFor(h.relRatio));
  return `${horizonText(key)}: ${range}${phrase ? ` · ${phrase}` : ''}`;
}

/** The old reading, kept visible: "vs 60-day norm: BIG / ACTIVE p=0.97". */
export function normLine(h: Pick<RelativeHorizon, 'p' | 'regime'>): string {
  return `vs 60-day norm: ${h.p >= 0.5 ? 'BIG' : 'small'} / ${h.regime} p=${h.p.toFixed(2)}`;
}

/**
 * Was the relative call right? QUIETER → realised < ref; BUSIER / MUCH_BUSIER → realised > ref;
 * NORMAL → realised within [0.8, 1.25] × ref. Null when anything is missing.
 */
export function relativeCallCorrect(label: string | null | undefined, realisedBp: number | null | undefined, refBp: number | null | undefined): boolean | null {
  if (!isRelLabel(label) || !fin(realisedBp) || !fin(refBp) || refBp <= 0) return null;
  const r = realisedBp / refBp;
  if (label === 'QUIETER') return r < 1;
  if (label === 'NORMAL') return r >= QUIETER_BELOW && r <= NORMAL_UPTO;
  return r > 1;
}
