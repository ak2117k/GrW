/**
 * Human label for a trade's strategy. Telegram-signal paper trades all share the internal key
 * TELEGRAM_SIGNAL_NO_FUNDS (filters across the API depend on it), which read as "no funds" even
 * when the real cause was a live gate (e.g. the price 56% off the call), the AI judge skipping it,
 * or the live allowlist. Since 2026-11-12 the API tags the real cause as `paper-why:<key>`.
 */
export const TELEGRAM_PAPER_STRATEGY = 'TELEGRAM_SIGNAL_NO_FUNDS';
const PAPER_WHY_TAG = 'paper-why:';

const GATE_LABELS: Record<string, string> = {
  entry_tolerance: 'price off the call',
  sl_side: 'SL on wrong side',
  sl_enforceable: 'SL not enforceable',
};

const FIXED: Record<string, string> = {
  ENGINE_ENTRY: 'Entry engine',
  REENTRY_WATCH: 'Re-entry watch',
  // A real-money Telegram signal entry (signal_orders), shown on the Live journal.
  TELEGRAM_SIGNAL: 'Telegram signal',
};

/** The short reason for a `paper-why:` key, e.g. 'gate-entry_tolerance' → 'price off the call'. */
export function paperWhyLabel(key: string): string {
  if (key === 'no-funds') return 'no funds';
  if (key === 'broker-funds') return 'broker: no margin';
  if (key === 'paper-mode') return 'paper mode';
  if (key === 'ai-skip') return 'AI skipped';
  if (key.startsWith('gate-')) {
    const g = key.slice(5);
    return GATE_LABELS[g] ?? `gate: ${g.replace(/_/g, ' ')}`;
  }
  if (key === 'route-live_underlying') return 'not on live list';
  if (key === 'route-delayed_no_room') return 'late call, no room left';
  if (key.startsWith('route-')) return `live route: ${key.slice(6).replace(/_/g, ' ')}`;
  return 'paper';
}

export function strategyLabel(strategy: string, entryTags?: readonly string[] | null): string {
  if (strategy === TELEGRAM_PAPER_STRATEGY) {
    const why = (entryTags ?? []).find((t) => t.startsWith(PAPER_WHY_TAG));
    // Rows before 2026-11-12 carry no cause: say "Telegram paper", not the misleading "no funds".
    return why ? `Telegram paper · ${paperWhyLabel(why.slice(PAPER_WHY_TAG.length))}` : 'Telegram paper';
  }
  if (FIXED[strategy]) return FIXED[strategy];
  return strategy
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
