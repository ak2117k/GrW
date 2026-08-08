import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api';
import type { EvidenceLevel, StrongZone } from '@/types';
import type { AnalysisDto } from '@/components/stock-overview/SetupContextCard';

/** Per-source outcome, as composed server-side. */
export type SourceState = 'ok' | 'empty' | 'failed';

/**
 * A fitted trend line, as the server computes it from the same weighted pivots
 * the levels come from.
 *
 * Times are REAL market time (unix seconds) and the slope is price per SECOND,
 * so the line must be evaluated against a bar's `realTime` — never against the
 * gap-compressed axis time the chart actually plots. See `trendLinePoints`.
 */
export interface TrendLine {
  kind: 'uptrend' | 'downtrend';
  /** Price per second. */
  slope: number;
  /** Price AT `fromTime`. */
  intercept: number;
  /** Unix seconds, first anchoring pivot. */
  fromTime: number;
  /** Unix seconds, last anchoring pivot. */
  toTime: number;
  touches: number;
  r2: number;
}

/**
 * One armed trade. `triggerPrice` is the level that arms it — and the price
 * the chart draws — so the drawn line and the card's numbers are the same
 * object and cannot drift apart.
 */
export interface TradeTrigger {
  side: 'BUY' | 'SELL';
  triggerPrice: number;
  /** 'PDH' | 'PDL' | 'ORH' | 'ORL' | 'ROUND' | 'MA' | 'AVWAP' | 'PIVOT'. */
  levelSource: string;
  entry: number;
  stoploss: number;
  target: number;
  /** Reward:risk, e.g. 2.0. Computed server-side, never hand-set. */
  rr: number;
  /** 'active' = conditions met now. 'pending' = would trigger if reached. */
  state: 'active' | 'pending';
  /** One plain sentence. No JSON, no debug payloads. */
  reason: string;
}

export interface TradePlan {
  /** A setup formed right now, if any. */
  active: TradeTrigger | null;
  /** Nearest untriggered LONG above spot. `null` is a legitimate answer. */
  above: TradeTrigger | null;
  /** Nearest untriggered SHORT below spot. `null` is a legitimate answer. */
  below: TradeTrigger | null;
}

const EMPTY_TRADE_PLAN: TradePlan = { active: null, above: null, below: null };

export interface ChartContextSources {
  analysis: SourceState;
  zones: SourceState;
  evidence: SourceState;
  trend: SourceState;
  tradePlan: SourceState;
}

export interface ChartContextDto {
  interval: string;
  analysis: AnalysisDto | null;
  zones: StrongZone[];
  evidence: EvidenceLevel[];
  // `null` is a first-class answer meaning "no clear trend" — the fitter
  // rejects poor fits rather than drawing a line through noise. It is never a
  // loading or error state (those live in `status` / the hook's own flags).
  trend: TrendLine | null;
  /**
   * The one trade the chart draws and the card reads. Always an object — a
   * plan with all-null triggers means "ran, nothing qualified", which is a
   * different statement from `sources.tradePlan === 'failed'`.
   */
  tradePlan: TradePlan;
  status: 'ready' | 'partial' | 'unavailable';
  sources: ChartContextSources;
}

