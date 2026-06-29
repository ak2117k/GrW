import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useChartStore, type SelectedSymbol } from '@/stores/chart-store';

/**
 * Atomic "select a symbol" action used by the chart toolbar's SymbolSearch
 * and the watchlist sidebar. Updates the Zustand store AND the URL query
 * params in a single call so the chart never gets out of sync with the
 * address bar — and crucially, never relies on a separate URL←store
 * effect that could ping-pong with the URL→store deep-link effect in
 * ChartsPage.
 *
 * Why one helper instead of two effects:
 *   Two opposing effects (URL→store and store→URL) are correct on paper
 *   but extremely fragile in practice — any subtle reference-equality or
 *   batching quirk turns them into an infinite loop. Funnelling all
 *   user-initiated symbol changes through one writer means the URL→store
 *   effect only ever fires for *external* URL changes (back button, deep
 *   link, market-page navigation) and there's no second writer to fight.
 */
export function useSymbolNavigation() {
  const setSymbol = useChartStore((s) => s.setSymbol);
  const [searchParams, setSearchParams] = useSearchParams();

  return useCallback(
    (sym: SelectedSymbol) => {
      setSymbol(sym);
      // Skip URL update for tokenless symbols (e.g. an unresolved MCX
      // commodity) — without a token the chart can't load data anyway,
      // and the URL→store effect would just rewrite the URL on the next
      // render with stale fields.
      if (!sym.token) return;
      const next = new URLSearchParams(searchParams);
      next.set('symbol', sym.symbol);
      next.set('exchange', sym.exchange);
      next.set('token', sym.token);
      setSearchParams(next, { replace: true });
    },
    [setSymbol, searchParams, setSearchParams],
  );
}
