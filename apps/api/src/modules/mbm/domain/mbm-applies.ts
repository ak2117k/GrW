// apps/api/src/modules/mbm/domain/mbm-applies.ts
// Which MBM answer applies to a position or entry (design §10.4). Shared by every M3 consumer —
// the sentinel packet block, the exit-discipline shadow log and the trade-core entry gate — so all
// three agree on "is this a NIFTY trade, and which horizon".
import type { MbmBehaviour, MbmHorizon } from '../services/mbm-client.service';

/**
 * The MBM instrument for a traded symbol, or null. v1: the index itself and its index options /
 * futures (NFO/BFO trading symbols start with the underlying). Stocks, other indices and MCX → null
 * (using the index regime as a proxy for stocks is research, not v1).
 */
export function mbmInstrumentFor(
  t: { symbol?: string | null; exchange?: string | null },
  instruments: readonly string[],
): string | null {
  const sym = String(t.symbol ?? '').trim().toUpperCase();
  const ex = String(t.exchange ?? '').trim().toUpperCase();
  if (!sym) return null;
  for (const inst of instruments) {
    const u = inst.toUpperCase();
    if ((ex === 'NSE' || ex === '') && (sym === u || sym === `${u} 50` || sym === `${u}50`)) return u;
    // NIFTY27OCT2625000CE, NIFTY26OCTFUT — but not BANKNIFTY…, FINNIFTY…, NIFTYNXT50…, MIDCPNIFTY…
    if ((ex === 'NFO' || ex === 'BFO') && sym.startsWith(u) && /^\d/.test(sym.slice(u.length))) return u;
  }
  return null;
}

/** Intraday horizon by session time left (design §10.4): ≥ 60 min → 60m, else 30m. */
export function mbmHorizonFor(minutesLeftInSession: number): '60m' | '30m' {
  return minutesLeftInSession >= 60 ? '60m' : '30m';
}

/** The usable horizon answer, or null — `stale`/`absent`/missing never count as a signal. */
export function usableHorizon(b: MbmBehaviour | null | undefined, horizon: string): MbmHorizon | null {
  if (!b || b.status !== 'ok') return null;
  const h = b.horizons?.[horizon];
  return h && Number.isFinite(h.p) ? h : null;
}
