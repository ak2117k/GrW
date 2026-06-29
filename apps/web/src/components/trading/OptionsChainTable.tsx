import { useMemo } from 'react';
import { cn } from '@/utils/cn';
import type { OptionsChainEntry, OptionData } from '@/types';

interface OptionsChainTableProps {
  chain: OptionsChainEntry[];
  spotPrice: number;
  onTradeClick?: (option: {
    strike: number;
    type: 'CE' | 'PE';
    ltp: number;
    symbol?: string;
  }) => void;
}

function formatNum(val: number | undefined | null, decimals = 2): string {
  if (val === undefined || val === null || val === 0) return '-';
  if (decimals === 0) return val.toLocaleString('en-IN');
  return val.toFixed(decimals);
}

function formatOI(val: number): string {
  if (!val) return '-';
  if (val >= 10_000_000) return (val / 10_000_000).toFixed(1) + 'Cr';
  if (val >= 100_000) return (val / 100_000).toFixed(1) + 'L';
  if (val >= 1_000) return (val / 1_000).toFixed(1) + 'K';
  return val.toLocaleString('en-IN');
}

/** Cell for OI with intensity-based highlighting */
function OICell({ value, maxOI }: { value: number; maxOI: number }) {
  const intensity = maxOI > 0 ? Math.min(value / maxOI, 1) : 0;
  return (
    <td
      className="px-2 py-1.5 text-right font-mono text-xs"
      style={{
        backgroundColor:
          intensity > 0.3
            ? `rgba(59, 130, 246, ${intensity * 0.15})`
            : undefined,
      }}
    >
      <span
        className={cn(
          'text-[var(--color-text-secondary)]',
          intensity > 0.6 && 'font-semibold text-[var(--color-text-primary)]',
        )}
      >
        {formatOI(value)}
      </span>
    </td>
  );
}

