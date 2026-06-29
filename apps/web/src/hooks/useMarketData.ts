import { useEffect, useRef } from 'react';
import { wsService } from '@/services/websocket';
import api from '@/services/api';
import { useMarketStore } from '@/stores/market-store';
import { Exchange, type Quote, type MarketStatus } from '@/types';
import { COMMODITIES } from '@td/shared';

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

/** Demo index quotes so the UI isn't blank when Angel One isn't configured. */
const DEMO_INDEX_QUOTES: Quote[] = [
  { symbol: 'NIFTY', token: '99926000', exchange: Exchange.NSE, ltp: 23_516.45, open: 23_480.10, high: 23_558.30, low: 23_442.75, close: 23_482.15, change: 34.30, changePercent: 0.15, volume: 0, timestamp: new Date() },
  { symbol: 'BANKNIFTY', token: '99926009', exchange: Exchange.NSE, ltp: 50_124.80, open: 50_035.20, high: 50_289.55, low: 49_918.40, close: 50_035.20, change: 89.60, changePercent: 0.18, volume: 0, timestamp: new Date() },
  { symbol: 'FINNIFTY', token: '99926037', exchange: Exchange.NSE, ltp: 21_845.60, open: 21_790.30, high: 21_880.10, low: 21_755.90, close: 21_790.30, change: 55.30, changePercent: 0.25, volume: 0, timestamp: new Date() },
  { symbol: 'SENSEX', token: '99919000', exchange: Exchange.BSE, ltp: 77_341.20, open: 77_220.50, high: 77_455.80, low: 77_105.35, close: 77_220.50, change: 120.70, changePercent: 0.16, volume: 0, timestamp: new Date() },
  { symbol: 'NIFTY MIDCAP 50', token: '99926025', exchange: Exchange.NSE, ltp: 14_892.35, open: 14_855.80, high: 14_920.50, low: 14_810.60, close: 14_855.80, change: 36.55, changePercent: 0.25, volume: 0, timestamp: new Date() },
  { symbol: 'NIFTY IT', token: '99926013', exchange: Exchange.NSE, ltp: 34_210.90, open: 34_150.40, high: 34_310.25, low: 34_080.15, close: 34_150.40, change: 60.50, changePercent: 0.18, volume: 0, timestamp: new Date() },
];

/** Demo commodity quotes — seeded so the Commodities tab has data.
 *  Tokens sourced from @td/shared COMMODITIES constants. */
const DEMO_COMMODITY_QUOTES: Quote[] = [
  { symbol: 'GOLD', token: COMMODITIES.GOLD.token, exchange: Exchange.MCX, ltp: 72_450.00, open: 72_180.00, high: 72_620.00, low: 72_050.00, close: 72_180.00, change: 270.00, changePercent: 0.37, volume: 12_540, timestamp: new Date() },
  { symbol: 'SILVER', token: COMMODITIES.SILVER.token, exchange: Exchange.MCX, ltp: 84_320.00, open: 83_950.00, high: 84_580.00, low: 83_710.00, close: 83_950.00, change: 370.00, changePercent: 0.44, volume: 18_230, timestamp: new Date() },
  { symbol: 'CRUDEOIL', token: COMMODITIES.CRUDEOIL.token, exchange: Exchange.MCX, ltp: 5_420.00, open: 5_380.00, high: 5_450.00, low: 5_360.00, close: 5_380.00, change: 40.00, changePercent: 0.74, volume: 15_600, timestamp: new Date() },
  { symbol: 'NATURALGAS', token: COMMODITIES.NATURALGAS.token, exchange: Exchange.MCX, ltp: 248.50, open: 246.80, high: 250.10, low: 245.30, close: 246.80, change: 1.70, changePercent: 0.69, volume: 28_910, timestamp: new Date() },
  { symbol: 'COPPER', token: COMMODITIES.COPPER.token, exchange: Exchange.MCX, ltp: 845.50, open: 842.00, high: 848.00, low: 840.00, close: 842.00, change: 3.50, changePercent: 0.42, volume: 8_200, timestamp: new Date() },
];

/** Demo stock quotes — always seeded so watchlist and F&O tab have data. */
const DEMO_STOCK_QUOTES: Quote[] = [
  { symbol: 'RELIANCE', token: '2885', exchange: Exchange.NSE, ltp: 2_934.55, open: 2_920.00, high: 2_948.70, low: 2_912.30, close: 2_920.00, change: 14.55, changePercent: 0.50, volume: 8_245_310, timestamp: new Date() },
  { symbol: 'TCS', token: '11536', exchange: Exchange.NSE, ltp: 3_612.40, open: 3_595.00, high: 3_628.50, low: 3_580.25, close: 3_595.00, change: 17.40, changePercent: 0.48, volume: 2_134_560, timestamp: new Date() },
  { symbol: 'HDFCBANK', token: '1333', exchange: Exchange.NSE, ltp: 1_645.30, open: 1_652.80, high: 1_658.90, low: 1_638.45, close: 1_652.80, change: -7.50, changePercent: -0.45, volume: 5_678_900, timestamp: new Date() },
  { symbol: 'INFY', token: '1594', exchange: Exchange.NSE, ltp: 1_512.60, open: 1_505.00, high: 1_522.30, low: 1_498.75, close: 1_505.00, change: 7.60, changePercent: 0.51, volume: 3_412_780, timestamp: new Date() },
  { symbol: 'ICICIBANK', token: '4963', exchange: Exchange.NSE, ltp: 1_278.90, open: 1_285.40, high: 1_292.15, low: 1_270.50, close: 1_285.40, change: -6.50, changePercent: -0.51, volume: 4_567_230, timestamp: new Date() },
];

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

  // Fetch initial index data via REST, fall back to demo quotes.
  // Stock quotes are always seeded (demo or live) so the watchlist and
  // F&O tab have data even when only index quotes come from the API.
  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;

    (async () => {
      try {
        const res = await api.get('/market-data/indices');
        const indices = res.data?.indices ?? [];
        let hasLiveData = false;

        for (const idx of indices) {
          if (idx.quote && idx.quote.ltp) {
            hasLiveData = true;
            updateQuote(idx.quote as Quote);
          }
        }

        // If the API returned no live index quotes, seed with demo index data
        if (!hasLiveData) {
          for (const q of DEMO_INDEX_QUOTES) updateQuote(q);
        }
      } catch {
        // API unreachable — use demo index data so the UI isn't empty
        for (const q of DEMO_INDEX_QUOTES) updateQuote(q);
      }

      // Always seed stock quotes with demo data as a baseline.
      // Live WebSocket ticks will overwrite these once available.
      for (const q of DEMO_STOCK_QUOTES) {
        // Only seed if we don't already have a live quote for this symbol
        const existing = useMarketStore.getState().quotes.get(q.symbol);
        if (!existing) {
          updateQuote(q);
        }
      }

      // Seed commodity quotes so the Commodities tab has data.
      // Live WebSocket ticks will overwrite these once available.
      for (const q of DEMO_COMMODITY_QUOTES) {
        const existing = useMarketStore.getState().quotes.get(q.symbol);
        if (!existing) {
          updateQuote(q);
        }
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
