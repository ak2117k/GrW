import { create } from 'zustand';
import type { Trade, TradeEvent, RiskStatus } from '@/types';
import type { Position } from '@/types';
import api from '@/services/api';
import toast from 'react-hot-toast';

// M5: explicit shape for trade-execute payloads. The store previously
// accepted Record<string, unknown> so any extra keys *would* have flowed
// through, but a typed shape gives modal callers autocomplete and
// catches typos in field names like `entryReason` / `entryTags`.
export interface ExecuteTradeDto {
  symbol: string;
  token: string;
  exchange: string;
  side: string;
  orderType: string;
  quantity: number;
  price?: number;
  triggerPrice?: number;
  positionType: string;
  stoploss?: number;
  target?: number;
  entryReason?: string;
  entryTags?: string[];
  // Per-order paper/live flag (Manual Trade Terminal). Explicit flag wins on
  // the backend; absent flag falls back to the global paperTrading setting.
  isPaper?: boolean;
  // Allow forward-compat passthrough (e.g. signalId) without tightening
  // every caller in the same patch.
  [key: string]: unknown;
}

// Provenance filter for GET /trades/open. Mirrors the backend `source`
// column on the Trade model (MANUAL | WATCH | AUTO | SCANNER).
export type TradeSource = 'MANUAL' | 'WATCH' | 'AUTO' | 'SCANNER';

interface TradeState {
  openTrades: Trade[];
  positions: Position[];
  recentTrades: Trade[];
  executionLog: TradeEvent[];
  riskStatus: RiskStatus;
  isKillSwitchActive: boolean;
  isLoading: boolean;

  // `source` is an optional broker-side filter (MANUAL | WATCH | AUTO |
  // SCANNER). Omitted ⇒ all open trades (unchanged behaviour for the
  // shared useTrades hook → Positions / Auto-Trade pages). The Manual
  // Trade page passes 'MANUAL' so the page is scoped to the user's own
  // orders only. See GET /api/trades/open?source=MANUAL contract.
  fetchOpenTrades: (source?: TradeSource) => Promise<void>;
  fetchPositions: () => Promise<void>;
  fetchRiskStatus: () => Promise<void>;
  executeTrade: (dto: ExecuteTradeDto) => Promise<void>;
  closeTrade: (id: string) => Promise<void>;
  closeAllPositions: () => Promise<void>;
  addTradeEvent: (event: TradeEvent) => void;
  updatePosition: (position: Position) => void;
  setOpenTrades: (trades: Trade[]) => void;
  setPositions: (positions: Position[]) => void;
  setRiskStatus: (status: RiskStatus) => void;
  setKillSwitchActive: (active: boolean) => void;
}

const defaultRiskStatus: RiskStatus = {
  dailyLossUsed: 0,
  dailyLossLimit: 5000,
  positionsUsed: 0,
  positionsLimit: 5,
  capitalDeployed: 0,
  capitalLimit: 100000,
};

export const useTradeStore = create<TradeState>((set) => ({
  openTrades: [],
  positions: [],
  recentTrades: [],
  executionLog: [],
  riskStatus: defaultRiskStatus,
  isKillSwitchActive: false,
  isLoading: false,

  fetchOpenTrades: async (source) => {
    try {
      const { data } = await api.get<any[]>('/trades/open', {
        params: source ? { source } : undefined,
      });
      // Normalize backend's isPaperTrade → frontend's isPaper field name,
      // and lift instrument.symbol/exchange to the top level (the JournalPage
      // and TradeCard read t.symbol / t.exchange directly).
      set({
        openTrades: (data ?? []).map((t) => ({
          ...t,
          isPaper: t.isPaper ?? t.isPaperTrade ?? false,
          symbol: t.symbol ?? t.instrument?.symbol ?? '',
          exchange: t.exchange ?? t.instrument?.exchange ?? '',
        })) as Trade[],
      });
    } catch {
      console.warn('Failed to fetch open trades');
    }
  },

  fetchPositions: async () => {
    try {
      const { data } = await api.get<Position[]>('/trades/positions');
      set({ positions: data });
    } catch {
      console.warn('Failed to fetch positions');
    }
  },

  fetchRiskStatus: async () => {
    try {
      const { data } = await api.get<RiskStatus>('/trades/risk-status');
      set({ riskStatus: data });
    } catch {
      console.warn('Failed to fetch risk status');
    }
  },

  executeTrade: async (dto) => {
    set({ isLoading: true });
    try {
      const { data } = await api.post<Trade>('/trades/execute', dto);
      set((state) => ({
        openTrades: [data, ...state.openTrades],
      }));
      toast.success(`Trade executed: ${dto.side} ${dto.symbol}`);
    } catch (err) {
      // Surface the server's real reason instead of a generic message. The API
      // throws structured 4xx with the cause in the body (NestJS HttpException
      // → { message }): e.g. "Live trading is disabled…" (403 gate),
      // "Trade rejected: <risk reason>" (403 risk), or a broker error. Showing
      // it means a Forbidden no longer looks opaque to the trader.
      const anyErr = err as { response?: { data?: { message?: string | string[] } } };
      const raw = anyErr?.response?.data?.message;
      const reason = Array.isArray(raw) ? raw.join('; ') : raw;
      toast.error(reason ? `Order rejected: ${reason}` : 'Trade execution failed');
      throw err;
    } finally {
      set({ isLoading: false });
    }
  },

  closeTrade: async (id) => {
    try {
      // M5 invariant: every closed trade must have a structured exit reason.
      // The proper UX is the ExitTradeModal (used from JournalPage), which
      // forces the trader to pick HIT_TARGET / STOPPED_OUT / etc. This
      // store action is a *fallback* invoked from the auto-trade page kill
      // path where there's no human present to pick a reason — we tag it
      // OTHER + exitNotes so the journal stays queryable rather than
      // collecting null exit reasons that would distort post-trade
      // analytics. Manual closes from the journal go through ExitTradeModal
      // and pass real reasons.
      const { data } = await api.post<Trade>(`/trades/${id}/close`, {
        exitReasonTag: 'OTHER',
        exitNotes: 'Closed via store action (auto-trade kill / non-modal path)',
      });
      set((state) => ({
        openTrades: state.openTrades.filter((t) => t.id !== id),
        recentTrades: [data, ...state.recentTrades].slice(0, 20),
      }));
      toast.success('Position closed');
    } catch {
      toast.error('Failed to close position');
    }
  },

  closeAllPositions: async () => {
    set({ isKillSwitchActive: true });
    try {
      await api.post('/trades/close-all');
      set({
        openTrades: [],
        positions: [],
      });
      toast.success('All positions closed');
    } catch {
      toast.error('Failed to close all positions');
    } finally {
      set({ isKillSwitchActive: false });
    }
  },

  addTradeEvent: (event) =>
    set((state) => ({
      executionLog: [event, ...state.executionLog].slice(0, 50),
    })),

  updatePosition: (position) =>
    set((state) => {
      const idx = state.positions.findIndex((p) => p.symbol === position.symbol);
      if (idx >= 0) {
        const next = [...state.positions];
        next[idx] = position;
        return { positions: next };
      }
      return { positions: [...state.positions, position] };
    }),

  setOpenTrades: (trades) => set({ openTrades: trades }),
  setPositions: (positions) => set({ positions }),
  setRiskStatus: (status) => set({ riskStatus: status }),
  setKillSwitchActive: (active) => set({ isKillSwitchActive: active }),
}));

