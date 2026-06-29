import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Minus, RefreshCw } from 'lucide-react';
import api from '@/services/api';
import AIInsightCard from '@/components/ai/AIInsightCard';

interface BreadthData {
  advances: number;
  declines: number;
  unchanged: number;
}

export default function MarketBreadth() {
  const [breadth, setBreadth] = useState<BreadthData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchBreadth = async () => {
    try {
      const res = await api.get('/market-data/breadth');
      setBreadth(res.data);
    } catch {
      // Keep existing data on error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBreadth();
    // Refresh every 30 seconds
    const id = setInterval(fetchBreadth, 30_000);
    return () => clearInterval(id);
  }, []);

  if (loading || !breadth) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
        <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">Market Breadth</h3>
        <div className="flex h-12 items-center justify-center text-xs text-[var(--color-text-muted)]">
          Loading...
        </div>
      </div>
    );
  }

  const total = breadth.advances + breadth.declines + breadth.unchanged;
  const advPct = total > 0 ? (breadth.advances / total) * 100 : 0;
  const decPct = total > 0 ? (breadth.declines / total) * 100 : 0;
  const adRatio = breadth.declines > 0 ? (breadth.advances / breadth.declines).toFixed(2) : '--';

  return (
    <div className="flex flex-col gap-3">
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Market Breadth</h3>
        <button
          onClick={fetchBreadth}
          className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
          title="Refresh"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* Bar */}
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        <div
          className="rounded-l-full bg-[var(--color-accent-green)]"
          style={{ width: `${advPct}%` }}
        />
        <div
          className="bg-[var(--color-text-muted)]"
          style={{ width: `${100 - advPct - decPct}%` }}
        />
        <div
          className="rounded-r-full bg-[var(--color-accent-red)]"
          style={{ width: `${decPct}%` }}
        />
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5">
          <TrendingUp size={12} className="text-[var(--color-accent-green)]" />
          <span className="text-[var(--color-text-secondary)]">Advances</span>
          <span className="font-bold text-[var(--color-accent-green)]">{breadth.advances}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Minus size={12} className="text-[var(--color-text-muted)]" />
          <span className="text-[var(--color-text-secondary)]">Unchanged</span>
          <span className="font-bold text-[var(--color-text-muted)]">{breadth.unchanged}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <TrendingDown size={12} className="text-[var(--color-accent-red)]" />
          <span className="text-[var(--color-text-secondary)]">Declines</span>
          <span className="font-bold text-[var(--color-accent-red)]">{breadth.declines}</span>
        </div>
      </div>

      {/* Ratio */}
      <div className="mt-2 text-center">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          A/D Ratio: {adRatio}
        </span>
      </div>
    </div>
    <AIInsightCard
      sectionKey="market-breadth"
      contextKey="default"
      contextData={{
        breadth,
        adRatio: parseFloat(adRatio === '--' ? '0' : adRatio),
        capturedAt: new Date().toISOString(),
      }}
    />
    </div>
  );
}
