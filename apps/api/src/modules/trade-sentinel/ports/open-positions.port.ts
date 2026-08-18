/**
 * The sentinel's read-only view of a user's open trades.
 *
 * WHY A PORT AND NOT `TradeTrackerService`. Stage 0's defining claim is that no
 * order-placing code is REACHABLE from the cycle — not that the cycle chooses
 * not to call one. `TradeTrackerService`'s own surface is read-only, but it
 * holds the Angel One adapter as a collaborator, and that adapter has
 * `placeOrder`, `modifyOrder` and `cancelOrder`. Injecting it therefore puts an
 * order-placing object one property access away from a live cycle instance, and
 * the claim becomes false however carefully the cycle behaves.
 *
 * So the roster depends on this port, and the port's implementation talks to
 * Prisma directly. Delegating to `TradeTrackerService` from inside the
 * implementation would defeat the whole exercise — the adapter would be
 * reachable again, just one hop further away.
 *
 * `sentinel-cycle.service.spec.ts` walks the import graph transitively from the
 * cycle and fails on any module whose name matches an execution/broker pattern,
 * so this is enforced rather than asserted.
 */
export interface OpenPosition {
  id: string;
  symbol: string;
  /**
   * The trade's exchange — 'NSE', 'NFO', 'MCX', 'BFO'.
   *
   * Needed because the roster's remit is F&O ONLY, and `segmentFor` decides that
   * from the exchange first and the tradingsymbol's suffix second. Reading it off
   * the symbol alone is not enough: an NFO contract whose suffix does not parse
   * still belongs to the sentinel, and a cash symbol that happens to end in the
   * letters FUT would not.
   */
  exchange: string;
  /** 'POSITION' or 'HOLDING'. Left as `string`: the roster branches on it and owns that policy. */
  kind: string;
  entryTime: Date | null;
}

export interface OpenPositionsPort {
  listOpen(userId: string): Promise<OpenPosition[]>;
}

/** DI token — `OpenPositionsPort` is an interface and cannot be resolved by type. */
export const OPEN_POSITIONS = 'SENTINEL_OPEN_POSITIONS';

/**
 * Where the sentinel gets its OI walls.
 *
 * Same reasoning as {@link OpenPositionsPort}, one module further out:
 * `OiWallService` lives in signal-generator and reaches the options-chain
 * service, the market feed and from there the Angel One adapter. The snapshot
 * service needs two numbers off a chain, so it asks for exactly that.
 *
 * This is the pattern the module already uses for `ChartContextShim`, `NewsShim`
 * and `TickSource`: narrow, JSON-shaped, and supplied by Task 12's composition
 * root — which is the correct place for a graph that reaches a broker to be
 * assembled, because that is the one place a human is deciding what is wired to
 * what.
 */
export interface OiWallCandidate {
  price: number;
  /** 'OI_CALL' or 'OI_PUT'; other kinds are ignored by the snapshot service. */
  kind: string;
}

export interface OiWallSource {
  /** Walls for `symbol` at the given underlying spot, best-first. Never throws; `[]` when unknown. */
  walls(symbol: string, underlyingLtp: number): Promise<OiWallCandidate[]>;
}

/** DI token — `OiWallSource` is an interface and cannot be resolved by type. */
export const OI_WALL_SOURCE = 'SENTINEL_OI_WALL_SOURCE';
