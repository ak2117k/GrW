// MBM M3 stream A §2 (docs/superpowers/plans/2026-10-19-mbm-m3-consumers.md): the exit-discipline
// SHADOW. Pure. Describes, next to the gate's actual decision, what an MBM-sized trail would have
// been. It never feeds back into the decision, and a missing / stale MBM answer never produces a
// would-value — only the reason it is missing.
import { mbmHorizonFor, usableHorizon } from '../../mbm/domain/mbm-applies';
import type { MbmBehaviour } from '../../mbm/services/mbm-client.service';
import type { GateRecordV1 } from '../../exit-discipline/types';

/**
 * The MBM read started by `ExitGateService.load`, filled in when it settles. `decide` is
 * synchronous and must not wait for MBM, so an answer that has not arrived yet is `pending`.
 */
export type MbmShadowSlot = {
  symbol: string;
  instrument: string;
  settled: boolean;
  answer: MbmBehaviour | null;
};

const r2 = (x: number) => Math.round(x * 100) / 100;
const pts = (underlying: number | null, bp: number | null | undefined) =>
  underlying !== null && Number.isFinite(underlying) && typeof bp === 'number' && Number.isFinite(bp) ? r2((underlying * bp) / 10_000) : null;

export type MbmExitShadow =
  | { v: 1; i: string; usable: false; why: 'pending' | 'not-ok' | 'no-minutes'; outcome: string }
  | {
      v: 1;
      i: string;
      usable: true;
      h: '60m' | '30m';
      regime: string;
      p: number;
      asOf: string | null;
      /** q25 / q50 / q75 expected range in bp of the underlying. */
      rangeBp: [number | null, number | null, number | null];
      /** The same in underlying points (null without an underlying price). */
      rangePts: [number | null, number | null, number | null];
      /** Today's noise-sized trail on the underlying: floorTrailN × N_u (null without N_u). */
      noiseTrailPts: number | null;
      /** An MBM-sized trail would be the q50 expected range: how it compares with the noise trail. */
      mbmTrailVsNoise: number | null;
      /** The gate's ACTUAL outcome — the shadow sits beside it, never changes it. */
      outcome: string;
    };

export function mbmExitShadow(slot: MbmShadowSlot, record: GateRecordV1, minutesToClose: number | null): MbmExitShadow {
  const base = { v: 1 as const, i: slot.instrument, outcome: record.outcome };
  if (!slot.settled) return { ...base, usable: false, why: 'pending' };
  if (minutesToClose === null || !Number.isFinite(minutesToClose)) return { ...base, usable: false, why: 'no-minutes' };
  const h = mbmHorizonFor(minutesToClose);
  const hz = usableHorizon(slot.answer, h);
  if (!hz) return { ...base, usable: false, why: 'not-ok' };
  const u = record.facts?.underlying ?? null;
  const nU = record.facts?.nUnderlying ?? null;
  const rangePts: [number | null, number | null, number | null] = [pts(u, hz.q25Bp), pts(u, hz.q50Bp), pts(u, hz.q75Bp)];
  const noiseTrailPts = nU !== null && Number.isFinite(nU) && nU > 0 ? r2(record.cfg.floorTrailN * nU) : null;
  return {
    ...base,
    usable: true,
    h,
    regime: String(hz.regime ?? '').slice(0, 12),
    p: r2(hz.p),
    asOf: slot.answer?.asOf ?? null,
    rangeBp: [hz.q25Bp ?? null, hz.q50Bp ?? null, hz.q75Bp ?? null],
    rangePts,
    noiseTrailPts,
    mbmTrailVsNoise: rangePts[1] !== null && noiseTrailPts ? r2(rangePts[1] / noiseTrailPts) : null,
  };
}

/** The structured `[mbm-exit-shadow] …` log line. */
export function mbmExitShadowLine(s: MbmExitShadow, symbol: string, verdictId: string): string {
  return `[mbm-exit-shadow] ${symbol} verdict ${verdictId} ${JSON.stringify(s)}`;
}
