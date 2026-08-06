import type { ChartContextDto, ChartContextSources } from '@/hooks/useChartContext';
import type { SRLevel } from '@/components/charts/buildSRView';

export interface SrChip {
  text: string;
  /** Non-null only when some (not all) sources failed — rendered as a ⚠ marker. */
  warning: string | null;
}

export interface DeriveSrChipInput {
  /** null until the first chart-context response for these inputs lands. */
  context: ChartContextDto | null;
  /** Live price the levels were measured against; <=0 means no price yet. */
  ltp: number;
  immediateResistance: SRLevel | null;
  immediateSupport: SRLevel | null;
}

function fmtPrice(n: number): string {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtPct(p: number): string {
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
}

function failedSources(sources: ChartContextSources): string[] {
  return (Object.keys(sources) as (keyof ChartContextSources)[]).filter(
    (k) => sources[k] === 'failed',
  );
}

/**
 * Pure state -> chip text for the S/R readout.
 *
 * The bug this exists to prevent: the old inline version saw only an empty
 * level array, so *loading*, *request failed* and *genuinely no levels* all
 * rendered the same definitive "S/R: no levels". Loading and failure are
 * therefore checked BEFORE the levels are even looked at — an absent response
 * can never produce a claim about the market.
 */
export function deriveSrChip(input: DeriveSrChipInput): SrChip {
  const { context, ltp, immediateResistance, immediateSupport } = input;

  if (!context) return { text: 'S/R: loading…', warning: null };
  if (context.status === 'unavailable') return { text: 'S/R: unavailable', warning: null };

  const failed = failedSources(context.sources);
  // `partial` degrades the read but doesn't invalidate it — surface which
  // source is missing rather than hiding levels we do have.
  const warning =
    context.status === 'partial' && failed.length > 0
      ? `Degraded — unavailable: ${failed.join(', ')}`
      : null;

  // No price means nothing to measure distance from; buildSRView returns
  // nothing here, which is not the same as "no levels exist".
  if (!(ltp > 0)) return { text: 'S/R: insufficient data', warning };

  if (!immediateResistance && !immediateSupport) {
    return { text: 'S/R: none in range', warning };
  }

  const r = immediateResistance
    ? `R ${fmtPrice(immediateResistance.price)} (${fmtPct(immediateResistance.distancePct)})`
    : 'R —';
  const s = immediateSupport
    ? `S ${fmtPrice(immediateSupport.price)} (${fmtPct(immediateSupport.distancePct)})`
    : 'S —';
  return { text: `${r} · ${s}`, warning };
}
