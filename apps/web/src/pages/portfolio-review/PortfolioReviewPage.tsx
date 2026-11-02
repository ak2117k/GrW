import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { AlertTriangle, ClipboardCheck, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/common';
import { cn } from '@/utils/cn';
import { apiErrorMessage } from '@/pages/core-strategies/core-strategy-picker';
import { getPortfolioReview } from '@/services/portfolioReview';
import type { Bucket, HoldingCheck, Pattern, PortfolioReview, Suggestion } from '@/types/portfolioReview.types';
import { bucketLabel, inr, monthLabel, pct, pnlTone, severityVariant, tagVariant } from './portfolioReviewFormat';

const CARD = 'rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-3 sm:p-4';
const MUTED = 'text-[var(--color-text-muted)]';
const SECONDARY = 'text-[var(--color-text-secondary)]';
const PRIMARY = 'text-[var(--color-text-primary)]';
const TH = 'px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]';
const TD = 'px-2 py-1.5 text-xs sm:text-sm';

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className={CARD}>
      <h2 className={cn('text-sm font-semibold', PRIMARY)}>{title}</h2>
      {hint && <p className={cn('mt-0.5 text-xs', MUTED)}>{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className={CARD}>
      <div className={cn('text-[11px] font-medium uppercase tracking-wide', MUTED)}>{label}</div>
      <div className={cn('mt-1 text-lg font-semibold sm:text-xl', tone ?? PRIMARY)}>{value}</div>
      {sub && <div className={cn('mt-0.5 text-xs', SECONDARY)}>{sub}</div>}
    </div>
  );
}

function BucketTable({ rows, empty = 'No trades.' }: { rows: Bucket[]; empty?: string }) {
  if (!rows.length) return <p className={cn('text-xs', MUTED)}>{empty}</p>;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse">
        <thead>
          <tr className="border-b border-[var(--color-border-subtle)]">
            <th className={TH}>Bucket</th>
            <th className={cn(TH, 'text-right')}>Trades</th>
            <th className={cn(TH, 'text-right')}>Win %</th>
            <th className={cn(TH, 'text-right')}>Charges</th>
            <th className={cn(TH, 'text-right')}>Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.key} className="border-b border-[var(--color-border-subtle)] last:border-0">
              <td className={cn(TD, PRIMARY)}>{bucketLabel(b.key)}</td>
              <td className={cn(TD, 'text-right', SECONDARY)}>{b.trades}</td>
              <td className={cn(TD, 'text-right', SECONDARY)}>{b.winRate.toFixed(0)}%</td>
              <td className={cn(TD, 'text-right', SECONDARY)}>{inr(b.charges)}</td>
              <td className={cn(TD, 'text-right font-medium', pnlTone(b.net))}>{inr(b.net, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SuggestionCard({ s }: { s: Suggestion }) {
  return (
    <li className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)] p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-blue)]/15 text-xs font-semibold text-[var(--color-accent-blue)]">
          {s.rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('text-sm font-semibold', PRIMARY)}>{s.title}</span>
            <Badge label={s.category} size="sm" variant={s.category === 'RISK' ? 'danger' : s.category === 'HOLDING' ? 'warning' : 'info'} />
          </div>
          <p className={cn('mt-1 text-xs sm:text-sm', SECONDARY)}>{s.detail}</p>
          <p className={cn('mt-1 text-xs', MUTED)}>
            <span className="font-medium">Evidence:</span> {s.evidence}
          </p>
          <p className={cn('mt-1 text-xs', MUTED)}>At stake: {inr(s.impactRupees)}</p>
        </div>
      </div>
    </li>
  );
}

function PatternRow({ p }: { p: Pattern }) {
  return (
    <li className="border-b border-[var(--color-border-subtle)] py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('text-sm font-medium', PRIMARY)}>{p.title}</span>
        <Badge label={p.severity} size="sm" variant={severityVariant(p.severity)} />
      </div>
      <p className={cn('mt-1 text-xs sm:text-sm', SECONDARY)}>{p.finding}</p>
      {p.examples.length > 0 && <p className={cn('mt-1 text-xs', MUTED)}>e.g. {p.examples.join(' · ')}</p>}
    </li>
  );
}

