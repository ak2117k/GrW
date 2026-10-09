import { INDICES } from '@td/shared/constants';
import type { HubExchange, InstrumentRef } from './hub.types';

/**
 * THE index map for derivative underlyings, keyed by the instrument master's
 * `name` for the index's options and futures. Index rows are NOT in the
 * `instruments` table, so these can never come from a cash lookup (the
 * production warning "resolved … to underlying NIFTY, but no NSE cash/index
 * instrument" was exactly that lookup failing).
 *
 * NIFTY/BANKNIFTY/FINNIFTY/SENSEX come from packages/shared INDICES.
 * MIDCPNIFTY is not in INDICES; its token is the one market-context.service.ts
 * (UNDERLYING_TOKEN_MAP) already uses. `NIFTY MIDCAP 50` (99926025) is a
 * different index and has no options here.
 */
export const INDEX_UNDERLYINGS: Readonly<Record<string, InstrumentRef>> = Object.freeze({
  NIFTY: { exchange: INDICES.NIFTY_50.exchange, token: INDICES.NIFTY_50.token, symbol: INDICES.NIFTY_50.symbol },
  BANKNIFTY: { exchange: INDICES.BANK_NIFTY.exchange, token: INDICES.BANK_NIFTY.token, symbol: INDICES.BANK_NIFTY.symbol },
  FINNIFTY: { exchange: INDICES.FIN_NIFTY.exchange, token: INDICES.FIN_NIFTY.token, symbol: INDICES.FIN_NIFTY.symbol },
  MIDCPNIFTY: { exchange: 'NSE', token: '99926074', symbol: 'MIDCPNIFTY' },
  SENSEX: { exchange: INDICES.SENSEX.exchange, token: INDICES.SENSEX.token, symbol: INDICES.SENSEX.symbol },
});

const DERIVATIVE_EXCHANGES: ReadonlySet<string> = new Set(['NFO', 'BFO', 'MCX']);
/** A strike or expiry is always a digit before CE/PE/FUT; `RELIANCE` must not match. */
const CONTRACT_SUFFIX = /\d(CE|PE|FUT)$/;

/** True for an F&O or commodity contract (which has an underlying); false for cash. */
export function isDerivative(c: { exchange: string; symbol: string }): boolean {
  return DERIVATIVE_EXCHANGES.has(String(c.exchange ?? '').toUpperCase()) || CONTRACT_SUFFIX.test(String(c.symbol ?? '').toUpperCase());
}

/** The two instrument-master reads the resolver needs. */
export interface UnderlyingLookup {
  /** The contract's own master row, filtered by exchange. */
  contract(exchange: string, token: string): Promise<{ name: string | null } | null>;
  /** A cash instrument by exact symbol on one exchange. */
  cash(symbol: string, exchange: string): Promise<{ token: string; symbol?: string | null } | null>;
  /**
   * Optional: the nearest-expiry future of exactly this master name on this
   * exchange. When given, an MCX contract resolves to that future (a commodity
   * option has no cash underlying; it is priced off the future). When omitted,
   * MCX keeps resolving to no ref — the hub's behaviour before this existed.
   */
  future?(name: string, exchange: string): Promise<{ token: string; symbol?: string | null } | null>;
}

export interface ResolvedUnderlying {
  /** The master's underlying name ('NIFTY', 'KEI'); null when the contract is not in the master. */
  name: string | null;
  /** Where the underlying's price lives; null when nothing matches (and always for MCX without a `future` lookup). */
  ref: InstrumentRef | null;
}

/**
 * A derivative's underlying: index names from {@link INDEX_UNDERLYINGS}; stocks
 * from the NSE cash row by the master's name (`NAME-EQ`, then `NAME`); MCX
 * contracts from the nearest future of the SAME name on MCX when the caller
 * supplies `lookup.future`, otherwise none. Lookup failures are thrown, never
 * cached here: the caller decides (a cached failure would blind a position for
 * the process's life).
 */
export async function resolveUnderlying(
  contract: { exchange: string; token: string; symbol: string },
  lookup: UnderlyingLookup,
): Promise<ResolvedUnderlying> {
  const exchange = String(contract.exchange ?? '').toUpperCase();
  const row = await lookup.contract(exchange, contract.token);
  const name = row?.name ? row.name.trim().toUpperCase() : null;
  if (!name) return { name: null, ref: null };
  if (exchange === 'MCX') {
    if (!lookup.future) return { name, ref: null };
    const fut = await lookup.future(name, 'MCX');
    if (!fut?.token) return { name, ref: null };
    return { name, ref: { exchange: 'MCX', token: fut.token, symbol: fut.symbol || name } };
  }
  const index = INDEX_UNDERLYINGS[name];
  if (index) return { name, ref: { ...index } };
  const cashExchange: HubExchange = 'NSE';
  const cash = (await lookup.cash(`${name}-EQ`, cashExchange)) ?? (await lookup.cash(name, cashExchange));
  if (!cash?.token) return { name, ref: null };
  return { name, ref: { exchange: cashExchange, token: cash.token, symbol: cash.symbol || name } };
}
