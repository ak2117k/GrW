import type { HoldingTag, Severity } from '@/types/portfolioReview.types';

type Variant = 'success' | 'danger' | 'warning' | 'info' | 'neutral';

/** Whole rupees, en-IN grouping, a real minus sign. */
export function inr(n: number | null | undefined, signed = false): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.round(Math.abs(n)).toLocaleString('en-IN');
  const sign = n < 0 ? '−' : signed && n > 0 ? '+' : '';
  return `${sign}₹${abs}`;
}

export function pct(n: number | null | undefined, signed = false): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : signed && n > 0 ? '+' : '';
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}

export function pnlTone(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return 'text-[var(--color-text-secondary)]';
  return n > 0 ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]';
}

export function severityVariant(s: Severity): Variant {
  return s === 'HIGH' ? 'danger' : s === 'MEDIUM' ? 'warning' : s === 'LOW' ? 'info' : 'success';
}

export function tagVariant(t: HoldingTag): Variant {
  switch (t) {
    case 'DEAD-MONEY':
      return 'danger';
    case 'WEAK-TREND':
      return 'warning';
    case 'CONCENTRATED':
      return 'info';
    case 'STRONG':
      return 'success';
    default:
      return 'neutral';
  }
}

const LABELS: Record<string, string> = {
  CASH_HOLDING: 'Cash holdings (sold)',
  CASH_INTRADAY: 'Cash intraday',
  OPTIONS: 'F&O options',
  FUTURES: 'Futures',
  COMMODITY: 'MCX / commodity',
  AI_EXIT: 'AI exit',
  MANUAL_IN_APP: 'Exit button (app)',
  PRICE_TRIGGER: 'Price trigger',
  EXPIRY: 'Ran into expiry',
  AT_BROKER: 'At the broker',
  PARTIAL_SALE: 'Partial sale',
  INTRADAY: 'Intraday',
  '1-5D': '1–5 days',
  '>5D': 'More than 5 days',
  MANUAL: 'Manual',
  MODEL: 'App / model',
};

/** Human label for a bucket key (segment, closer, holding period …); unknown keys pass through. */
export function bucketLabel(key: string): string {
  return LABELS[key] ?? key;
}

/** 'YYYY-MM' → 'Oct 2026'. */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
