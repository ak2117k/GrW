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
  const age = formatAge(Math.max(0, now - at));
  if (meta.source === 'nse') return { label: `NSE · ${age}`, tone: 'legacy' };
  if (meta.status === 'market-closed') return { label: `Closed · ${IST_HM.format(at)} snapshot`, tone: 'closed' };
  if (meta.status === 'stale') return { label: `Stale · ${age}`, tone: 'stale' };
  if (meta.source === 'hub') return { label: `Live · ${age}`, tone: 'live' };
  return { label: `Updated ${age} ago`, tone: 'legacy' };
}

/** The server's status decides the cadence: no client-side market-hours guess (no holidays, no MCX). */
export function chainPollMs(status: string | null | undefined): number {
  return status === 'market-closed' ? CHAIN_CLOSED_POLL_MS : CHAIN_POLL_MS;
}
