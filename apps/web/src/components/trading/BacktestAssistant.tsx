import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Sparkles, Loader2, AlertCircle } from 'lucide-react';
import {
  askBacktestAssistant,
  getAssistantRequest,
  getAssistantStatus,
  type AssistantRequest,
  type AssistantStatus,
} from '@/services/backtest-assistant';

const STEP_LABEL: Record<string, string> = {
  queued: 'Queued…',
  spec: 'Claude is turning your request into a backtest spec…',
  fetching: 'Checking / fetching price history…',
  running: 'Running the backtest engine…',
  summarising: 'Claude is summarising the results…',
};
const IN_FLIGHT = new Set(['queued', 'spec', 'fetching', 'running', 'summarising']);
const MD =
  'text-xs leading-relaxed text-[var(--color-text-secondary)] [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-4 [&_li]:mb-1 [&_strong]:font-semibold [&_strong]:text-[var(--color-text-primary)]';

function pct(n: number | null | undefined) {
  return n == null ? '—' : `${n.toFixed(2)}%`;
}

/**
 * "Ask Claude to backtest…" — owner only. Renders nothing for anyone else (the API answers
 * `allowed: false`), so other users keep the plain backtest page.
 */
export default function BacktestAssistant({ onRunReady }: { onRunReady: (runId: string) => void }) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [prompt, setPrompt] = useState('');
  const [req, setReq] = useState<AssistantRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const loadedRun = useRef<string | null>(null);

  useEffect(() => {
    getAssistantStatus().then(setStatus).catch(() => setStatus({ allowed: false }));
  }, []);

  // Poll the request while it is in flight.
  useEffect(() => {
    if (!req || !IN_FLIGHT.has(req.status)) return;
    const t = setTimeout(() => {
      getAssistantRequest(req.id).then(setReq).catch(() => undefined);
    }, 2500);
    return () => clearTimeout(t);
  }, [req]);

  useEffect(() => {
    if (req?.status === 'done' && req.runId && loadedRun.current !== req.runId) {
      loadedRun.current = req.runId;
      onRunReady(req.runId);
      getAssistantStatus().then(setStatus).catch(() => undefined);
    }
  }, [req, onRunReady]);

  if (!status?.allowed) return null;

  const busy = submitting || (req != null && IN_FLIGHT.has(req.status));
  const tooLong = prompt.length > 800;

  async function submit() {
    if (!prompt.trim() || busy || tooLong) return;
    setSubmitting(true);
    try {
      setReq(await askBacktestAssistant(prompt.trim()));
    } catch {
      // api interceptor shows the error
    } finally {
      setSubmitting(false);
    }
  }

  const m = req?.metrics;
  return (
    <div className="rounded-xl border border-[var(--color-accent-purple,#a78bfa)]/30 bg-[var(--color-bg-secondary)] p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
          <Sparkles size={14} className="text-[var(--color-accent-purple,#a78bfa)]" />
          Ask Claude to backtest…
        </div>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {status.usedToday ?? 0}/{status.dailyCap ?? 0} today · owner only
        </span>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
        }}
        rows={2}
        placeholder="e.g. backtest a 20/50 EMA crossover on TATAMOTORS 15m for 2 years with a 1.5% stop"
        className="w-full resize-none rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] p-2 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent-purple,#a78bfa)]"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className={tooLong ? 'text-[10px] text-[var(--color-accent-red)]' : 'text-[10px] text-[var(--color-text-muted)]'}>
          {prompt.length}/800 · indicators, entry/exit, stop, symbol, timeframe, period
        </span>
        <button
          onClick={submit}
          disabled={busy || !prompt.trim() || tooLong}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent-purple,#a78bfa)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          Backtest
        </button>
      </div>

      {req && IN_FLIGHT.has(req.status) && (
        <div className="mt-3 flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
          <Loader2 size={12} className="animate-spin" />
          <span>{STEP_LABEL[req.status]}</span>
          {req.status === 'fetching' && req.progress?.windowsTotal ? (
            <span className="tabular-nums text-[var(--color-text-muted)]">
              {req.progress.windowsDone ?? 0}/{req.progress.windowsTotal} windows · {req.progress.calls ?? 0}/{req.progress.budget ?? 0} calls
            </span>
          ) : null}
        </div>
      )}

      {req && (req.status === 'refused' || req.status === 'error') && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-[var(--color-accent-red)]/10 p-2 text-xs text-[var(--color-accent-red)]">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{req.error}</span>
        </div>
      )}

      {req?.spec?.resolved && (
        <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-[var(--color-bg-tertiary)] p-2 text-[10px] leading-relaxed text-[var(--color-text-secondary)]">
          {req.spec.resolved.described}
        </pre>
      )}

      {req?.status === 'done' && m && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            {[
              ['Trades', String(m.trades)],
              ['Win rate', pct(m.winRate)],
              ['PF (after costs)', m.profitFactorAfterCosts == null ? '—' : m.profitFactorAfterCosts.toFixed(2)],
              ['Return after costs', pct(m.returnAfterCostsPct)],
              ['Max DD', pct(m.maxDrawdownPct)],
              ['Expectancy/trade', `₹${Math.round(m.expectancyAfterCosts).toLocaleString('en-IN')}`],
              ['Est. costs', `₹${Math.round(m.estCosts).toLocaleString('en-IN')}`],
              ['Bars', m.data ? `${m.data.bars.toLocaleString('en-IN')}${m.data.partial ? ' (partial)' : ''}` : '—'],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-[var(--color-bg-tertiary)] p-2">
                <p className="text-[10px] text-[var(--color-text-muted)]">{k}</p>
                <p className="text-xs font-bold tabular-nums text-[var(--color-text-primary)]">{v}</p>
              </div>
            ))}
          </div>
          {m.byYear.length > 0 && (
            <table className="w-full text-[10px] tabular-nums">
              <thead>
                <tr className="text-[var(--color-text-muted)]">
                  <th className="text-left font-medium">Year</th>
                  <th className="text-right font-medium">Trades</th>
                  <th className="text-right font-medium">Win %</th>
                  <th className="text-right font-medium">P&amp;L after costs</th>
                </tr>
              </thead>
              <tbody className="text-[var(--color-text-secondary)]">
                {m.byYear.map((y) => (
                  <tr key={y.year}>
                    <td>{y.year}</td>
                    <td className="text-right">{y.trades}</td>
                    <td className="text-right">{y.winRate.toFixed(1)}</td>
                    <td className={y.pnlAfterCosts >= 0 ? 'text-right text-[var(--color-accent-green)]' : 'text-right text-[var(--color-accent-red)]'}>
                      {Math.round(y.pnlAfterCosts).toLocaleString('en-IN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {req.summary && (
            <div className={MD}>
              <ReactMarkdown>{req.summary}</ReactMarkdown>
            </div>
          )}
          {req.error && <p className="text-[10px] text-[var(--color-text-muted)]">{req.error}</p>}
          <p className="text-[10px] text-[var(--color-text-muted)]">
            Data: {m.data?.source ?? '?'}
            {m.data?.fetch && m.data.fetch.status !== 'noop' ? ` · fetch ${m.data.fetch.status}: ${m.data.fetch.message}` : ''}
            {req.cachedFrom ? ' · served from cache (no Claude call)' : ''} · costs ≈ {m.costBpsPerSide} bps/side
          </p>
        </div>
      )}
    </div>
  );
}
