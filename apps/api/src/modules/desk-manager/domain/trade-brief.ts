import { BRIEF_MAX_CHARS, type ManagerDecision } from './desk.types';

type Open = Extract<ManagerDecision, { action: 'OPEN' }>;

/** What the executor recorded about the filled OPEN (desk-actions `entry`); every field optional. */
export interface OpenEntryFacts {
  contract?: unknown;
  exchange?: unknown;
  spot?: unknown;
  premium?: unknown;
  premiumSl?: unknown;
  estLoss?: unknown;
  ceiling?: unknown;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const txt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function entryLine(d: Open): string {
  const e = d.entry;
  if (e.type === 'ZONE') return `ZONE ${e.low ?? '?'}–${e.high ?? '?'} on ${d.underlying} (valid ${e.validMin} min)`;
  if (e.type === 'BREAKOUT') {
    const parts = [finite(e.triggerAbove) ? `≥ ${e.triggerAbove}` : null, finite(e.triggerBelow) ? `≤ ${e.triggerBelow}` : null].filter(Boolean);
    return `BREAKOUT ${parts.join(' / ')} on ${d.underlying} (valid ${e.validMin} min)`;
  }
  return `NOW on ${d.underlying}`;
}

/**
 * The trade brief written when a live manager OPEN fills (trade agent exit authority, spec §4.1), composed
 * deterministically from the OPEN decision and the executor's entry facts: underlying, side, entry type and levels,
 * the underlying stop, targets, reason, evidence, the lead (proposalRef). ≤ BRIEF_MAX_CHARS.
 */
export function openBrief(d: Open, decisionId: string, entry: OpenEntryFacts | null = null): string {
  const e = entry ?? {};
  const bullish = d.side !== 'BUY_PE';
  const contract = txt(e.contract);
  const lines = [
    `Desk manager OPEN (decision ${decisionId}): ${d.side} ${d.underlying}${contract ? ` — ${contract}` : ''}, 1 lot, confidence ${d.confidence}.`,
    `Lead: ${d.proposalRef ?? 'the manager\'s own read (no proposal)'}.`,
    `Entry: ${entryLine(d)}${finite(e.spot) ? `; underlying at entry ${e.spot}` : ''}${finite(e.premium) ? `; premium ${e.premium}` : ''}.`,
    `Stop (underlying): ${d.stop.underlying}${finite(e.premiumSl) ? `; premium SL ${e.premiumSl}` : ''}${finite(e.estLoss) ? `; est. 1-lot loss ₹${e.estLoss}${finite(e.ceiling) ? ` (ceiling ₹${e.ceiling})` : ''}` : ''}.`,
    `Targets (underlying): ${d.targets.underlying.join(' / ') || '—'}.`,
    `Wrong if: ${d.underlying} closes a 15m bar ${bullish ? 'below' : 'above'} ${d.stop.underlying}.`,
    `Why: ${d.reason}`,
    d.evidence.length ? `Evidence: ${d.evidence.join('; ')}` : null,
  ].filter((l): l is string => !!l);
  const text = lines.join('\n');
  return text.length > BRIEF_MAX_CHARS ? `${text.slice(0, BRIEF_MAX_CHARS - 1)}…` : text;
}
