import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import api from '@/services/api';

interface SectorData {
  sector: string;
  symbol: string;
  token: string;
  changePercent: number;
  ltp: number;
}

function getHeatColor(change: number): string {
  const intensity = Math.min(Math.abs(change) / 2.5, 1);
  if (change >= 0) {
    const r = Math.round(10 + (0 - 10) * intensity);
    const g = Math.round(30 + (207 - 30) * intensity);
    const b = Math.round(20 + (132 - 20) * intensity);
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    const r = Math.round(30 + (239 - 30) * intensity);
    const g = Math.round(20 + (68 - 20) * intensity);
    const b = Math.round(20 + (68 - 20) * intensity);
    return `rgb(${r}, ${g}, ${b})`;
  }
}

export default function SectorHeatmap() {
  const [sectors, setSectors] = useState<SectorData[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSectors = async () => {
    try {
      const res = await api.get('/market-data/sector-performance');
      setSectors(res.data?.sectors ?? []);
    } catch {
      // Keep existing data on error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSectors();
    // Refresh every 30 seconds
    const id = setInterval(fetchSectors, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Sector Heatmap</h3>
        <button
          onClick={fetchSectors}
          className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
          title="Refresh"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {loading ? (
        <div className="flex h-16 items-center justify-center text-xs text-[var(--color-text-muted)]">
          Loading sector data...
        </div>
      ) : sectors.length === 0 ? (
        <div className="flex h-16 items-center justify-center text-xs text-[var(--color-text-muted)]">
          No sector data available
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-4 md:grid-cols-8">
          {sectors.map((sector) => (
            <div
              key={sector.symbol || sector.sector}
              className="flex flex-col items-center justify-center rounded-lg px-2 py-3 transition-transform hover:scale-105"
              style={{ backgroundColor: getHeatColor(sector.changePercent) + '33' }}
            >
              <span className="text-[10px] font-semibold text-[var(--color-text-primary)]">
                {sector.sector}
              </span>
              <span
                className="mt-0.5 text-xs font-bold"
                style={{ color: getHeatColor(sector.changePercent) }}
              >
                {sector.changePercent >= 0 ? '+' : ''}{sector.changePercent.toFixed(2)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
