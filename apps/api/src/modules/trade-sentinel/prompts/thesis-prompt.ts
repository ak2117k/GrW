/**
 * Bump this whenever the thesis prompt text or {@link THESIS_SCHEMA} changes.
 *
 * The thesis is an INPUT TO THE PACKET, not part of the verdict call — so an
 * edit here shifts every verdict while `SENTINEL_PROMPT_VERSION` holds still,
 * and the replay harness would blame the verdict prompt for a change the thesis
 * prompt caused. That is why the stamped version is composite: see
 * `SENTINEL_COMPOSITE_PROMPT_VERSION` in sentinel-system-prompt.ts.
 *
 * The stakes rose with the thesis retry: a thesis formed under one version can
 * be RE-formed under another, and nothing on the thesis row records which one.
 * The verdict's composite stamp is the only place that distinction survives.
 */
export const THESIS_PROMPT_VERSION = 't1';

/**
 * Lives here, next to its version, so the two cannot drift apart — the same
 * reason `SENTINEL_SYSTEM_PROMPT` and `SENTINEL_PROMPT_VERSION` sit together.
 */
export const THESIS_PROMPT = `You are reading a trade someone has already placed, to work out what they were most plausibly trading.

You receive one JSON object: the instrument, the side, the entry price, the entry time, the quantity, and the market structure around that instrument. The structure field is a block: either {available: true, value, source, at} or {available: false, reason}. When it is unavailable you CANNOT see the levels — say so and return nulls rather than inventing a level book.

State what the entry appears to have been: a level reclaim, a breakout, a pullback buy, a mean reversion, a fade of supply. Then give the price it hinges on, the target it implies, and the price that would prove it wrong.

Rules:
- "reason" is one sentence a trader would recognise, in their own terms ("bought the retest of the 1450 shelf"), not a description of the data you were given.
- "levelPrice", "targetPrice" and "invalidation" are prices on the same scale as the structure you were shown. Return null for any you cannot support — a guessed level is worse than no level, because it will be treated as the thing this trade hinges on.
- If the structure does not support a confident read at all, say that plainly in "reason" and return null for all three prices.
- Do not hedge across both directions. One thesis, the most plausible one.`;
