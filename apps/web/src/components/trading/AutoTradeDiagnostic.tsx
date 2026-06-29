import { useState, useCallback } from 'react';
import { Activity, Loader2, Check, X, RefreshCw } from 'lucide-react';
import { cn } from '@/utils/cn';
import api from '@/services/api';

/**
 * Diagnostic panel for the Anand Sniper + V25 combined auto-trade strategy.
 *
 * Hits POST /api/signals/scan-now to run one evaluation tick on every watched
 * symbol (NIFTY + BANKNIFTY on NSE, CRUDEOIL + COPPER on MCX), then renders
 * the per-symbol breakdown of all three rule conditions with current vs.
 * threshold values. This is how the user sees WHY the strategy fired (or
 * didn't) without reading server logs or curling endpoints. The card grid
 * auto-flexes to whatever the scan endpoint returns, so adding/removing
 * watched symbols on the backend needs no frontend change.
 */

interface DiagnosticPayload {
  ok: boolean;
  reason: string;
  hubGreen: number;
  hubRed: number;
  hubTotal: number;
  alignmentBullPct: number;
  alignmentBearPct: number;
  bullPct: number;
  bearPct: number;
  bScore: number;
  rScore: number;
  winProb: number;
  putProb: number;
  hubBullish: boolean;
  hubBearish: boolean;
  sniperBullOk: boolean;
  sniperBearOk: boolean;
  winProbBullOk: boolean;
  winProbBearOk: boolean;
  direction: 'BUY' | 'SELL' | null;
  thresholds: { hub: number; sniper: number; winProb: number };
}

interface ScanResult {
  symbol: string;
  signal: { side: 'BUY' | 'SELL'; confidence: number; reason: string } | null;
  tradeId: string | null;
  reason: string;
  diagnostic: DiagnosticPayload | null;
}

function ConditionRow({
  label,
  bullPass,
  bearPass,
  bullValue,
  bearValue,
  threshold,
}: {
  label: string;
  bullPass: boolean;
  bearPass: boolean;
  bullValue: string;
  bearValue: string;
  threshold: string;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr_1fr_80px] items-center gap-2 py-1.5 text-xs">
      <span className="text-[var(--color-text-secondary)]">{label}</span>
      <div className="flex items-center gap-1.5">
        {bullPass ? (
          <Check size={12} className="text-emerald-400" />
        ) : (
          <X size={12} className="text-red-400" />
        )}
        <span
          className={cn(
            'font-mono',
            bullPass ? 'text-emerald-400' : 'text-[var(--color-text-muted)]',
          )}
        >
          {bullValue}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        {bearPass ? (
          <Check size={12} className="text-emerald-400" />
        ) : (
          <X size={12} className="text-red-400" />
        )}
        <span
          className={cn(
            'font-mono',
            bearPass ? 'text-emerald-400' : 'text-[var(--color-text-muted)]',
          )}
        >
          {bearValue}
        </span>
      </div>
      <span className="text-right font-mono text-[10px] text-[var(--color-text-muted)]">
        ≥ {threshold}
      </span>
    </div>
  );
}

