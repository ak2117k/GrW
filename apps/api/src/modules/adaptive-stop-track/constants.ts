// Adaptive-Stop track settings (v1 — tunable constants; calibrate ATR_MULT/bounds
// against scripts/cf-real-candles.mjs). See the design spec.
export const STARTING_BALANCE = 80_00_000; // ₹80L paper account (same as ungated, for comparability)
export const MAX_CONCURRENT = 40;
export const TRADE_COOLDOWN_MS = 45 * 60_000;
export const PROFIT_TARGET_PCT = 0.02;     // 2% from fill (same as gated/ungated)

export const RISK_PER_TRADE = 800;         // ₹ risked per trade (≈ the 0.4%-of-₹2L the gated track implies)
export const ATR_MULT = 1.2;               // stop = ATR_MULT × intraday ATR(14, 5m)
export const MIN_STOP_PCT = 0.8;           // floor on stop distance (% of entry)
export const MAX_STOP_PCT = 2.5;           // cap on stop distance (% of entry)
export const GRACE_MS = 2 * 60_000;        // no stop honored in the first 2 minutes after entry

// --- Trailing give-back (post-partial) ---
// ATR-based, replacing the old flat 0.5% that shook winners out on noise: across
// the exit-leak study, 64% of flat-trail exits went on to hit target after we
// were stopped (avg +2.65% left on the table). Calibrate alongside ATR_MULT via
// scripts/cf-real-candles.mjs.
export const TRAIL_ATR_MULT = 1.0;         // give-back = TRAIL_ATR_MULT × intraday ATR(14, 5m)
export const TRAIL_MIN_PCT = 0.6;          // floor on give-back (% of high-water)
export const TRAIL_MAX_PCT = 1.5;          // cap on give-back (% of high-water)

// --- Decision Gate (CORE2) ---
// Post-score structural filter: take the entry only if price is AT support and
// NOT extended. The score gate was non-predictive (rewarded extension); this
// adds the experienced-trader read. Forward-validated on this track's history
// (held-out: 50% win / +₹373/trade vs ungated 31% / −₹5,075). Toggle off to A/B.
export const DECISION_GATE_ENABLED = true;
export const GATE_NEAR_SUPPORT_PCT = 0.6;  // entry within this % above a support level
export const GATE_RSI_HOT = 70;            // RSI(15m) >= this = extended
export const GATE_VWAP_EXT_PCT = 1.5;      // entry > this % above session VWAP = extended
export const GATE_SR_LOOKBACK_DAYS = 5;    // 15m candle window for swing-pivot support
// Higher-timeframe trend filter: also require the 15m MACD histogram bullish at
// entry. In-sample the slow (15m) MACD was the only momentum signal that worked
// (48% win / +₹7,900 bullish vs 35% / −₹3,402 bearish); the fast 1m/5m MACD is
// noise. Experimental — the adaptive track is the sandbox; toggle to A/B.
export const GATE_REQUIRE_15M_MACD = true;
// Harden the gate's 15m data fetch: a transient Angel feed/REST blip used to make
// the gate fail OPEN (admit anything) on the first failure. Retry a few times
// before giving up, so a momentary gap doesn't silently switch the gate off.
export const GATE_FETCH_ATTEMPTS = 3;
export const GATE_RETRY_MS = 400;
// A usable 15m series needs at least this many bars; fewer → retry (the fetch
// likely came back partial), then let the gate decide skip vs evaluate.
export const GATE_MIN_CANDLES = 10;
