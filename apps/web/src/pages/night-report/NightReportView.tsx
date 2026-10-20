import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, ExternalLink, Moon, RefreshCw } from 'lucide-react';
import { Badge, SymbolChartLink } from '@/components/common';
import { cn } from '@/utils/cn';
import type {
  EventItem,
  JobItem,
  MoodView,
  NewsGroup,
  FactorScore,
  NewsIdeaRow,
  NewsItem,
  NightReport,
  PositionRow,
  Scorecard,
  Section,
  SetupItem,
  SymbolRef,
  VerdictView,
} from '@/types/nightReport.types';
import {
  agoLabel,
  bandLabel,
  bandVariant,
  bpPct,
  factorLabel,
  ideaBadge,
  ideaOutcome,
  ideaSymbolRef,
  orderedFactors,
  pointsTone,
  signedPoints,
  sortIdeasNewestFirst,
  verdictDisagreesWithBand,
  verdictForScorecard,
  impactVariant,
  isSectionError,
  istDate,
  istDateTime,
  istTime,
  jobVariant,
  rupees,
  safeExternalUrl,
  sentenceCase,
  sentimentTone,
  setupActionLabel,
  setupLabel,
  summaryLine,
  toneVariant,
  verdictLabel,
  verdictTone,
  windowLabel,
} from './nightReportFormat';

const CARD = 'rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-3 sm:p-4';
const MUTED = 'text-[var(--color-text-muted)]';
const SECONDARY = 'text-[var(--color-text-secondary)]';
const PRIMARY = 'text-[var(--color-text-primary)]';

// ---------------------------------------------------------------- small pieces

/**
 * A symbol that opens its chart. 40px tall so a thumb can hit it. Goes through
 * `SymbolChartLink`, which resolves the token on click for symbols that arrive
 * without one (MCX underlyings, news symbols); `chartHref` is only the fallback.
 */
export function SymbolChip({ symbol, subtle }: { symbol: SymbolRef; subtle?: boolean }) {
  const cls = cn(
    'min-h-10 rounded-full border px-3 text-xs font-medium',
    'hover:border-[var(--color-accent-blue)]',
    subtle
      ? 'border-[var(--color-border-subtle)] text-[var(--color-text-secondary)]'
      : 'border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]',
  );
  if (!symbol.symbol) {
    return (
      <Link to={symbol.chartHref} className={cn('inline-flex items-center', cls)}>
        Chart
      </Link>
    );
  }
  return <SymbolChartLink symbol={symbol.symbol} token={symbol.token} exchange={symbol.exchange} className={cls} />;
}