function HoldingsTable({ rows }: { rows: HoldingCheck[] }) {
  if (!rows.length) return <p className={cn('text-xs', MUTED)}>No open holdings.</p>;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse">
        <thead>
          <tr className="border-b border-[var(--color-border-subtle)]">
            <th className={TH}>Holding</th>
            <th className={cn(TH, 'text-right')}>Cost</th>
            <th className={cn(TH, 'text-right')}>LTP</th>
            <th className={cn(TH, 'text-right')}>P&amp;L</th>
            <th className={cn(TH, 'text-right')}>Days</th>
            <th className={cn(TH, 'text-right')}>Book %</th>
            <th className={cn(TH, 'text-right')}>50 / 200-DMA</th>
            <th className={TH}>Tag</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => (
            <tr key={`${h.token}-${h.symbol}`} className="border-b border-[var(--color-border-subtle)] align-top last:border-0">
              <td className={cn(TD, PRIMARY)}>
                <div className="font-medium">{h.symbol}</div>
                <div className={cn('text-[11px]', MUTED)}>
                  {h.qty} @ {inr(h.avgCost)}
                </div>
                <div className={cn('mt-0.5 max-w-[280px] text-[11px]', SECONDARY)}>{h.note}</div>
              </td>
              <td className={cn(TD, 'text-right', SECONDARY)}>{inr(h.cost)}</td>
              <td className={cn(TD, 'text-right', SECONDARY)}>{h.ltp != null ? h.ltp.toLocaleString('en-IN') : '—'}</td>
              <td className={cn(TD, 'text-right font-medium', pnlTone(h.pnl))}>
                {inr(h.pnl, true)}
                <div className="text-[11px]">{pct(h.pnlPct, true)}</div>
              </td>
              <td className={cn(TD, 'text-right', SECONDARY)}>{h.daysHeld}</td>
              <td className={cn(TD, 'text-right', SECONDARY)}>{h.sharePct.toFixed(1)}%</td>
              <td className={cn(TD, 'text-right', SECONDARY)}>
                {h.trend.status === 'OK' ? `${h.trend.dma50 ?? '—'} / ${h.trend.dma200 ?? '—'}` : <span className={MUTED}>no data</span>}
                {h.trend.status === 'OK' && h.trend.ret6m != null && <div className="text-[11px]">6m {pct(h.trend.ret6m, true)}</div>}
              </td>
              <td className={TD}>
                <div className="flex flex-wrap gap-1">
                  {(h.tags.length ? h.tags : ['NEUTRAL' as const]).map((t) => (
                    <Badge key={t} label={t} size="sm" variant={tagVariant(t)} />
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Summary({ r }: { r: PortfolioReview }) {
  const s = r.summary;
  if (s.status === 'OK' && s.text) {
    return (
      <div className={cn('space-y-2 text-sm [&_li]:ml-4 [&_ol]:list-decimal [&_strong]:text-[var(--color-text-primary)] [&_ul]:list-disc', SECONDARY)}>
        <ReactMarkdown>{s.text}</ReactMarkdown>
      </div>
    );
  }
  return (
    <div className={cn('space-y-2 text-sm', SECONDARY)}>
      <p>{r.digest}</p>
      <p className={cn('text-xs', MUTED)}>AI summary: {s.reason ?? s.status.toLowerCase()}.</p>
    </div>
  );
}

export function PortfolioReviewView({ r, onRefresh, refreshing }: { r: PortfolioReview; onRefresh: () => void; refreshing: boolean }) {
  const h = r.headline;
  const b = r.breakdowns;
  const patterns = r.patterns.filter((p) => p.severity !== 'OK');
  const quiet = r.patterns.filter((p) => p.severity === 'OK');
  return (
    <div className="mx-auto max-w-6xl space-y-3 p-3 sm:space-y-4 sm:p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className={cn('flex items-center gap-2 text-lg font-semibold', PRIMARY)}>
            <ClipboardCheck className="h-5 w-5" /> Portfolio review
          </h1>
          <p className={cn('text-xs', MUTED)}>
            Real broker book since {h.trackedSince ?? '—'} (paper trades excluded) · generated {new Date(r.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex min-h-10 items-center gap-2 rounded border border-[var(--color-border-default)] px-3 text-sm text-[var(--color-text-secondary)] disabled:opacity-60"
        >
          <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /> {refreshing ? 'Analysing…' : 'Re-analyse'}
        </button>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <Stat label="Total P&L" value={inr(h.total, true)} tone={pnlTone(h.total)} sub="realised net + unrealised" />
        <Stat label="Realised (net)" value={inr(h.realisedNet, true)} tone={pnlTone(h.realisedNet)} sub={`gross ${inr(h.realisedGross, true)} · charges ~${inr(h.charges)}`} />
        <Stat label="Unrealised" value={inr(h.unrealised, true)} tone={pnlTone(h.unrealised)} sub={`${h.openHoldings} holdings on ${inr(h.holdingsCost)} cost`} />
        <Stat label="Trades" value={String(h.trades)} sub={`win rate ${h.winRate.toFixed(1)}%`} />
        <Stat label="Avg win / loss" value={`${inr(h.avgWin)} / ${inr(h.avgLoss)}`} />
        <Stat label="Profit factor" value={h.profitFactor != null ? h.profitFactor.toFixed(2) : '—'} sub="gross wins ÷ gross losses (net)" />
        <Stat label="Expectancy" value={inr(h.expectancy, true)} tone={pnlTone(h.expectancy)} sub="per trade, net" />
        <Stat label="Holdings value" value={inr(h.holdingsValue)} sub={`cost ${inr(h.holdingsCost)}`} />
      </div>

      <Section title="Summary">
        <Summary r={r} />
      </Section>

      <Section title="What to change" hint="Ranked by rupees at stake. These are risk and behaviour changes for you to decide on — not predictions.">
        {r.suggestions.length ? (
          <ol className="space-y-2">
            {r.suggestions.map((s) => (
              <SuggestionCard key={s.id} s={s} />
            ))}
          </ol>
        ) : (
          <p className={cn('text-xs', MUTED)}>No rule fired.</p>
        )}
      </Section>

      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Realised by month">
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[360px] border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)]">
                  <th className={TH}>Month</th>
                  <th className={cn(TH, 'text-right')}>Trades</th>
                  <th className={cn(TH, 'text-right')}>Charges</th>
                  <th className={cn(TH, 'text-right')}>Net</th>
                </tr>
              </thead>
              <tbody>
                {h.byMonth.map((m) => (
                  <tr key={m.month} className="border-b border-[var(--color-border-subtle)] last:border-0">
                    <td className={cn(TD, PRIMARY)}>{monthLabel(m.month)}</td>
                    <td className={cn(TD, 'text-right', SECONDARY)}>{m.trades}</td>
                    <td className={cn(TD, 'text-right', SECONDARY)}>{inr(m.charges)}</td>
                    <td className={cn(TD, 'text-right font-medium', pnlTone(m.net))}>{inr(m.net, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
        <Section title="Largest losses">
          <ul className="space-y-1">
            {h.largestLosses.map((l) => (
              <li key={`${l.symbol}-${l.exitDay}`} className="flex items-center justify-between gap-2 text-xs sm:text-sm">
                <span className={PRIMARY}>
                  {l.symbol} <span className={MUTED}>· {l.exitDay} · {bucketLabel(l.closedBy ?? '')}</span>
                </span>
                <span className={cn('font-medium', pnlTone(l.net))}>{inr(l.net, true)}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <h2 className={cn('pt-1 text-base font-semibold', PRIMARY)}>Where the loss comes from</h2>
      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="By segment">
          <BucketTable rows={b.bySegment} />
        </Section>
        <Section title="By underlying" hint="Worst 15">
          <BucketTable rows={b.byUnderlying} />
        </Section>
        <Section title="By holding period">
          <BucketTable rows={b.byHoldingPeriod} />
        </Section>
        <Section title="By who closed it">
          <BucketTable rows={b.byClosedBy} />
        </Section>
        <Section title="Options: days to expiry at entry">
          <BucketTable rows={b.byOptionDte} empty="No option trades." />
        </Section>
        <Section title="Options: premium vs strike" hint="A moneyness proxy — spot at entry is not stored.">
          <BucketTable rows={b.byOptionPremium} empty="No option trades." />
        </Section>
        <Section title="Options: calls vs puts">
          <BucketTable rows={b.byOptionType} empty="No option trades." />
        </Section>
        <Section title="Entry time (IST, positions)" hint="When the app first saw the position (within ~10 min of the fill).">
          <BucketTable rows={b.byEntryTime} />
        </Section>
      </div>

      <Section title="Behaviour patterns">
        <ul>
          {patterns.map((p) => (
            <PatternRow key={p.id} p={p} />
          ))}
        </ul>
        {quiet.length > 0 && <p className={cn('mt-2 text-xs', MUTED)}>No issue found: {quiet.map((p) => p.title.toLowerCase()).join(', ')}.</p>}
      </Section>

      <Section title="Holdings check" hint="Tags: DEAD-MONEY ≤ −20% after 60+ days · WEAK-TREND below 50- and 200-DMA · CONCENTRATED ≥ 15% of the book · STRONG above the averages and in profit.">
        <HoldingsTable rows={r.holdings} />
      </Section>

      <Section title="Data quality">
        <ul className={cn('list-disc space-y-1 pl-4 text-xs', SECONDARY)}>
          {r.dataQuality.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          <li>{r.dataQuality.chargesMethod}</li>
        </ul>
      </Section>
    </div>
  );
}

/** Portfolio review: where the P&L comes from and what to change. */
export default function PortfolioReviewPage() {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['portfolio-review'], queryFn: () => getPortfolioReview(false), staleTime: 5 * 60_000 });

  const onRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      qc.setQueryData(['portfolio-review'], await getPortfolioReview(true));
    } catch (e) {
      setRefreshError(apiErrorMessage(e, 'Could not re-analyse'));
    } finally {
      setRefreshing(false);
    }
  };

  if (q.isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-3 p-4">
        <h1 className={cn('text-lg font-semibold', PRIMARY)}>Portfolio review</h1>
        <p className={cn('text-sm', SECONDARY)}>Analysing your trades and holdings… the first run reads a year of prices per holding and can take a minute.</p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={cn(CARD, 'h-20 animate-pulse')} />
          ))}
        </div>
      </div>
    );
  }

  if (q.isError || !q.data) {
    return (
      <div className="mx-auto max-w-6xl space-y-3 p-4">
        <h1 className={cn('text-lg font-semibold', PRIMARY)}>Portfolio review</h1>
        <p className="flex items-center gap-2 text-sm text-[var(--color-accent-red)]">
          <AlertTriangle className="h-4 w-4" /> {apiErrorMessage(q.error, 'Could not load the portfolio review')}
        </p>
        <button type="button" onClick={() => void q.refetch()} className="min-h-10 rounded border border-[var(--color-border-default)] px-3 text-sm text-[var(--color-text-secondary)]">
          Try again
        </button>
      </div>
    );
  }

  return (
    <>
      {refreshError && <p className="mx-auto max-w-6xl px-4 pt-3 text-sm text-[var(--color-accent-red)]">{refreshError}</p>}
      <PortfolioReviewView r={q.data} onRefresh={() => void onRefresh()} refreshing={refreshing} />
    </>
  );
}
