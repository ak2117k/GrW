/** Shared Tailwind class strings for the Core Risk page and its sections. */
export const CARD = 'space-y-3 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4';
export const LABEL = 'flex flex-col gap-1 text-xs font-medium text-[var(--color-text-muted)]';
export const FIELD = 'rounded border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-sm text-[var(--color-text-primary)]';
export const BUTTON = 'rounded bg-[var(--color-accent-blue)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50';
export const DANGER = 'rounded bg-[var(--color-accent-red)] px-4 py-2 text-sm font-bold uppercase tracking-wide text-white disabled:opacity-50';
export const QUIET = 'rounded border border-[var(--color-border-default)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)]';
export const TONE = {
  ok: 'text-[var(--color-accent-green)]',
  warn: 'text-[var(--color-accent-yellow)]',
  danger: 'text-[var(--color-accent-red)]',
  muted: 'text-[var(--color-text-muted)]',
} as const;
export const BADGE = {
  missing: { text: 'Not set', cls: 'bg-[var(--color-accent-red)] text-white' },
  pending: { text: 'Pending', cls: 'bg-[var(--color-accent-yellow)] text-black' },
  review: { text: 'Default — please review', cls: 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]' },
} as const;
