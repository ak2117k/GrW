import { useState, useMemo, useCallback } from 'react';
import { Grid3X3, ChevronDown, Activity } from 'lucide-react';
import { cn } from '@/utils/cn';
import { PageLoadingOverlay } from '@/components/common';
import { useOptionsStore } from '@/stores/options-store';
import { useOptionsChain } from '@/hooks/useOptionsChain';
import OptionsChainTable from '@/components/trading/OptionsChainTable';
import ExpirySelector from '@/components/trading/ExpirySelector';
import StrikeSelector from '@/components/trading/StrikeSelector';
import OIAnalysis from '@/components/trading/OIAnalysis';
import OptionPayoffChart from '@/components/trading/OptionPayoffChart';
import AIInsightCard from '@/components/ai/AIInsightCard';

const UNDERLYING_OPTIONS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];

interface PayoffPosition {
  strike: number;
  type: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  premium: number;
  qty: number;
}

export default function OptionsPage() {
  useOptionsChain();

  const chain = useOptionsStore((s) => s.chain);
  const underlying = useOptionsStore((s) => s.underlying);
  const expiry = useOptionsStore((s) => s.expiry);
  const expiries = useOptionsStore((s) => s.expiries);
  const spotPrice = useOptionsStore((s) => s.spotPrice);
  const strikeRange = useOptionsStore((s) => s.strikeRange);
  const isLoading = useOptionsStore((s) => s.isLoading);
  const setUnderlying = useOptionsStore((s) => s.setUnderlying);
  const setExpiry = useOptionsStore((s) => s.setExpiry);
  const setStrikeRange = useOptionsStore((s) => s.setStrikeRange);

  const [showUnderlyingDropdown, setShowUnderlyingDropdown] = useState(false);
  const [payoffPositions, setPayoffPositions] = useState<PayoffPosition[]>([]);

  // Find ATM strike
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

  const pcr = useMemo(() => {
    if (chain.length === 0) return 0;
    let totalCallOI = 0;
    let totalPutOI = 0;
    for (const entry of chain) {
      totalCallOI += entry.ceData?.oi ?? 0;
      totalPutOI += entry.peData?.oi ?? 0;
    }
    return totalCallOI > 0 ? totalPutOI / totalCallOI : 0;
  }, [chain]);

  const optionsContextData = useMemo(() => {
    // Send strikes centered on ATM (±15) so the analysis sees the body of
    // the chain, not the deep-ITM/OTM tail. For a 122-strike NIFTY chain,
    // chain.slice(0, 30) would cover only strikes ~4000 points below spot.
    const atmIdx = atmStrike > 0 ? chain.findIndex((e) => e.strikePrice === atmStrike) : -1;
    const start = atmIdx >= 0 ? Math.max(0, atmIdx - 15) : 0;
    const end = atmIdx >= 0 ? Math.min(chain.length, atmIdx + 16) : Math.min(30, chain.length);
    return {
      underlying,
      expiry,
      spotPrice,
      atmStrike,
      pcr,
      chain: chain.slice(start, end),
      capturedAt: new Date().toISOString(),
    };
  }, [underlying, expiry, spotPrice, atmStrike, pcr, chain]);

  // Filter chain by strike range
  const filteredChain = useMemo(() => {
    if (strikeRange === 0 || chain.length === 0 || atmStrike === 0) return chain;
    const atmIdx = chain.findIndex((e) => e.strikePrice === atmStrike);
    if (atmIdx < 0) return chain;
    const start = Math.max(0, atmIdx - strikeRange);
    const end = Math.min(chain.length, atmIdx + strikeRange + 1);
    return chain.slice(start, end);
  }, [chain, strikeRange, atmStrike]);

  const handleTradeClick = useCallback(
    (option: { strike: number; type: 'CE' | 'PE'; ltp: number }) => {
      setPayoffPositions((prev) => [
        ...prev,
        {
          strike: option.strike,
          type: option.type,
          side: 'BUY',
          premium: option.ltp,
          qty: 1,
        },
      ]);
    },
    [],
  );

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-3">
          <Grid3X3 size={22} className="text-[var(--color-accent-blue)]" />
          <h1 className="text-xl font-bold text-[var(--color-text-primary)]">
            Options Chain
          </h1>
        </div>

        {/* Underlying selector dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowUnderlyingDropdown(!showUnderlyingDropdown)}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-sm font-semibold text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-card)]"
          >
            {underlying}
            <ChevronDown size={14} className="text-[var(--color-text-muted)]" />
          </button>
          {showUnderlyingDropdown && (
            <div className="absolute left-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] shadow-xl">
              {UNDERLYING_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => {
                    setUnderlying(opt);
                    setShowUnderlyingDropdown(false);
                  }}
                  className={cn(
                    'block w-full px-4 py-2 text-left text-sm transition-colors hover:bg-[var(--color-bg-tertiary)]',
                    opt === underlying
                      ? 'text-[var(--color-accent-blue)] font-semibold'
                      : 'text-[var(--color-text-secondary)]',
                  )}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Spot price display */}
        {spotPrice > 0 && (
          <div className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-1.5">
            <Activity size={14} className="text-[var(--color-accent-green)] animate-pulse-dot" />
            <span className="text-sm font-mono font-bold text-[var(--color-text-primary)]">
              {spotPrice.toLocaleString('en-IN')}
            </span>
          </div>
        )}

        {/* Loading indicator */}
        {isLoading && (
          <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-accent-blue)] border-t-transparent" />
            Loading...
          </div>
        )}
      </div>

      <PageLoadingOverlay isLoading={isLoading && chain.length === 0} message="Loading options chain..." />

      {!(isLoading && chain.length === 0) && (
        <>
          {/* Expiry tabs */}
          <ExpirySelector
            expiries={expiries}
            selected={expiry}
            onChange={setExpiry}
          />

          {/* Strike range selector */}
          <StrikeSelector
            range={strikeRange}
            onChange={setStrikeRange}
            atmStrike={atmStrike}
          />

          {/* Options Chain Table */}
          <OptionsChainTable
            chain={filteredChain}
            spotPrice={spotPrice}
            onTradeClick={handleTradeClick}
          />

          {/* Bottom panels: OI Analysis + Payoff Chart */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <OIAnalysis chain={chain} spotPrice={spotPrice} />
            <OptionPayoffChart positions={payoffPositions} spotPrice={spotPrice} />
          </div>

          {expiry && chain.length > 0 && (
            <AIInsightCard
              sectionKey="options-chain"
              contextKey={`${underlying}:${expiry}`}
              contextData={optionsContextData}
              title="AI Strike Recommendation"
            />
          )}
        </>
      )}
    </div>
  );
}
