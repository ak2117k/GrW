// Breakout-Swing track settings — a BREAKOUT variant of the Anand swing track.
// Entry: stock near a multi-day resistance AND above the prior day's close, then
// a resting limit-buy LIMIT_PCT above the signal price. Management mirrors the
// swing track's 10% target / 10% stop, with a trailing stop armed after +7%.

export const NEAR_RES_PCT = 1.0;        // current price must be within this % BELOW nearest resistance
export const LIMIT_PCT = 1.5;           // resting limit = signalPrice × (1 + LIMIT_PCT/100)
export const TARGET_PCT = 10;           // +10% from fill → TARGET_HIT
export const INIT_STOP_PCT = 10;        // initial hard stop = fill × (1 − INIT_STOP_PCT/100)
export const TRAIL_TRIGGER_PCT = 7;     // arm the trailing stop once the trade is up this %
export const TRAIL_GIVEBACK_PCT = 2;    // trailed stop = highWater × (1 − TRAIL_GIVEBACK_PCT/100)
export const BIG_MOVER_GAIN_PCT = 7;    // if the TRADE is up > this % FROM ENTRY by BIG_MOVER_EXIT_HHMM → lock it. Measured from ENTRY, not prev-day close: breakout entries are already extended on the day, so a prev-close basis force-exited every trade at a tiny gain and made the 10% target unreachable.
export const BIG_MOVER_EXIT_HHMM = '15:15';
// (QUEUED resting limits are GTC — they no longer expire at EOD; they rest until
// filled or cancelled. The former EOD_HHMM/expireQueuedAtEod was removed.)
export const NOTIONAL = 200_000;        // ₹2,00,000 notional per position (mirrors swing)
