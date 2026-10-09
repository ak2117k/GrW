/**
 * StrategyVersion status rules (spec §4.2, plan decision 10). Pure.
 *
 * SP2 runs paper only: DRAFT → PAPER (owner approval), DRAFT|PAPER → RETIRED.
 * LIVE is a stored value from day one (so SP7 needs no migration) but no
 * transition may reach it until SP7. Nothing returns to DRAFT; RETIRED is final.
 */
export const VERSION_STATUSES = ['DRAFT', 'PAPER', 'LIVE', 'RETIRED'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const VERSION_CREATORS = ['OWNER', 'AI'] as const;
export type VersionCreator = (typeof VERSION_CREATORS)[number];

export type TransitionVerdict = { ok: true } | { ok: false; reason: string };

const ALLOWED: Record<VersionStatus, readonly VersionStatus[]> = {
  DRAFT: ['PAPER', 'RETIRED'],
  PAPER: ['RETIRED'],
  LIVE: ['RETIRED'],
  RETIRED: [],
};

export function checkTransition(from: VersionStatus, to: VersionStatus): TransitionVerdict {
  if (to === 'LIVE') return { ok: false, reason: 'LIVE is reserved until SP7; SP2 runs paper only' };
  if (from === to) return { ok: false, reason: `already ${to}` };
  return ALLOWED[from].includes(to) ? { ok: true } : { ok: false, reason: `${from} → ${to} is not allowed` };
}

/** Versions a user may select and enable. LIVE joins this list at SP7. */
export const SELECTABLE_STATUSES: readonly VersionStatus[] = ['PAPER'];

export function isSelectable(status: string): boolean {
  return (SELECTABLE_STATUSES as readonly string[]).includes(status);
}

/** Only a draft changes in place; anything else is immutable (an edit becomes n+1). */
export function isEditable(status: string): boolean {
  return status === 'DRAFT';
}