function SymbolCard({ result }: { result: ScanResult }) {
  const d = result.diagnostic;
  const fired = result.signal !== null && result.tradeId !== null;
  // Three "blocked" sub-states need different colours and different copy:
  //   1. Conditions aligned, transition guard says "already traded this"
  //      → green (this is correct behaviour — your trade is open)
  //   2. Conditions aligned, signal was emitted but downstream failed
  //      → amber (trade execution / strike selection error)
  //   3. Conditions not aligned at all → gray (no fire)
  const conditionsAligned = d?.direction != null;
  const signalEmitted = result.signal !== null;
  const tradeFailed = signalEmitted && !result.tradeId;
  const transitionBlocked =
    conditionsAligned && !signalEmitted && !tradeFailed;

  const cardBorder = fired
    ? 'border-emerald-500/50'
    : transitionBlocked
    ? 'border-emerald-500/30'
    : tradeFailed
    ? 'border-amber-500/40'
    : conditionsAligned
    ? 'border-emerald-500/30'
    : 'border-[var(--color-border-subtle)]';

  return (
    <div className={cn('rounded-lg border bg-[var(--color-bg-secondary)] p-4', cardBorder)}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
          {result.symbol}
        </h3>
        {fired ? (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
            FIRED → trade {result.tradeId?.slice(-6)}
          </span>
        ) : transitionBlocked ? (
          <span
            className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400"
            title="Conditions are aligned, but a trade for this setup was already placed on a previous tick. The strategy will re-fire only after the rule disengages and re-aligns."
          >
            TRADED ({d?.direction}) — won't re-fire
          </span>
        ) : tradeFailed ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-400">
            ERROR ({d?.direction}): {result.reason}
          </span>
        ) : (
          <span className="rounded-full bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
            no fire
          </span>
        )}
      </div>

      {!d ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          {result.reason}
        </p>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-[140px_1fr_1fr_80px] gap-2 border-b border-[var(--color-border-subtle)] pb-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            <span></span>
            <span>BULL side</span>
            <span>BEAR side</span>
            <span className="text-right">need</span>
          </div>

          <ConditionRow
            label="V25 hub %"
            bullPass={d.hubBullish}
            bearPass={d.hubBearish}
            bullValue={`${d.alignmentBullPct.toFixed(0)}% (${d.hubGreen}/${d.hubTotal})`}
            bearValue={`${d.alignmentBearPct.toFixed(0)}% (${d.hubRed}/${d.hubTotal})`}
            threshold={`${(d.thresholds.hub * 100).toFixed(0)}%`}
          />
          <ConditionRow
            label="Sniper bias %"
            bullPass={d.sniperBullOk}
            bearPass={d.sniperBearOk}
            bullValue={`${d.bullPct.toFixed(0)}% (${d.bScore}/7)`}
            bearValue={`${d.bearPct.toFixed(0)}% (${d.rScore}/7)`}
            threshold={`${d.thresholds.sniper}%`}
          />
          <ConditionRow
            label="V25 win prob"
            bullPass={d.winProbBullOk}
            bearPass={d.winProbBearOk}
            bullValue={`${d.winProb.toFixed(0)}`}
            bearValue={`${d.putProb.toFixed(0)}`}
            threshold={`${d.thresholds.winProb}`}
          />

          <div className="mt-3 rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)] p-2 text-[10px] text-[var(--color-text-muted)]">
            <span className="font-mono">{d.reason}</span>
          </div>
        </>
      )}
    </div>
  );
}

export default function AutoTradeDiagnostic() {
  const [results, setResults] = useState<ScanResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<Date | null>(null);

  const runScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 60s timeout: an on-demand scan walks 4 symbols and may rebuild MCX
      // option chains via per-leg broker calls — the global 15s default
      // isn't enough on a cold cache. Pass undefined (not null) so axios
      // sends no body — null gets serialized as "null" which trips Nest's
      // JSON body parser and returns a 400 Bad Request.
      const res = await api.post<ScanResult[]>('/signals/scan-now', undefined, { timeout: 60000 });
      setResults(res.data);
      setLastRunAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-[var(--color-accent-purple,#a78bfa)]" />
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Anand Sniper + V25 Auto-Trade Diagnostic
          </h3>
          {lastRunAt && (
            <span className="text-[10px] text-[var(--color-text-muted)]">
              · last run {lastRunAt.toLocaleTimeString('en-IN')}
            </span>
          )}
        </div>
        <button
          onClick={runScan}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-accent-purple,#a78bfa)]/40 bg-[var(--color-accent-purple,#a78bfa)]/10 px-3 py-1.5 text-xs font-semibold text-[var(--color-accent-purple,#a78bfa)] hover:bg-[var(--color-accent-purple,#a78bfa)]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              Scanning...
            </>
          ) : (
            <>
              <RefreshCw size={12} />
              Run Scan Now
            </>
          )}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-400">
          {error}
        </div>
      )}

      {!results && !loading && (
        <p className="text-xs text-[var(--color-text-muted)]">
          Click "Run Scan Now" to evaluate the rule on the latest 15m bar for every watched
          symbol (NIFTY, BANKNIFTY on NSE; CRUDEOIL, COPPER on MCX). The cron also runs this
          automatically every 15 min during market hours; this button is for on-demand checks.
        </p>
      )}

      {results && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-2">
          {results.map((r) => (
            <SymbolCard key={r.symbol} result={r} />
          ))}
        </div>
      )}
    </div>
  );
}
