import type { ReactNode } from 'react';
import clsx from 'clsx';

/**
 * Shared card shell for the StockOverviewPanel. All seven cards drop into
 * this same chrome so the panel reads as a coherent stack rather than a
 * grab-bag of one-off components. The optional `action` slot is for the
 * top-right link/badge ("View full chain →", "Coming soon", etc.).
 */
export function Card({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'rounded-lg border border-zinc-800 bg-zinc-900/50 p-4',
        className,
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-zinc-300">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

/**
 * Compact label/value pair used in LiveQuoteCard and similar dense rows.
 */
export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-sm text-zinc-200 tabular-nums">{value}</div>
    </div>
  );
}

/**
 * Format a raw INR number into a compact Indian-style label.
 *
 *   ≥ 1e13  → "₹X.XX L Cr"   (lakh crore, used for the largest caps —
 *                              Reliance, TCS, HDFC Bank etc.)
 *   ≥ 1e7   → "₹X,XXX Cr"     (crore, the default for most listed stocks)
 *   else    → "₹X,XX,XXX"     (Indian-locale grouping)
 *
 * Returns "—" for null/undefined/non-finite — the card can render the
 * dash directly without doing its own null check.
 */
export function formatINR(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 1e13) {
    return `₹${(value / 1e13).toFixed(2)} L Cr`;
  }
  if (value >= 1e7) {
    return `₹${Math.round(value / 1e7).toLocaleString('en-IN')} Cr`;
  }
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}