/** Long text clamped to a few lines with a "More" toggle. */
function Expandable({ text, lines = 3, className }: { text: string; lines?: 2 | 3; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160;
  return (
    <div className={className}>
      <p className={cn(!open && long && (lines === 2 ? 'line-clamp-2' : 'line-clamp-3'))}>{text}</p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="min-h-10 text-xs font-medium text-[var(--color-accent-blue)]"
        >
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}

function SectionShell({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="space-y-2" aria-label={title}>
      <h2 className={cn('flex items-center gap-2 text-sm font-semibold uppercase tracking-wide', SECONDARY)}>
        {title}
        {count != null && count > 0 && <span className={cn('text-xs font-normal normal-case', MUTED)}>({count})</span>}
      </h2>
      {children}
    </section>
  );
}

function SectionFailed() {
  return <p className={cn('text-sm', MUTED)}>Couldn't load this section</p>;
}

function Empty({ text }: { text: string }) {
  return <p className={cn(CARD, 'text-sm', MUTED)}>{text}</p>;
}

/** Renders a section's payload, or the one-line failure when the API sent `{ error }`. */
function Guard<T>({ value, children }: { value: Section<T>; children: (v: T) => ReactNode }) {
  if (isSectionError(value)) return <SectionFailed />;
  return <>{children(value as T)}</>;
}

// ---------------------------------------------------------------- header

function Header({
  report,
  onRefresh,
  refreshing,
  onRerun,
  rerunning,
  rerunNote,
}: {
  report: NightReport;
  onRefresh?: () => void;
  refreshing?: boolean;
  onRerun?: () => void;
  rerunning?: boolean;
  rerunNote?: string | null;
}) {
  const w = report.window;
  return (
    <header className="space-y-2">
      <div className="flex items-start gap-2">
        <Moon size={20} className="mt-0.5 shrink-0 text-[var(--color-accent-blue)]" />
        <div className="min-w-0 flex-1">
          <h1 className={cn('text-lg font-semibold', PRIMARY)}>Night Report</h1>
          <p className={cn('text-xs', MUTED)}>
            {istDateTime(w.from)} → {istDateTime(w.to)} IST
            {w.nextOpen && <> · next open {istDateTime(w.nextOpen)}</>}
          </p>
        </div>
        {onRerun && (
          <button
            type="button"
            onClick={onRerun}
            disabled={rerunning}
            className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded border border-[var(--color-border-default)] px-3 text-sm text-[var(--color-text-secondary)] disabled:opacity-50"
          >
            <Moon size={14} className={cn(rerunning && 'animate-pulse')} />
            <span>{rerunning ? 'Re-running…' : 'Re-run analysis'}</span>
          </button>
        )}
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh"
            className="inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded border border-[var(--color-border-default)] px-3 text-sm text-[var(--color-text-secondary)] disabled:opacity-50"
          >
            <RefreshCw size={14} className={cn(refreshing && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        )}
      </div>
      {rerunNote && (
        <p data-testid="night-rerun-note" className={cn('rounded border border-[var(--color-border-subtle)] px-3 py-2 text-xs', MUTED)}>
          {rerunNote}
        </p>
      )}
      {w.holidayNote && (
        <p className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">{w.holidayNote}</p>
      )}
      <p
        data-testid="night-summary"
        className={cn('rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)] px-3 py-2 text-sm', PRIMARY)}
      >
        {summaryLine(report.summary)}
      </p>
    </header>
  );
}

// ---------------------------------------------------------------- positions

function VerdictBadge({ v }: { v: VerdictView | null }) {
  const tone = verdictTone(v?.verdict);
  return <Badge label={verdictLabel(v?.verdict)} variant={toneVariant(tone)} />;
}

function CompactVerdict({ label, v }: { label: string; v: VerdictView | null }) {
  if (!v) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className={cn('font-medium', SECONDARY)}>{label}:</span>
      <Badge label={verdictLabel(v.verdict)} variant={toneVariant(verdictTone(v.verdict))} size="sm" />
      <span className={MUTED}>{agoLabel(v.at)}</span>
      {v.risk && <span className={cn('w-full truncate', MUTED)} title={v.risk}>{v.risk}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- scorecard

const PIP_ON = { pos: 'bg-emerald-400', neg: 'bg-red-400', zero: 'bg-gray-400' } as const;
const POINTS_TEXT = { pos: 'text-emerald-400', neg: 'text-red-400', zero: MUTED } as const;

/** −2…+2 as four pips around a centre line plus the signed number. */
function PointsPips({ points, dim }: { points: number; dim?: boolean }) {
  const tone = pointsTone(points);
  const pip = (slot: number) => {
    const on = (slot < 0 && points <= slot) || (slot > 0 && points >= slot);
    return (
      <span
        key={slot}
        className={cn('h-2 w-2 rounded-sm', on ? PIP_ON[tone] : 'bg-[var(--color-border-subtle)]')}
      />
    );
  };
  return (
    <span className={cn('inline-flex items-center gap-1.5', dim && 'opacity-50')} aria-label={`${signedPoints(points)} points`}>
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        {pip(-2)}
        {pip(-1)}
        <span className="mx-0.5 h-3 w-px bg-[var(--color-border-default)]" />
        {pip(1)}
        {pip(2)}
      </span>
      <span className={cn('w-6 text-right text-xs font-semibold tabular-nums', POINTS_TEXT[tone])}>{signedPoints(points)}</span>
    </span>
  );
}

function BandChip({ card }: { card: Scorecard }) {
  return <Badge label={`${bandLabel(card.band)} ${signedPoints(card.total)}`} variant={bandVariant(card.band)} size="sm" />;
}

function DisagreeChip() {
  return (
    <span
      data-testid="scorecard-disagrees"
      title="The agent's verdict points the other way from the scorecard"
      className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400"
    >
      <AlertTriangle size={11} />
      Disagrees with scorecard
    </span>
  );
}

/** Factor rows: label + pips, then the raw reading and reason. Unavailable factors are greyed. */
function FactorList({ factors }: { factors: FactorScore[] }) {
  return (
    <ul className="divide-y divide-[var(--color-border-subtle)]" data-testid="scorecard-factors">
      {orderedFactors(factors).map((f) => (
        <li key={f.name} className={cn('space-y-0.5 py-1.5', !f.available && 'opacity-60')} data-available={f.available}>
          <div className="flex items-center gap-2">
            <span className={cn('flex-1 text-xs font-medium', f.available ? PRIMARY : MUTED)}>{factorLabel(f.name)}</span>
            <PointsPips points={f.points} dim={!f.available} />
          </div>
          {f.value && <p className={cn('break-words text-[11px] tabular-nums', SECONDARY)}>{f.value}</p>}
          {f.reason && <p className={cn('text-[11px]', MUTED)}>{f.available ? f.reason : `Missing: ${f.reason}`}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Collapsible scorecard: the summary line (band, total, age) is always visible; tap to see the factors. */
function ScorecardBlock({ card, disagrees }: { card: Scorecard; disagrees?: boolean }) {
  return (
    <details className="group border-t border-[var(--color-border-subtle)] pt-2" data-testid="scorecard">
      <summary className="flex min-h-10 cursor-pointer list-none flex-wrap items-center gap-2 text-xs [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} className={cn('shrink-0 transition-transform group-open:rotate-90', MUTED)} />
        <span className={cn('font-medium', SECONDARY)}>Scorecard</span>
        <BandChip card={card} />
        {disagrees && <DisagreeChip />}
        <span className={cn('ml-auto', MUTED)}>{agoLabel(card.computedAt)}</span>
      </summary>
      <div className="pt-1">
        <p className={cn('text-[11px]', MUTED)}>
          Needs a {card.side === 'BULLISH' ? 'rise' : 'fall'} in {card.underlying || card.symbol} · + supports the position
        </p>
        <FactorList factors={card.factors} />
      </div>
    </details>
  );
}

function PositionCard({ p }: { p: PositionRow }) {
  const o = p.overnight;
  const card = p.scorecard ?? null;
  const disagrees = card ? verdictDisagreesWithBand(verdictForScorecard(p)?.verdict, card.band) : false;
  const pnlCls = p.pnl == null ? MUTED : p.pnl >= 0 ? 'text-emerald-400' : 'text-red-400';
  return (
    <article className={cn(CARD, 'space-y-2')} data-testid="night-position">
      <div className="flex flex-wrap items-center gap-2">
        <SymbolChip symbol={p.instrument} />
        {p.underlying && <SymbolChip symbol={p.underlying} subtle />}
        <span className={cn('text-xs', MUTED)}>{sentenceCase(p.kind)}</span>
        {p.held && <Badge label="Held" variant="info" size="sm" />}
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {card && <BandChip card={card} />}
          <VerdictBadge v={o} />
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className={MUTED}>Qty</dt>
          <dd className={cn('tabular-nums', PRIMARY)}>{p.qty}</dd>
        </div>
        <div>
          <dt className={MUTED}>Entry</dt>
          <dd className={cn('tabular-nums', PRIMARY)}>{rupees(p.entryPrice)}</dd>
        </div>
        <div>
          <dt className={MUTED}>LTP</dt>
          <dd className={cn('tabular-nums', PRIMARY)}>{rupees(p.ltp)}</dd>
        </div>
        <div>
          <dt className={MUTED}>P&amp;L</dt>
          <dd className={cn('tabular-nums font-medium', pnlCls)}>
            {rupees(p.pnl, true)}
            {p.pnlPct != null && Number.isFinite(p.pnlPct) && (
              <span className="ml-1 text-[11px]">({p.pnlPct >= 0 ? '+' : '−'}{Math.abs(p.pnlPct).toFixed(2)}%)</span>
            )}
          </dd>
        </div>
      </dl>
      {o ? (
        <div className={cn('space-y-1 border-t border-[var(--color-border-subtle)] pt-2 text-sm', SECONDARY)}>
          <p className={cn('text-[11px]', MUTED)}>
            {windowLabel(o.window)} · {agoLabel(o.at)}
            {o.confidence && <> · confidence {o.confidence}</>}
          </p>
          {o.plan && (
            <div>
              <span className="text-xs font-medium">At the open:</span>
              <Expandable text={o.plan} />
            </div>
          )}
          {o.risk && (
            <div>
              <span className="text-xs font-medium">Overnight risk:</span>
              <Expandable text={o.risk} className={MUTED} />
            </div>
          )}
          {o.invalidation && (
            <p className="text-xs">
              <span className="font-medium">Changes its mind:</span> <span className={MUTED}>{o.invalidation}</span>
            </p>
          )}
        </div>
      ) : (
        <p className={cn('text-xs', MUTED)}>No overnight review for this position.</p>
      )}
      {(p.preOpen || p.live) && (
        <div className="space-y-1 border-t border-[var(--color-border-subtle)] pt-2">
          <CompactVerdict label="Pre-open" v={p.preOpen} />
          <CompactVerdict label="Live" v={p.live} />
        </div>
      )}
      {card ? (
        <ScorecardBlock card={card} disagrees={disagrees} />
      ) : (
        <p className={cn('border-t border-[var(--color-border-subtle)] pt-2 text-xs', MUTED)}>No scorecard yet.</p>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- news

const SENTIMENT_DOT = {
  positive: 'bg-emerald-400',
  negative: 'bg-red-400',
  neutral: 'bg-gray-400',
} as const;

export function NewsItemRow({ item }: { item: NewsItem }) {
  const tone = sentimentTone(item.sentiment, item.sentimentScore);
  // Feed URLs are external input: only http(s) becomes a link (a `javascript:` URL would run on click).
  const href = safeExternalUrl(item.url);
  const headline = (
    <>
      <span
        className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', SENTIMENT_DOT[tone])}
        title={`Sentiment: ${item.sentiment ?? tone}`}
        aria-label={`Sentiment ${tone}`}
      />
      <span className="flex-1">{item.title}</span>
    </>
  );
  return (
    <li className="space-y-1 py-2" data-testid="night-news-item">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('flex min-h-10 items-start gap-2 text-sm font-medium hover:underline', PRIMARY)}
        >
          {headline}
          <ExternalLink size={12} className="mt-1 shrink-0 opacity-60" />
        </a>
      ) : (
        <p className={cn('flex min-h-10 items-start gap-2 text-sm font-medium', PRIMARY)}>{headline}</p>
      )}
      <p className={cn('pl-4 text-[11px]', MUTED)}>
        {item.source} · {agoLabel(item.publishedAt)}
      </p>
      {item.summary && <p className={cn('line-clamp-2 pl-4 text-xs', SECONDARY)}>{item.summary}</p>}
      {item.symbols.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pl-4">
          {item.symbols.map((s) => (
            <SymbolChip key={`${s.exchange}:${s.symbol}`} symbol={s} subtle />
          ))}
        </div>
      )}
    </li>
  );
}

function NewsList({ items }: { items: NewsItem[] }) {
  return (
    <ul className="divide-y divide-[var(--color-border-subtle)]">
      {items.map((i) => (
        <NewsItemRow key={i.id} item={i} />
      ))}
    </ul>
  );
}

function NewsGroups({ groups }: { groups: NewsGroup[] }) {
  if (groups.length === 0) return <Empty text="No headlines on your positions overnight" />;
  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <div key={`${g.symbol.exchange}:${g.symbol.symbol}`} className={CARD}>
          <div className="flex items-center gap-2">
            <SymbolChip symbol={g.symbol} />
            <span className={cn('text-xs', MUTED)}>{g.items.length} headline{g.items.length === 1 ? '' : 's'}</span>
          </div>
          <NewsList items={g.items} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- news ideas

const OUTCOME_TEXT = { right: 'text-emerald-400', wrong: 'text-red-400', flat: MUTED, none: SECONDARY } as const;
const OUTCOME_NOTE = { right: 'went the idea’s way', wrong: 'went against the idea', flat: 'flat', none: '' } as const;

function NewsIdeaCard({ row }: { row: NewsIdeaRow }) {
  // Headline URLs are external input: only http(s) becomes a link.
  const href = safeExternalUrl(row.url);
  const badge = ideaBadge(row.idea);
  const outcome = ideaOutcome(row);
  return (
    <article className={cn(CARD, 'space-y-2')} data-testid="night-news-idea">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('flex min-h-10 items-start gap-2 text-sm font-medium hover:underline', PRIMARY)}
        >
          <span className="flex-1">{row.headline}</span>
          <ExternalLink size={12} className="mt-1 shrink-0 opacity-60" />
        </a>
      ) : (
        <p className={cn('text-sm font-medium', PRIMARY)}>{row.headline}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SymbolChip symbol={ideaSymbolRef(row)} />
        <Badge label={badge.label} variant={badge.variant} size="sm" />
        {row.scorecard && <BandChip card={row.scorecard} />}
        <span className={cn('ml-auto text-[11px]', MUTED)}>{agoLabel(row.createdAt)}</span>
      </div>
      <div className={cn('space-y-1 text-sm', SECONDARY)}>
        {row.rationale && <Expandable text={row.rationale} lines={2} />}
        {row.invalidation && (
          <p className="text-xs">
            <span className="font-medium">Wrong if:</span> <span className={MUTED}>{row.invalidation}</span>
          </p>
        )}
        {row.whatToDo && (
          <p className="text-xs">
            <span className="font-medium">What to do:</span> {row.whatToDo}
          </p>
        )}
        {outcome && (
          <p className={cn('text-xs font-medium tabular-nums', OUTCOME_TEXT[outcome.verdict])} data-testid="idea-outcome">
            {outcome.label}
            {OUTCOME_NOTE[outcome.verdict] && <> · {OUTCOME_NOTE[outcome.verdict]}</>}
          </p>
        )}
      </div>
      {row.scorecard && <ScorecardBlock card={row.scorecard} />}
    </article>
  );
}

function NewsIdeasList({ rows }: { rows: NewsIdeaRow[] }) {
  if (rows.length === 0) return <Empty text="No news ideas tonight" />;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {sortIdeasNewestFirst(rows).map((r, i) => (
        <NewsIdeaCard key={r.id ?? `${r.symbol}-${r.createdAt}-${i}`} row={r} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- events

function EventsList({ events }: { events: EventItem[] }) {
  if (events.length === 0) return <Empty text="No events today" />;
  return (
    <ul className={cn(CARD, 'divide-y divide-[var(--color-border-subtle)] py-1')}>
      {events.map((e) => (
        <li key={e.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
          <span className={cn('w-14 shrink-0 tabular-nums text-xs', MUTED)}>{e.allDay ? 'All day' : istTime(e.startsAt)}</span>
          <span className={cn('min-w-0 flex-1', PRIMARY)}>
            {e.title}
            <span className={cn('ml-2 text-[11px]', MUTED)}>{sentenceCase(e.kind)}</span>
          </span>
          {e.impact && <Badge label={sentenceCase(e.impact)} variant={impactVariant(e.impact)} size="sm" />}
          {e.touchesPositions.length > 0 && (
            <div className="flex w-full flex-wrap gap-1.5 pl-16">
              {e.touchesPositions.map((s) => (
                <SymbolChip key={`${s.exchange}:${s.symbol}`} symbol={s} subtle />
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- setups

function SetupsTable({ setups }: { setups: SetupItem[] }) {
  if (setups.length === 0) return <Empty text="No daily setups fired" />;
  const th = cn('px-2 py-2 text-left text-[11px] font-medium uppercase tracking-wide', MUTED);
  const td = 'px-2 py-1.5 align-middle';
  return (
    <div className={cn(CARD, 'overflow-x-auto p-0 sm:p-0')}>
      <table className="w-full min-w-[640px] text-xs">
        <thead className="border-b border-[var(--color-border-subtle)]">
          <tr>
            <th className={th}>Symbol</th>
            <th className={th}>Setup</th>
            <th className={th}>Action</th>
            <th className={th}>Date</th>
            <th className={cn(th, 'text-right')}>Close</th>
            <th className={cn(th, 'text-right')}>5d</th>
            <th className={cn(th, 'text-right')}>10d</th>
            <th className={cn(th, 'text-right')}>20d</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-subtle)]">
          {setups.map((s) => {
            const a = setupActionLabel(s.action);
            const ret = (bp: number | null) => (
              <td className={cn(td, 'text-right tabular-nums', bp == null ? MUTED : bp >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                {bpPct(bp)}
              </td>
            );
            return (
              <tr key={`${s.instrument.symbol}:${s.setup}:${s.signalDate}`}>
                <td className={td}>
                  <SymbolChip symbol={s.instrument} />
                </td>
                <td className={cn(td, PRIMARY)} title={s.setup}>
                  {setupLabel(s.setup)}
                </td>
                <td className={td}>
                  <Badge label={a.label} variant={a.variant} size="sm" />
                </td>
                <td className={cn(td, 'whitespace-nowrap', MUTED)}>{istDate(s.signalDate)}</td>
                <td className={cn(td, 'text-right tabular-nums', PRIMARY)}>{rupees(s.close)}</td>
                {ret(s.ret5dBp)}
                {ret(s.ret10dBp)}
                {ret(s.ret20dBp)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- mood

function MoodPanel({ mood }: { mood: MoodView }) {
  const horizons = Object.entries(mood.horizons ?? {});
  if (mood.status === 'absent' || horizons.length === 0) {
    return <Empty text="Market mood is absent: no NIFTY regime read was made overnight." />;
  }
  return (
    <div className={cn(CARD, 'space-y-2')}>
      <p className={cn('flex flex-wrap items-center gap-2 text-xs', MUTED)}>
        NIFTY · as of {istDateTime(mood.asOf)}
        {mood.status === 'stale' && <Badge label="Stale" variant="warning" size="sm" />}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {horizons.map(([h, v]) => (
          <div key={h} className="rounded border border-[var(--color-border-subtle)] p-2 text-xs">
            <p className={cn('font-semibold', PRIMARY)}>
              {h} · {sentenceCase(v.regime)}
            </p>
            <p className={SECONDARY}>P(big move) {(v.p * 100).toFixed(0)}%</p>
            <p className={MUTED}>
              Range {bpPct(v.q25Bp)} to {bpPct(v.q75Bp)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- jobs

function JobsStrip({ jobs }: { jobs: JobItem[] }) {
  if (jobs.length === 0) return <Empty text="No night jobs reported" />;
  return (
    <div className="flex flex-wrap gap-2">
      {jobs.map((j) => (
        <span
          key={j.name}
          title={j.detail}
          className="inline-flex min-h-10 items-center gap-2 rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] px-2.5 text-xs"
        >
          <span className={PRIMARY}>{j.name}</span>
          <Badge label={j.status} variant={jobVariant(j.status)} size="sm" />
          <span className={MUTED}>{j.at ? istTime(j.at) : '—'}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- page body

export function NightReportView({
  report,
  onRefresh,
  refreshing,
  onRerun,
  rerunning,
  rerunNote,
}: {
  report: NightReport;
  onRefresh?: () => void;
  refreshing?: boolean;
  onRerun?: () => void;
  rerunning?: boolean;
  rerunNote?: string | null;
}) {
  const count = <T,>(v: Section<T[]>) => (isSectionError(v) ? undefined : (v as T[]).length);
  // An API from before the scorecard build sends no `newsIdeas`; show it as empty, not failed.
  const newsIdeas: Section<NewsIdeaRow[]> = report.newsIdeas ?? [];
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4">
      <Header report={report} onRefresh={onRefresh} refreshing={refreshing} onRerun={onRerun} rerunning={rerunning} rerunNote={rerunNote} />

      <SectionShell title="Positions" count={count(report.positions)}>
        <Guard value={report.positions}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty text="No open positions overnight" />
            ) : (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {rows.map((p) => (
                  <PositionCard key={p.trackerId} p={p} />
                ))}
              </div>
            )
          }
        </Guard>
      </SectionShell>

      <SectionShell title="News on your positions">
        <Guard value={report.news}>{(n) => <NewsGroups groups={n.onPositions} />}</Guard>
      </SectionShell>

      <SectionShell title="Market news">
        <Guard value={report.news}>
          {(n) =>
            n.market.length === 0 ? (
              <Empty text="No market headlines overnight" />
            ) : (
              <div className={CARD}>
                <NewsList items={n.market} />
              </div>
            )
          }
        </Guard>
      </SectionShell>

      <SectionShell title="News ideas" count={count(newsIdeas)}>
        <Guard value={newsIdeas}>{(rows) => <NewsIdeasList rows={rows} />}</Guard>
      </SectionShell>

      <SectionShell title="Today's events" count={count(report.events)}>
        <Guard value={report.events}>{(e) => <EventsList events={e} />}</Guard>
      </SectionShell>

      <SectionShell title="Daily setups" count={count(report.dailySetups)}>
        <Guard value={report.dailySetups}>{(s) => <SetupsTable setups={s} />}</Guard>
      </SectionShell>

      <SectionShell title="Market mood">
        <Guard value={report.mood}>{(m) => <MoodPanel mood={m} />}</Guard>
      </SectionShell>

      <SectionShell title="Night jobs">
        <Guard value={report.jobs}>{(j) => <JobsStrip jobs={j} />}</Guard>
      </SectionShell>

      <p className={cn('text-[11px]', MUTED)}>Generated {istDateTime(report.generatedAt)} IST</p>
    </div>
  );
}

/** Placeholder blocks in the page's shape while the report loads. */
export function NightReportSkeleton() {
  const block = 'animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]';
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4" aria-busy="true" aria-label="Loading night report">
      <div className={cn(block, 'h-8 w-48')} />
      <div className={cn(block, 'h-10')} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className={cn(block, 'h-40')} />
        <div className={cn(block, 'h-40')} />
      </div>
      <div className={cn(block, 'h-32')} />
      <div className={cn(block, 'h-24')} />
    </div>
  );
}
