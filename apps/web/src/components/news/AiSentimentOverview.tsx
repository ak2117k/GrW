import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { cn } from '@/utils/cn';
import { getNewsSentimentOverview, type AiOverviewGroup, type AiSentimentOverview as Overview } from '@/services/newsAi';
import KeywordSentimentOverview, { type KeywordSentimentCounts } from './KeywordSentimentOverview';
import { DIR_BAR, DIR_LABEL, DIR_TEXT, scoreDir, scoreLabel, scoreTo100, type DirKey } from './newsAiFormat';

/**
 * True when the AI overview has nothing worth showing (→ keyword fallback): analysis off, tables
 * not set up, or no AI-read articles in the window. The server always lists the pinned groups
 * (NIFTY, CRUDEOIL, …) even at zero, so this goes by `total`, not by rows.
 */
export function overviewIsEmpty(o: Overview | null | undefined): boolean {
  return !o || !o.enabled || !o.ready || o.total === 0;
}

/** Articles behind one group row. */
export const groupCount = (g: AiOverviewGroup) => g.counts.BULL + g.counts.BEAR;

/** Rows worth a bar: at least one article, busiest first. */
function topRows(rows: AiOverviewGroup[], n: number): AiOverviewGroup[] {
  return rows.filter((r) => groupCount(r) > 0).sort((a, b) => groupCount(b) - groupCount(a)).slice(0, n);
}

function ScoreGroup({ title, rows }: { title: string; rows: AiOverviewGroup[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-4">
      <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{title}</h4>
      <div className="space-y-1.5">
        {rows.map((r) => <ScoreRow key={r.name} row={r} />)}
      </div>
    </div>
  );
}

const BUCKETS: { key: keyof Overview['overall']['counts']; dir: DirKey }[] = [
  { key: 'BULL', dir: 'bull' },
  { key: 'BEAR', dir: 'bear' },
  { key: 'MIXED', dir: 'mixed' },
  { key: 'NEUTRAL', dir: 'neutral' },
];

/** One diverging bar: centre line, fill left (bear) or right (bull). */
function ScoreRow({ row }: { row: AiOverviewGroup }) {
  const count = groupCount(row);
  const v = scoreTo100(row.score);
  const dk = scoreDir(row.score);
  const half = Math.min(50, Math.abs(v) / 2);
  return (
    <div className="flex items-center gap-2" title={`${row.name}: score ${scoreLabel(row.score)} from ${count} article${count === 1 ? '' : 's'}`}>
      <span className="w-24 shrink-0 truncate text-xs text-[var(--color-text-secondary)]">{row.name}</span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-gray-700">
        <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--color-border-default)]" />
        <div
          className={cn('absolute inset-y-0 rounded-full', DIR_BAR[dk])}
          style={v >= 0 ? { left: '50%', width: `${half}%` } : { right: '50%', width: `${half}%` }}
        />
      </div>
      <span className={cn('w-9 shrink-0 text-right font-mono text-[11px] font-medium', DIR_TEXT[dk])}>{scoreLabel(row.score)}</span>
      <span className="w-6 shrink-0 text-right text-[10px] text-[var(--color-text-muted)]">{count}</span>
    </div>
  );
}

export function AiSentimentOverviewView({ overview }: { overview: Overview }) {
  const counts = overview.overall.counts;
  const total = overview.total;
  const hours = overview.hours;
  const dk = scoreDir(overview.overall.score);
  const indices = topRows(overview.indices, 8);
  const sectors = topRows(overview.sectors, 10);
  const commodities = topRows(overview.commodities, 6);

  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4" data-testid="ai-sentiment">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--color-text-primary)]">
            <Sparkles size={13} className="text-[var(--color-accent-blue)]" />
            AI Sentiment
          </h3>
          <p className="text-[10px] text-[var(--color-text-muted)]">
            Claude&apos;s read of {total} article{total === 1 ? '' : 's'}, last {hours}h
          </p>
        </div>
        <div className="text-right">
          <div className={cn('font-mono text-lg font-bold leading-none', DIR_TEXT[dk])}>{scoreLabel(overview.overall.score)}</div>
          <div className={cn('text-[10px]', DIR_TEXT[dk])}>{DIR_LABEL[dk]}</div>
        </div>
      </div>

      {/* Stacked mix bar */}
      <div className="flex h-2 overflow-hidden rounded-full bg-gray-700" aria-hidden>
        {total > 0 &&
          BUCKETS.map((b) =>
            counts[b.key] > 0 ? (
              <div key={b.key} className={DIR_BAR[b.dir]} style={{ width: `${(counts[b.key] / total) * 100}%` }} />
            ) : null,
          )}
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1 text-center">
        {BUCKETS.map((b) => (
          <div key={b.key}>
            <div className={cn('text-xs font-semibold', DIR_TEXT[b.dir])}>{counts[b.key]}</div>
            <div className="text-[10px] text-[var(--color-text-muted)]">{DIR_LABEL[b.dir]}</div>
          </div>
        ))}
      </div>

      <ScoreGroup title="Indices" rows={indices} />
      <ScoreGroup title="Sectors" rows={sectors} />
      <ScoreGroup title="Commodities" rows={commodities} />
    </div>
  );
}

/**
 * AI sentiment overview with the keyword overview as fallback: shown while
 * the AI call loads, when it fails, or when it has no data.
 */
export default function AiSentimentOverview({
  fallbackCounts,
  hours = 24,
}: {
  fallbackCounts: KeywordSentimentCounts;
  hours?: number;
}) {
  const q = useQuery({
    queryKey: ['news-ai', 'sentiment-overview', hours],
    queryFn: () => getNewsSentimentOverview(hours),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    retry: false,
  });

  if (q.data && !overviewIsEmpty(q.data)) {
    return <AiSentimentOverviewView overview={q.data} />;
  }
  const note = q.isLoading
    ? 'Keyword count — loading AI sentiment…'
    : q.isError
      ? 'Keyword count — AI sentiment unavailable'
      : q.data && !q.data.enabled
        ? 'Keyword count — AI analysis is off'
        : q.data && !q.data.ready
          ? 'Keyword count — AI analysis not set up yet'
          : 'Keyword count — no AI reads yet';
  return <KeywordSentimentOverview counts={fallbackCounts} note={note} />;
}