export interface UseChartContextReturn {
  context: ChartContextDto | null;
  /** True until the FIRST response for the current inputs lands. */
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

const POLL_INTERVAL_MS = 60_000;

/**
 * Query params for a /chart-context read. Pure and exported so the contract is
 * testable without a DOM.
 *
 * `symbol` is the load-bearing one. Server-side it gates the analysis, evidence
 * and trend loaders alike — omit it and the server falls back to a token->symbol
 * instrument lookup that misses for indices, emptying all three at once. The
 * hook this replaced passed the symbol explicitly; dropping it is what made a
 * NIFTY chart honestly report "none in range".
 */
export function chartContextParams(
  token: string,
  exchange: string,
  interval: string | null,
  symbol?: string | null,
): Record<string, string> {
  return {
    token,
    exchange,
    interval: interval ?? '15m',
    ...(symbol ? { symbol } : {}),
  };
}

/** A transport failure is indistinguishable, to the chart, from every source failing. */
const UNAVAILABLE: ChartContextDto = {
  interval: '',
  analysis: null,
  zones: [],
  evidence: [],
  trend: null,
  tradePlan: EMPTY_TRADE_PLAN,
  status: 'unavailable',
  sources: {
    analysis: 'failed',
    zones: 'failed',
    evidence: 'failed',
    trend: 'failed',
    tradePlan: 'failed',
  },
};

/**
 * Polls `/api/signals/chart-context` every 60s — the composite that replaces
 * the charts page's three separate polls of /analyze, /zones and /sr-evidence.
 *
 * The point of the composite is that the chart can tell *loading* from *broken*
 * from *genuinely no levels*, which three independent hooks returning `[]` on
 * failure structurally could not. So this hook keeps `context === null` until a
 * response actually lands (that is "loading"), and on a transport failure
 * synthesizes an `unavailable` context rather than an empty one — the chip must
 * never be able to render "none in range" for a request that never succeeded.
 *
 * Pattern mirrors useZones/useSrEvidence: useCallback'd fetch, an effect for
 * initial + interval, and an AbortController so a symbol/timeframe switch
 * mid-flight can't write stale data into the next render.
 */
export function useChartContext(
  token: string | null,
  exchange: string | null,
  interval: string | null,
  /**
   * Passed through so the server does not have to resolve it from the token.
   *
   * REGRESSION GUARD: the hook this replaced took the symbol explicitly. When
   * it is omitted the server falls back to an instrument-table lookup, which
   * misses for INDICES (NIFTY's 99926000 is not a cash-equity row) — and the
   * resolved symbol gates the analysis, evidence AND trend loaders alike, so
   * one failed lookup empties all three at once and the chip honestly reports
   * "none in range" for a symbol that has plenty.
   */
  symbol?: string | null,
): UseChartContextReturn {
  const [context, setContext] = useState<ChartContextDto | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchContext = useCallback(async () => {
    if (!token || token === '0' || !exchange) {
      setContext(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    try {
      const response = await api.get<ChartContextDto>('/signals/chart-context', {
        params: chartContextParams(token, exchange, interval, symbol),
        signal: controller.signal,
      });
      const payload = response.data;
      // A malformed body is a failure of the source, not a set of empty
      // sources — collapsing it to `ready` would print "none in range".
      setContext(
        payload && typeof payload === 'object' && payload.status
          ? {
              ...payload,
              zones: Array.isArray(payload.zones) ? payload.zones : [],
              evidence: Array.isArray(payload.evidence) ? payload.evidence : [],
              // A body without a plan is a server that couldn't produce one
              // (or predates the field): normalise to an empty plan and mark
              // the SOURCE failed, so the card says "unavailable" rather than
              // the far stronger "nothing is setting up".
              tradePlan: payload.tradePlan ?? EMPTY_TRADE_PLAN,
              sources: {
                ...payload.sources,
                tradePlan: payload.sources?.tradePlan ?? (payload.tradePlan ? 'ok' : 'failed'),
              },
            }
          : { ...UNAVAILABLE, interval: interval ?? '' },
      );
      setError(null);
    } catch (err) {
      // An aborted request is a symbol/timeframe switch, not an outage: the
      // successor fetch owns the state, so leave everything alone.
      const name = (err as { name?: string })?.name;
      const code = (err as { code?: string })?.code;
      if (name === 'CanceledError' || name === 'AbortError' || code === 'ERR_CANCELED') return;
      setError(err instanceof Error ? err : new Error('Failed to fetch chart context'));
      setContext({ ...UNAVAILABLE, interval: interval ?? '' });
    } finally {
      if (abortRef.current === controller) setIsLoading(false);
    }
  }, [token, exchange, interval, symbol]);

  useEffect(() => {
    // Drop the previous symbol's context immediately so the chip falls back to
    // "loading" rather than showing the last symbol's levels over new candles.
    setContext(null);
    setError(null);

    if (!token || token === '0' || !exchange) {
      setIsLoading(false);
      return;
    }

    fetchContext();
    const intervalId = window.setInterval(fetchContext, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [fetchContext, token, exchange, interval]);

  return { context, isLoading, error, refetch: fetchContext };
}
