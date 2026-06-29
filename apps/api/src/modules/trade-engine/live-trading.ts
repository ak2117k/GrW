/**
 * Hard backstop for real-money order placement.
 *
 * Even when a per-order `isPaper:false` reaches the executor AND a live broker
 * adapter is wired, NO real order is sent to the broker unless this env flag is
 * explicitly set. It is paper-safe by default: any value other than the literal
 * string "true" (including unset) keeps live placement disabled.
 *
 * This gate guards only ORDER-OPENING writes (entry order + auto-stop-loss).
 * Risk-reducing writes (closing a live position, cancelling an order) are
 * intentionally NOT gated so an open live position can always be exited even if
 * the flag is later switched off.
 */
export function isLiveTradingEnabled(): boolean {
  return process.env.LIVE_TRADING_ENABLED === 'true';
}

export const LIVE_TRADING_DISABLED_MESSAGE =
  'Live trading is disabled (LIVE_TRADING_ENABLED is not "true"). ' +
  'Set LIVE_TRADING_ENABLED=true to allow real orders.';
