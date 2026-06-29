/**
 * Cautionary / surveillance-stock helpers (Phase A — pure & stateless).
 *
 * Indian exchanges place certain stocks under surveillance frameworks
 * (ASM / GSM / ESM) and the Trade-to-Trade (T2T) segment. T2T scrips are
 * delivery-only: intraday / MIS orders are blocked by the broker. Angel
 * One rejects such orders with a "cautionary listings" message.
 *
 * NSE encodes T2T membership in the trading-symbol series suffix:
 *   -EQ  → normal rolling segment
 *   -BE  → Trade-to-Trade (delivery-only, surveillance)
 *   -BZ  → Trade-to-Trade (delivery-only, surveillance, additional)
 *
 * These functions are pure — no DB, no broker calls. Phase B will layer a
 * persisted ASM/GSM/ESM list on top (consulted in the controller), but the
 * series-suffix heuristic stands alone and needs no state.
 */

export interface SeriesCautionaryResult {
  cautionary: boolean;
  reason: string;
  deliveryOnly: boolean;
}

const NOT_CAUTIONARY: SeriesCautionaryResult = {
  cautionary: false,
  reason: '',
  deliveryOnly: false,
};

/** Trailing NSE series suffixes that mark a Trade-to-Trade (delivery-only) scrip. */
const T2T_SERIES = new Set(['BE', 'BZ']);

/**
 * Classify a stock from its Angel One trading-symbol series suffix.
 *
 * Case-insensitive. Handles symbols with no suffix and nullish input.
 * Only a *trailing* `-XX` suffix is treated as the series — mid-symbol
 * text (e.g. "BERGEPAINT-EQ") never trips the flag.
 */
export function seriesCautionary(tradingsymbol: string): SeriesCautionaryResult {
  if (!tradingsymbol || typeof tradingsymbol !== 'string') {
    return { ...NOT_CAUTIONARY };
  }

  const trimmed = tradingsymbol.trim();
  const dash = trimmed.lastIndexOf('-');
  if (dash < 0) return { ...NOT_CAUTIONARY };

  const series = trimmed.slice(dash + 1).toUpperCase();
  if (T2T_SERIES.has(series)) {
    return {
      cautionary: true,
      reason: 'Trade-to-Trade (delivery-only)',
      deliveryOnly: true,
    };
  }

  return { ...NOT_CAUTIONARY };
}

/**
 * Patterns that, when found in a broker rejection message, indicate a
 * surveillance / cautionary / delivery-only block (as opposed to an
 * ordinary rejection like insufficient funds or an invalid quantity).
 *
 * ASM/GSM/ESM use word boundaries so they don't false-match substrings
 * like "PLASMA" or "phantasm". The trade-to-trade pattern tolerates the
 * common separators (space / hyphen).
 */
const SURVEILLANCE_PATTERNS: RegExp[] = [
  /cautionary/i,
  /surveillance/i,
  /trade.?to.?trade/i,
  /\bASM\b/i,
  /\bGSM\b/i,
  /\bESM\b/i,
  /delivery only/i,
  /not allowed in this product/i,
];

/**
 * True when a broker rejection message indicates a surveillance /
 * cautionary / delivery-only block. Safe for null/undefined input.
 */
export function isSurveillanceRejection(
  message: string | null | undefined,
): boolean {
  if (!message || typeof message !== 'string') return false;
  return SURVEILLANCE_PATTERNS.some((re) => re.test(message));
}

/** The actionable guidance appended to a cautionary rejection message. */
export const CAUTIONARY_HINT_SUFFIX =
  ' — This stock is delivery-only (exchange surveillance). ' +
  'Switch Product to DELIVERY and retry.';

/**
 * Return the original rejection message with a clear, actionable suffix
 * telling the user to switch to DELIVERY. Idempotent — calling it on an
 * already-hinted message returns the message unchanged (no double-append).
 */
export function cautionaryHint(originalMessage: string): string {
  const original = originalMessage ?? '';
  if (original.includes(CAUTIONARY_HINT_SUFFIX.trim())) {
    return original;
  }
  return `${original}${CAUTIONARY_HINT_SUFFIX}`;
}
