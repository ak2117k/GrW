// MBM M3 stream A (docs/superpowers/plans/2026-10-19-mbm-m3-consumers.md §A.1): the compact
// `marketBehaviour` packet block. Pure — the packet service does the I/O and the flag handling.
// PROMPT NOT UPDATED (deliberately): M3 deploys MBM_PACKET=observe, under which the judge never sees
// the block, and the system prompt is a hash-versioned matrix (sentinel-system-prompt.ts) that one more
// switch would double. Add the reading line, with its own prompt version, when MBM_PACKET=on is planned.
import { mbmHorizonFor, usableHorizon } from '../../mbm/domain/mbm-applies';
import type { MbmBehaviour } from '../../mbm/services/mbm-client.service';

/**
 * What the judge sees, kept terse for token cost (the whole Block stays ≤ MBM_BLOCK_MAX_CHARS):
 * `{"i":"NIFTY","h":"60m","regime":"ACTIVE","p":0.86,"rangeBp":[37,68],"asOf":"09:45"}` —
 * instrument, horizon (from session minutes left), the model's regime and its probability, the
 * q25–q75 expected range in basis points of the underlying, and the model's IST hh:mm as-of.
 */
export type MarketBehaviourValue = {
  i: string;
  h: '60m' | '30m';
  regime: string;
  p: number;
  rangeBp: [number | null, number | null];
  asOf: string | null;
};

/** The `source` of the block. Short on purpose: it is repeated in every packet the judge reads. */
export const MBM_BLOCK_SOURCE = 'mbm';
/** Budget for JSON.stringify of the whole Block (value + source + at). */
export const MBM_BLOCK_MAX_CHARS = 200;

const bp = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : null);

/** IST hh:mm of an ISO instant, or null when it is missing or unparseable. */
export function istHhmm(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 330 * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * The block's value, or null when there is nothing usable to say (stale / absent / missing horizon /
 * non-finite p, or no session minutes to pick a horizon from). A null never becomes a block.
 */
export function marketBehaviourValue(
  b: MbmBehaviour | null | undefined,
  instrument: string,
  minutesLeftInSession: number | null,
): MarketBehaviourValue | null {
  if (minutesLeftInSession === null || !Number.isFinite(minutesLeftInSession)) return null;
  const h = mbmHorizonFor(minutesLeftInSession);
  const hz = usableHorizon(b, h);
  if (!hz) return null;
  return {
    i: instrument,
    h,
    // Bounded: a model-supplied string must not blow the block's character budget.
    regime: String(hz.regime ?? '').slice(0, 12),
    p: Math.round(hz.p * 100) / 100,
    rangeBp: [bp(hz.q25Bp), bp(hz.q75Bp)],
    asOf: istHhmm(b?.asOf ?? null),
  };
}
