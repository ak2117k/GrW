import { useEffect, useRef, useState } from 'react';
import { cn } from '@/utils/cn';
import { ArrowUp, ArrowDown } from 'lucide-react';

export interface PriceHeaderProps {
  ltp: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  open: number;
  loading?: boolean;
}

const fmt = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dash = '—';

export default function PriceHeader({
  ltp,
  change,
  changePct,
  high,
  low,
  open,
  loading,
}: PriceHeaderProps) {
  const hasPrice = ltp > 0;
  const up = change >= 0;

  // Brief background flash whenever the LTP changes — self-contained, clears
  // itself via a timeout. Skips the very first render so it doesn't flash on mount.
  const prevLtp = useRef<number>(ltp);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    if (prevLtp.current !== ltp && hasPrice) {
      setFlash(ltp >= prevLtp.current ? 'up' : 'down');
      const t = setTimeout(() => setFlash(null), 350);
      prevLtp.current = ltp;
      return () => clearTimeout(t);
    }
    prevLtp.current = ltp;
  }, [ltp, hasPrice]);

  return (
    <div
      className={cn(
        'rounded-md border border-gray-700/50 bg-gray-800/80 px-3 py-2.5 transition-colors duration-300',
        flash === 'up' && 'bg-emerald-500/10',
        flash === 'down' && 'bg-red-500/10',
        loading && 'opacity-70',
      )}
    >
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
            LTP
          </div>
          <div className="text-2xl font-semibold leading-tight text-[var(--color-text-primary)]">
            {hasPrice ? `₹${fmt(ltp)}` : dash}
          </div>
        </div>
        {hasPrice ? (
          <div
            className={cn(
              'flex items-center gap-1 text-sm font-medium',
              up ? 'text-emerald-400' : 'text-red-400',
            )}
          >
            {up ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
            <span>
              {up ? '+' : ''}
              {fmt(change)}
            </span>
            <span className="text-xs">
              ({up ? '+' : ''}
              {changePct.toFixed(2)}%)
            </span>
          </div>
        ) : (
          <div className="text-sm text-gray-500">{dash}</div>
        )}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        {(
          [
            ['Open', open],
            ['High', high],
            ['Low', low],
          ] as const
        ).map(([label, val]) => (
          <div key={label} className="flex flex-col">
            <span className="text-gray-500">{label}</span>
            <span className="font-medium text-gray-300">
              {val > 0 ? `₹${fmt(val)}` : dash}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