export default function OptionsChainTable({
  chain,
  spotPrice,
  onTradeClick,
}: OptionsChainTableProps) {
  // Find the ATM strike (closest to spot price)
  const atmStrike = useMemo(() => {
    if (chain.length === 0 || spotPrice <= 0) return 0;
    let closest = chain[0].strikePrice;
    let minDiff = Math.abs(chain[0].strikePrice - spotPrice);
    for (const entry of chain) {
      const diff = Math.abs(entry.strikePrice - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        closest = entry.strikePrice;
      }
    }
    return closest;
  }, [chain, spotPrice]);

  // Find max OI for intensity scaling
  const maxOI = useMemo(() => {
    let max = 0;
    for (const entry of chain) {
      if (entry.ceData && entry.ceData.oi > max) max = entry.ceData.oi;
      if (entry.peData && entry.peData.oi > max) max = entry.peData.oi;
    }
    return max;
  }, [chain]);

  if (chain.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
        <p className="text-sm text-[var(--color-text-muted)]">
          No options chain data available. Select an underlying and expiry.
        </p>
      </div>
    );
  }

  const handleClick = (strike: number, type: 'CE' | 'PE', data: OptionData | null) => {
    if (!onTradeClick || !data) return;
    onTradeClick({ strike, type, ltp: data.ltp });
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-[var(--color-border-subtle)]">
            {/* CE side header */}
            <th colSpan={7} className="bg-[var(--color-bg-tertiary)] px-3 py-2 text-center text-xs font-semibold uppercase tracking-wider text-[var(--color-accent-green)]">
              Calls (CE)
            </th>
            {/* Strike header */}
            <th className="bg-[var(--color-bg-primary)] px-3 py-2 text-center text-xs font-semibold uppercase tracking-wider text-[var(--color-accent-yellow)]">
              Strike
            </th>
            {/* PE side header */}
            <th colSpan={7} className="bg-[var(--color-bg-tertiary)] px-3 py-2 text-center text-xs font-semibold uppercase tracking-wider text-[var(--color-accent-red)]">
              Puts (PE)
            </th>
          </tr>
          <tr className="border-b border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
            {/* CE columns */}
            <th className="px-2 py-1.5 text-right text-[10px] font-medium">OI</th>
            <th className="px-2 py-1.5 text-right text-[10px] font-medium">OI Chg</th>
            <th className="px-2 py-1.5 text-right text-[10px] font-medium">Volume</th>
            <th className="px-2 py-1.5 text-right text-[10px] font-medium">IV %</th>
            <th className="px-2 py-1.5 text-right text-[10px] font-medium">LTP</th>
            <th className="px-2 py-1.5 text-right text-[10px] font-medium">Chg</th>
            <th className="px-2 py-1.5 text-right text-[10px] font-medium">{'\u0394'}</th>
            {/* Strike */}
            <th className="bg-[var(--color-bg-primary)] px-3 py-1.5 text-center text-[10px] font-medium">
              Strike
            </th>
            {/* PE columns (mirrored) */}
            <th className="px-2 py-1.5 text-left text-[10px] font-medium">{'\u0394'}</th>
            <th className="px-2 py-1.5 text-left text-[10px] font-medium">Chg</th>
            <th className="px-2 py-1.5 text-left text-[10px] font-medium">LTP</th>
            <th className="px-2 py-1.5 text-left text-[10px] font-medium">IV %</th>
            <th className="px-2 py-1.5 text-left text-[10px] font-medium">Volume</th>
            <th className="px-2 py-1.5 text-left text-[10px] font-medium">OI Chg</th>
            <th className="px-2 py-1.5 text-left text-[10px] font-medium">OI</th>
          </tr>
        </thead>
        <tbody>
          {chain.map((entry) => {
            const isATM = entry.strikePrice === atmStrike;
            const isCEITM = spotPrice > 0 && entry.strikePrice < spotPrice;
            const isPEITM = spotPrice > 0 && entry.strikePrice > spotPrice;

            return (
              <tr
                key={entry.strikePrice}
                className={cn(
                  'border-b border-[var(--color-border-subtle)] transition-colors hover:bg-[var(--color-bg-card)]/50',
                  isATM && 'ring-1 ring-inset ring-[var(--color-accent-yellow)]/50 bg-[var(--color-accent-yellow)]/5',
                )}
              >
                {/* CE side */}
                <OICell value={entry.ceData?.oi ?? 0} maxOI={maxOI} />
                <td className={cn(
                  'px-2 py-1.5 text-right font-mono text-xs',
                  (entry.ceData?.oiChange ?? 0) > 0
                    ? 'text-[var(--color-accent-green)]'
                    : (entry.ceData?.oiChange ?? 0) < 0
                      ? 'text-[var(--color-accent-red)]'
                      : 'text-[var(--color-text-muted)]',
                )}>
                  {formatOI(entry.ceData?.oiChange ?? 0)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-xs text-[var(--color-text-secondary)]">
                  {formatOI(entry.ceData?.volume ?? 0)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-xs text-[var(--color-text-muted)]">
                  {formatNum(entry.ceData?.iv, 1)}
                </td>
                <td
                  className={cn(
                    'px-2 py-1.5 text-right font-mono text-xs font-semibold cursor-pointer hover:underline',
                    isCEITM
                      ? 'bg-[var(--color-accent-blue)]/8 text-[var(--color-text-primary)]'
                      : 'text-[var(--color-text-primary)]',
                  )}
                  onClick={() => handleClick(entry.strikePrice, 'CE', entry.ceData)}
                >
                  {formatNum(entry.ceData?.ltp)}
                </td>
                <td className={cn(
                  'px-2 py-1.5 text-right font-mono text-xs',
                  'text-[var(--color-text-muted)]',
                )}>
                  {/* Change would need previous close — show dash for now */}
                  -
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-xs text-[var(--color-accent-blue)]">
                  {formatNum(entry.ceData?.delta, 2)}
                </td>

                {/* Strike price center column */}
                <td
                  className={cn(
                    'border-x border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-center font-mono text-xs font-bold',
                    isATM
                      ? 'text-[var(--color-accent-yellow)]'
                      : 'text-[var(--color-text-primary)]',
                  )}
                >
                  {entry.strikePrice.toLocaleString('en-IN')}
                </td>

                {/* PE side (mirrored) */}
                <td className="px-2 py-1.5 text-left font-mono text-xs text-[var(--color-accent-blue)]">
                  {formatNum(entry.peData?.delta, 2)}
                </td>
                <td className="px-2 py-1.5 text-left font-mono text-xs text-[var(--color-text-muted)]">
                  -
                </td>
                <td
                  className={cn(
                    'px-2 py-1.5 text-left font-mono text-xs font-semibold cursor-pointer hover:underline',
                    isPEITM
                      ? 'bg-[var(--color-accent-red)]/8 text-[var(--color-text-primary)]'
                      : 'text-[var(--color-text-primary)]',
                  )}
                  onClick={() => handleClick(entry.strikePrice, 'PE', entry.peData)}
                >
                  {formatNum(entry.peData?.ltp)}
                </td>
                <td className="px-2 py-1.5 text-left font-mono text-xs text-[var(--color-text-muted)]">
                  {formatNum(entry.peData?.iv, 1)}
                </td>
                <td className="px-2 py-1.5 text-left font-mono text-xs text-[var(--color-text-secondary)]">
                  {formatOI(entry.peData?.volume ?? 0)}
                </td>
                <td className={cn(
                  'px-2 py-1.5 text-left font-mono text-xs',
                  (entry.peData?.oiChange ?? 0) > 0
                    ? 'text-[var(--color-accent-green)]'
                    : (entry.peData?.oiChange ?? 0) < 0
                      ? 'text-[var(--color-accent-red)]'
                      : 'text-[var(--color-text-muted)]',
                )}>
                  {formatOI(entry.peData?.oiChange ?? 0)}
                </td>
                <OICell value={entry.peData?.oi ?? 0} maxOI={maxOI} />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
