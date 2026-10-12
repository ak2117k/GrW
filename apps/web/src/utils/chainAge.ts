/** What a chain response says about itself (GET /api/options/chain → OptionsChainView). */
export interface ChainMeta {
  at?: string | null;
  source?: string | null;
  status?: string | null;
}

export interface ChainBadge {
  label: string;
  tone: 'live' | 'stale' | 'closed' | 'legacy';
}

/** Server-side freshness bound (chain fresh ≤ 15 000 ms); a "fresh" chain older than this is shown as stale. */
export const CHAIN_FRESH_MS = 15_000;
export const CHAIN_POLL_MS = 10_000;
export const CHAIN_CLOSED_POLL_MS = 60_000;

export const CHAIN_TONE_CLASS: Record<ChainBadge['tone'], string> = {
  live: 'text-[var(--color-accent-green)]',
  stale: 'text-[var(--color-accent-yellow)]',
  closed: 'text-[var(--color-text-muted)]',
  legacy: 'text-[var(--color-accent-blue)]',
};

const IST_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

/** Spec §4: every chain shows its age — "Live · 4 s", "Stale · 40 s", "Closed · 15:29 snapshot", "NSE · 9 s". */
export function chainBadge(meta: ChainMeta | null | undefined, now: number): ChainBadge | null {
  if (!meta?.at) return null;
  const at = Date.parse(meta.at);
  if (!Number.isFinite(at)) return null;
  const ageMs = Math.max(0, now - at);
  const age = formatAge(ageMs);
  // The last fetch failed: whatever is on screen is the previous chain, never "Live".
  if (meta.status === 'unavailable') return { label: `Unavailable · last ${age}`, tone: 'stale' };
  if (meta.source === 'nse') return { label: `NSE · ${age}`, tone: 'legacy' };
  if (meta.status === 'market-closed') return { label: `Closed · ${IST_HM.format(at)} snapshot`, tone: 'closed' };
  if (meta.status === 'stale') return { label: `Stale · ${age}`, tone: 'stale' };
  const claimsLive = meta.status === 'fresh' || (meta.source === 'hub' && !meta.status);
  // A chain the server called fresh ages on screen (a preview card fetches once): past 15 s it is stale.
  if (claimsLive && ageMs > CHAIN_FRESH_MS) return { label: `Stale · ${age}`, tone: 'stale' };
  if (meta.source === 'hub') return { label: `Live · ${age}`, tone: 'live' };
  return { label: `Updated ${age} ago`, tone: 'legacy' };
}

/** After a failed fetch the last chain stays on screen; its meta keeps `at` but says it is unavailable. */
export function unavailableMeta(prev: ChainMeta | null | undefined): ChainMeta | null {
  return prev ? { ...prev, status: 'unavailable' } : null;
}

/** The server's status decides the cadence: no client-side market-hours guess (no holidays, no MCX). */
export function chainPollMs(status: string | null | undefined): number {
  return status === 'market-closed' ? CHAIN_CLOSED_POLL_MS : CHAIN_POLL_MS;
}
