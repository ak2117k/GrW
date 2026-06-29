import { useState, useEffect } from 'react';
import { cn } from '@/utils/cn';
import api from '@/services/api';

interface ExchangeStatus {
  isOpen: boolean;
  label: string;
  hours: string;
  reason?: string;
}

interface MarketStatusData {
  nse: ExchangeStatus;
  mcx: ExchangeStatus;
  anyOpen: boolean;
  timestamp: string;
}

const POLL_INTERVAL = 60_000; // 60 seconds

export default function MarketStatusBar() {
  const [status, setStatus] = useState<MarketStatusData | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await api.get('/market-data/market-status');
        setStatus(res.data);
      } catch {
        // Silently fail — the bar just won't show
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  if (!status) return null;

  return (
    <div className="flex items-center gap-4 rounded-lg border border-gray-700/60 bg-gray-800/40 px-4 py-2">
      <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
        Markets
      </span>

      {/* NSE Status */}
      <ExchangePill
        name="NSE"
        isOpen={status.nse.isOpen}
        hours={status.nse.hours}
        reason={status.nse.reason}
      />

      {/* MCX Status */}
      <ExchangePill
        name="MCX"
        isOpen={status.mcx.isOpen}
        hours={status.mcx.hours}
        reason={status.mcx.reason}
      />

      {/* Contextual message */}
      {!status.anyOpen && (
        <span className="ml-auto text-[11px] text-gray-500 italic">
          {status.nse.reason
            ? `${status.nse.reason} — Signals based on last closing data`
            : 'Markets closed — Signals based on last closing data'}
        </span>
      )}
    </div>
  );
}

function ExchangePill({
  name,
  isOpen,
  hours,
  reason,
}: {
  name: string;
  isOpen: boolean;
  hours: string;
  reason?: string;
}) {
  const tooltip = isOpen
    ? `${name}: ${hours}`
    : `${name}: ${hours}${reason ? ` — ${reason}` : ''}`;

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
        isOpen
          ? 'bg-emerald-500/10 text-emerald-400'
          : 'bg-gray-700/50 text-gray-400',
      )}
      title={tooltip}
    >
      {/* Status dot */}
      <span className="relative flex h-2 w-2">
        {isOpen && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        )}
        <span
          className={cn(
            'relative inline-flex h-2 w-2 rounded-full',
            isOpen ? 'bg-emerald-400' : 'bg-gray-500',
          )}
        />
      </span>
      {name}
      <span className="text-[10px] opacity-70">
        {isOpen ? 'LIVE' : 'CLOSED'}
      </span>
    </div>
  );
}
