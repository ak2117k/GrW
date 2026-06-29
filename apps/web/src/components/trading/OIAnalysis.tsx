import { useMemo } from 'react';
import { cn } from '@/utils/cn';
import type { OptionsChainEntry } from '@/types';

interface OIAnalysisProps {
  chain: OptionsChainEntry[];
  spotPrice: number;
}

export default function OIAnalysis({ chain, spotPrice }: OIAnalysisProps) {
  const analysis = useMemo(() => {
    let totalCEOI = 0;
    let totalPEOI = 0;
    let highestCEOI = 0;
    let highestPEOI = 0;
    let highestCEOIStrike = 0;
    let highestPEOIStrike = 0;

    let totalCEVolume = 0;
    let totalPEVolume = 0;
    let highestCEVolume = 0;
    let highestPEVolume = 0;
    let highestCEVolumeStrike = 0;
    let highestPEVolumeStrike = 0;

    for (const entry of chain) {
      if (entry.ceData) {
        totalCEOI += entry.ceData.oi;
        totalCEVolume += entry.ceData.volume;
        if (entry.ceData.oi > highestCEOI) {
          highestCEOI = entry.ceData.oi;
          highestCEOIStrike = entry.strikePrice;
        }
        if (entry.ceData.volume > highestCEVolume) {
          highestCEVolume = entry.ceData.volume;
          highestCEVolumeStrike = entry.strikePrice;
        }
      }
      if (entry.peData) {
        totalPEOI += entry.peData.oi;
        totalPEVolume += entry.peData.volume;
        if (entry.peData.oi > highestPEOI) {
          highestPEOI = entry.peData.oi;
          highestPEOIStrike = entry.strikePrice;
        }
        if (entry.peData.volume > highestPEVolume) {
          highestPEVolume = entry.peData.volume;
          highestPEVolumeStrike = entry.strikePrice;
        }
      }
    }

    // Switch to volume-based analytics when OI is genuinely unavailable
    // (Angel One's optionGreek API doesn't return OI without the paid
    // Market Data subscription). Volume tells a similar story for an
    // intraday view: where the day's flow is concentrated.
    const oiAvailable = totalCEOI > 0 || totalPEOI > 0;
    const totalCE = oiAvailable ? totalCEOI : totalCEVolume;
    const totalPE = oiAvailable ? totalPEOI : totalPEVolume;
    const highestCEStrike = oiAvailable ? highestCEOIStrike : highestCEVolumeStrike;
    const highestPEStrike = oiAvailable ? highestPEOIStrike : highestPEVolumeStrike;

    const pcr = totalCE === 0 ? 0 : totalPE / totalCE;

    // Max pain calculation — uses whichever metric is available.
    let maxPainStrike = 0;
    let minPain = Infinity;
    for (const entry of chain) {
      let totalPain = 0;
      for (const e of chain) {
        const ceMetric = oiAvailable ? (e.ceData?.oi ?? 0) : (e.ceData?.volume ?? 0);
        const peMetric = oiAvailable ? (e.peData?.oi ?? 0) : (e.peData?.volume ?? 0);
        if (e.ceData && entry.strikePrice > e.strikePrice) {
          totalPain += (entry.strikePrice - e.strikePrice) * ceMetric;
        }
        if (e.peData && entry.strikePrice < e.strikePrice) {
          totalPain += (e.strikePrice - entry.strikePrice) * peMetric;
        }
      }
      if (totalPain > 0 && totalPain < minPain) {
        minPain = totalPain;
        maxPainStrike = entry.strikePrice;
      }
    }

    return {
      oiAvailable,
      totalCE,
      totalPE,
      pcr: Math.round(pcr * 100) / 100,
      maxPainStrike,
      highestCEStrike,
      highestPEStrike,
    };
  }, [chain]);

  const pcrInterpretation =
    analysis.pcr === 0
      ? { text: '--', color: 'text-[var(--color-text-muted)]' }
      : analysis.pcr > 1
        ? { text: 'Bullish', color: 'text-[var(--color-accent-green)]' }
        : analysis.pcr < 0.7
          ? { text: 'Bearish', color: 'text-[var(--color-accent-red)]' }
          : { text: 'Neutral', color: 'text-[var(--color-accent-yellow)]' };

  const maxTotal = Math.max(analysis.totalCE, analysis.totalPE, 1);
  const ceBarWidth = (analysis.totalCE / maxTotal) * 100;
  const peBarWidth = (analysis.totalPE / maxTotal) * 100;
  // Label switches to "Volume" when OI is genuinely unavailable so the
  // user knows what the numbers represent rather than seeing zeros.
  const metricLabel = analysis.oiAvailable ? 'OI' : 'Volume';
  const dataNote = analysis.oiAvailable
    ? null
    : 'OI not available — showing volume-based view (intraday flow proxy)';

  if (chain.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
        <p className="text-xs text-[var(--color-text-muted)]">
          No OI data available
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
          {analysis.oiAvailable ? 'OI Analysis' : 'Volume Analysis'}
        </h3>
        {dataNote && (
          <span
            title={dataNote}
            className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--color-text-muted)]"
          >
            volume mode
          </span>
        )}
      </div>

      {dataNote && (
        <p className="text-[10px] leading-snug text-[var(--color-text-muted)]">
          {dataNote}
        </p>
      )}

      {/* Max Pain */}
      {analysis.maxPainStrike > 0 ? (
        <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3">
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
            Max Pain {analysis.oiAvailable ? '' : '(volume-derived)'}
          </div>
          <div className="mt-1 text-xl font-bold text-[var(--color-accent-yellow)]">
            {analysis.maxPainStrike.toLocaleString('en-IN')}
          </div>
          {spotPrice > 0 && (
            <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
              Spot is {spotPrice > analysis.maxPainStrike ? 'above' : 'below'} max pain by{' '}
              {Math.abs(spotPrice - analysis.maxPainStrike).toLocaleString('en-IN')} pts
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3 text-[10px] text-[var(--color-text-muted)]">
          Max pain unavailable (need OI or per-strike volume)
        </div>
      )}

      {/* PCR */}
      <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              Put/Call Ratio ({metricLabel})
            </div>
            <div className="mt-1 text-lg font-bold text-[var(--color-text-primary)]">
              {analysis.pcr === 0 ? '--' : analysis.pcr.toFixed(2)}
            </div>
          </div>
          <span className={cn('text-xs font-semibold', pcrInterpretation.color)}>
            {pcrInterpretation.text}
          </span>
        </div>
      </div>

      {/* CE/PE Comparison Bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[10px] text-[var(--color-text-muted)]">
          <span>Total CE {metricLabel}</span>
          <span>Total PE {metricLabel}</span>
        </div>
        <div className="flex gap-1">
          <div className="flex h-5 flex-1 justify-end overflow-hidden rounded-l bg-[var(--color-bg-tertiary)]">
            <div
              className="h-full rounded-l bg-[var(--color-accent-green)]/30 transition-all duration-500"
              style={{ width: `${ceBarWidth}%` }}
            />
          </div>
          <div className="flex h-5 flex-1 overflow-hidden rounded-r bg-[var(--color-bg-tertiary)]">
            <div
              className="h-full rounded-r bg-[var(--color-accent-red)]/30 transition-all duration-500"
              style={{ width: `${peBarWidth}%` }}
            />
          </div>
        </div>
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-[var(--color-accent-green)]">
            {formatLargeNum(analysis.totalCE)}
          </span>
          <span className="text-[var(--color-accent-red)]">
            {formatLargeNum(analysis.totalPE)}
          </span>
        </div>
      </div>

      {/* Support / Resistance */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-2">
          <div className="text-[10px] text-[var(--color-text-muted)]">
            Resistance (Highest CE {metricLabel})
          </div>
          <div className="mt-1 text-sm font-bold text-[var(--color-accent-green)]">
            {analysis.highestCEStrike > 0
              ? analysis.highestCEStrike.toLocaleString('en-IN')
              : '--'}
          </div>
        </div>
        <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-2">
          <div className="text-[10px] text-[var(--color-text-muted)]">
            Support (Highest PE {metricLabel})
          </div>
          <div className="mt-1 text-sm font-bold text-[var(--color-accent-red)]">
            {analysis.highestPEStrike > 0
              ? analysis.highestPEStrike.toLocaleString('en-IN')
              : '--'}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatLargeNum(val: number): string {
  if (val >= 10_000_000) return (val / 10_000_000).toFixed(2) + ' Cr';
  if (val >= 100_000) return (val / 100_000).toFixed(2) + ' L';
  if (val >= 1_000) return (val / 1_000).toFixed(1) + ' K';
  return val.toLocaleString('en-IN');
}