// ── Derived values from openTrades ─────────────────────────────────────
// The Manual Trade page derives its capital-deployed and open-position
// count from the (MANUAL-scoped) openTrades it fetched, NOT from the
// in-memory position-manager (`/trades/positions`) which only holds the
// trades that passed the non-₹0 entryPrice guard and so diverges from the
// DB. Deriving here guarantees the top strip/panel and the bottom order
// book read the same single source.

/** Sum of `entryPrice * quantity` over the given open trades. */
export function deriveCapitalDeployed(trades: Trade[]): number {
  return trades.reduce(
    (sum, t) => sum + (t.entryPrice ?? 0) * (t.quantity ?? 0),
    0,
  );
}

/** Open-position count = number of open trades. */
export function derivePositionsCount(trades: Trade[]): number {
  return trades.length;
}

/**
 * Map open Trade rows to the `Position` shape the PositionsPanel renders.
 * Uses entryPrice as the average and the trade's own ltp/pnl/pnlPercent
 * (which the live-tick handler on the page re-marks). Falls back to
 * entryPrice-based values without crashing when ltp is absent.
 */
export function tradesToPositions(trades: Trade[]): Position[] {
  return trades.map((t) => {
    const averagePrice = t.entryPrice ?? 0;
    const ltp = t.ltp ?? averagePrice;
    const direction = t.side === 'BUY' ? 1 : -1;
    const pnl =
      typeof t.pnl === 'number'
        ? t.pnl
        : (ltp - averagePrice) * (t.quantity ?? 0) * direction;
    const cost = averagePrice * (t.quantity ?? 0);
    const pnlPercent =
      typeof t.pnlPercent === 'number'
        ? t.pnlPercent
        : cost > 0
          ? (pnl / cost) * 100
          : 0;
    return {
      symbol: t.symbol,
      exchange: t.exchange,
      side: t.side,
      quantity: t.quantity ?? 0,
      averagePrice,
      ltp,
      pnl,
      pnlPercent,
    };
  });
}

/**
 * Overlay live prices (live WS ticks and/or fetched per-token quotes, keyed by
 * symbol) onto base positions, recomputing unrealized P&L from the fresh price.
 *
 * The manual-trade page's Open Positions panel previously fed this from live
 * ticks ALONE — but held symbols aren't subscribed to the tick feed, so no tick
 * ever arrives and P&L stayed pinned at 0. Seeding the same symbol→price map
 * from the per-token quote endpoint (as the Pending tab already does) lets a
 * quote drive the mark when no tick is present. A symbol absent from the map,
 * or priced identically to its current ltp, keeps its base values untouched.
 */
export function overlayLivePrices(
  base: Position[],
  priceBySymbol: Record<string, number>,
): Position[] {
  return base.map((p) => {
    const ltp = priceBySymbol[p.symbol];
    if (typeof ltp !== 'number' || ltp === p.ltp) return p;
    const direction = p.side === 'BUY' ? 1 : -1;
    const pnl = (ltp - p.averagePrice) * p.quantity * direction;
    const cost = p.averagePrice * p.quantity;
    const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;
    return { ...p, ltp, pnl, pnlPercent };
  });
}

/** Selector: capital deployed across the store's current open trades. */
export const selectManualCapitalDeployed = (s: TradeState): number =>
  deriveCapitalDeployed(s.openTrades as Trade[]);

/** Selector: open-position count from the store's current open trades. */
export const selectManualPositionsCount = (s: TradeState): number =>
  derivePositionsCount(s.openTrades as Trade[]);
