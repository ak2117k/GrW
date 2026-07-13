import { useEffect, useRef } from 'react';
import { wsService } from '@/services/websocket';
import api from '@/services/api';
import { useMarketStore } from '@/stores/market-store';
import { type Quote, type MarketStatus } from '@/types';

/**
 * Compute current Indian market status using IST time.
 * Uses Intl to get the correct IST hour/minute regardless of the local timezone.
 */
function computeMarketStatus(): MarketStatus {
  const now = new Date();

  // Use Intl formatter to get IST hour and minute — no manual offset math needed
  const istParts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);

  const hour = Number(istParts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(istParts.find((p) => p.type === 'minute')?.value ?? 0);
  const weekday = istParts.find((p) => p.type === 'weekday')?.value ?? '';

  // Weekend check (Sat/Sun in en-IN locale)
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';

  const totalMinutes = hour * 60 + minute;

  // NSE/BSE hours
  const preMarketOpen = 9 * 60;       // 09:00
  const marketOpen = 9 * 60 + 15;     // 09:15
  const marketClose = 15 * 60 + 30;   // 15:30

  // MCX hours (9:00 AM – 11:30 PM IST)
  const mcxOpen = 9 * 60;             // 09:00
  const mcxClose = 23 * 60 + 30;      // 23:30

  const nseOpen = totalMinutes >= marketOpen && totalMinutes <= marketClose;
  const mcxOpen_ = totalMinutes >= mcxOpen && totalMinutes <= mcxClose;

  if (nseOpen || mcxOpen_) return 'open';
  if (totalMinutes >= preMarketOpen && totalMinutes < marketOpen) return 'pre-market';
  return 'closed';
}

export function useMarketData(): void {
  const updateQuote = useMarketStore((s) => s.updateQuote);
  const setConnected = useMarketStore((s) => s.setConnected);
  const setMarketStatus = useMarketStore((s) => s.setMarketStatus);
  const hasFetched = useRef(false);

  // Compute market status on mount and refresh every 30 seconds
  useEffect(() => {
    setMarketStatus(computeMarketStatus());
    const id = setInterval(() => setMarketStatus(computeMarketStatus()), 30_000);
    return () => clearInterval(id);
  }, [setMarketStatus]);

  // Fetch initial index data via REST. REAL data only — apply whatever live
  // quotes the API returns and let live WebSocket ticks fill in the rest. If
  // nothing is available yet we leave the quotes empty (the UI shows real
  // data or nothing at all — never fabricated demo numbers).
  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;

    (async () => {
      try {
        const res = await api.get('/market-data/indices');
        const indices = res.data?.indices ?? [];

        for (const idx of indices) {
          if (idx.quote && idx.quote.ltp) {
            updateQuote(idx.quote as Quote);
          }
        }
      } catch {
        // API unreachable — leave quotes empty; no demo fallback.
      }
    })();
  }, [updateQuote]);

  // WebSocket for live tick updates
  useEffect(() => {
    wsService.connect();

    const unsubTick = wsService.subscribe('tick', (data) => {
      updateQuote(data as Quote);
    });

    const unsubConn = wsService.subscribe('connection-status', (data) => {
      const { connected } = data as { connected: boolean };
      setConnected(connected);
    });

    return () => {
      unsubTick();
      unsubConn();
    };
  }, [updateQuote, setConnected]);
}
