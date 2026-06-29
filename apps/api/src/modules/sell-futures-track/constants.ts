/**
 * SELL-Futures track constants.
 * See docs/superpowers/specs/2026-06-27-sell-futures-track-design.md §Constants.
 */

// Short profit target: target = entry × (1 − PROFIT_TARGET_PCT).
export const PROFIT_TARGET_PCT = 0.02;

// Short hard stop: SL = entry × (1 + HARD_STOP_PCT). First tuning lever → ~0.01.
export const HARD_STOP_PCT = 0.004;

// Intraday EOD square-off (IST).
export const EOD_SQUAREOFF_IST = '15:15';

// Sizing — one lot per trade (quantity = lotSize).
export const LOTS_PER_TRADE = 1;

// Flat paper margin estimate: per-trade margin = notional × MARGIN_PCT.
export const MARGIN_PCT = 0.2;

// Paper margin pool (₹40,00,000).
export const PAPER_MARGIN_POOL = 4_000_000;

// Max simultaneously open short-future positions.
export const MAX_OPEN_POSITIONS = 25;

// Re-entry cooldown on the same futures token after its last execution (45 min).
export const TRADE_COOLDOWN_MS = 45 * 60_000;

// Roll to the next monthly expiry when within this many days of the nearest one.
export const ROLL_DAYS = 3;
