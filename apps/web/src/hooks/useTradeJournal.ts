import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api';
import type { Trade } from '@/types';
import { useLiveRefresh } from './useLiveRefresh';

/**
 * Silent re-poll of the journal page. An open paper trade's P&L / P&L % live on the trade row (the
 * paper watch / refresher re-mark it every 30 s); fetched once, the row froze while the "Current"
 * column (useJournalLtps, 30 s) kept moving — the owner saw the P&L % stuck as the price rose.
 */
const JOURNAL_REFRESH_MS = 30_000;

export interface JournalFilters {
  dateFrom: string;
  dateTo: string;
  status: string;
  strategy: string;
  segment: string;
  paperLive: string;
  sortBy: string;
  // M5: filter by the regime/exit-reason fields captured at entry/exit.
  // 'all' is treated as "no filter" — same convention as status/strategy.
  vixRegime: string;
  exitReasonTag: string;
}

const defaultFilters: JournalFilters = {
  dateFrom: '',
  dateTo: '',
  status: 'all',
  strategy: 'all',
  segment: 'all',
  paperLive: 'all',
  sortBy: 'date',
  vixRegime: 'all',
  exitReasonTag: 'all',
};

const PAGE_SIZE = 20;

export function useTradeJournal() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<JournalFilters>(defaultFilters);

  /** Bumped per request: a slow response for an older page / filter set must not overwrite a newer one. */
  const seq = useRef(0);

  /** `silent` = the background re-poll: no loading flash, and a failure keeps the rows on screen. */
  const load = useCallback(async (silent: boolean) => {
    const mine = ++seq.current;
    const current = () => mine === seq.current;
    if (!silent) setIsLoading(true);
    try {
      const params: Record<string, string | number> = {
        page,
        limit: PAGE_SIZE,
      };
      // Backend JournalFilterDto extends DateRangeDto which expects `from`
      // and `to` (NOT `dateFrom` / `dateTo`). The param-name mismatch made
      // the date filter silently dead — sending the right keys now.
      if (filters.dateFrom) params.from = filters.dateFrom;
      if (filters.dateTo) params.to = filters.dateTo;
      if (filters.status !== 'all') params.status = filters.status;
      if (filters.strategy !== 'all') params.strategy = filters.strategy;
      if (filters.segment !== 'all') params.segment = filters.segment;
      if (filters.paperLive !== 'all') params.paperLive = filters.paperLive;
      if (filters.sortBy) params.sortBy = filters.sortBy;
      if (filters.vixRegime && filters.vixRegime !== 'all') {
        params.vixRegime = filters.vixRegime;
      }
      if (filters.exitReasonTag && filters.exitReasonTag !== 'all') {
        params.exitReasonTag = filters.exitReasonTag;
      }

      const { data } = await api.get('/portfolio/journal', { params });
      if (!current()) return;
      // Defensive unwrap: backend returns { trades: [...], total: N }, but
      // older shapes used { data: [...] } and a couple of legacy paths
      // returned the bare array. The Array.isArray guard surfaces shape
      // drift instead of silently calling .map on an object.
      const rawCandidate = data?.trades ?? data?.data ?? data;
      if (!Array.isArray(rawCandidate)) {
        console.warn(
          'useTradeJournal: unexpected response shape',
          { keys: data && typeof data === 'object' ? Object.keys(data) : typeof data },
        );
        setTrades([]);
        setTotalCount(0);
        return;
      }
      // Backend trade rows use `isPaperTrade` but the frontend Trade type
      // reads `isPaper`. Same for symbol/exchange (backend nests them on
      // `.instrument`). Normalize at the fetch site so the rest of the page
      // never has to know about the field-name divergence.
      const normalized: Trade[] = rawCandidate.map((t: any) => ({
        ...t,
        isPaper: t.isPaper ?? t.isPaperTrade ?? false,
        symbol: t.symbol ?? t.instrument?.symbol ?? '',
        exchange: t.exchange ?? t.instrument?.exchange ?? '',
        token: t.token ?? t.instrument?.token ?? null,
      }));
      setTrades(normalized);
      setTotalCount(data?.totalCount ?? data?.total ?? normalized.length);
    } catch (err) {
      console.warn('useTradeJournal: fetch failed', err);
      if (silent || !current()) return;
      setTrades([]);
      setTotalCount(0);
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [page, filters]);

  const fetchTrades = useCallback(() => load(false), [load]);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  // Keep open rows' P&L / P&L % live (market-aware; catches up on tab return).
  useLiveRefresh(() => load(true), JOURNAL_REFRESH_MS);

  const updateFilters = useCallback(
    (partial: Partial<JournalFilters>) => {
      setFilters((prev) => ({ ...prev, ...partial }));
      setPage(1);
    },
    [],
  );

  return {
    trades,
    totalCount,
    isLoading,
    page,
    setPage,
    filters,
    setFilters: updateFilters,
    pageSize: PAGE_SIZE,
    refetch: fetchTrades,
  };
}
