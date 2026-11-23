import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, Eye, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { cn } from '@/utils/cn';
import {
  getNewsBrief,
  refreshNewsBrief,
  type AiBrief,
  type AiBriefPoint,
  type AiBriefState,
  type AiTone,
  type NewsAiRefreshResponse,
} from '@/services/newsAi';
import { ageLabel, clockIst, DIR_CHIP, DIR_LABEL, dirKey, isStale, newsCardDomId } from './newsAiFormat';

export interface ArticleRef {
  title: string;
  url?: string;
}

export interface NewsBriefViewProps {
  brief: AiBrief | null | undefined;
  isLoading?: boolean;
  error?: string | null;
  /** The refresh request itself is in flight. */
  isRefreshing?: boolean;
  /** The server reports a brief build running (after a refresh, or the scheduled run). */
  building?: boolean;
  /** NEWS_AI switch on the server; false shows an "analysis is off" note. */
  enabled?: boolean;
  /** The server's news-ai tables exist; false shows a "not set up yet" note. */
  ready?: boolean;
  /** This user may start a new brief (owner/admin). The Refresh button only shows when true. */
  canRefresh?: boolean;
  refreshMessage?: string | null;
  onRefresh?: () => void;
  /** Open/scroll to a story. Receives the article id and any known url. */
  onOpenStory?: (articleId: string, url?: string) => void;
  /** Lookup for titles/urls of cited articles (feed + the brief's own refs). */
  articleLookup?: ReadonlyMap<string, ArticleRef>;
  now?: Date;
}

const BRIEF_QUERY_KEY = ['news-ai', 'brief'] as const;
/** Poll fast while the server builds a brief, slowly otherwise. */
const POLL_BUILDING_MS = 5_000;
const POLL_IDLE_MS = 5 * 60_000;

type OpenStory = (id: string, url?: string) => void;

function DirChip({ direction }: { direction: AiTone['direction'] }) {
  const dk = dirKey(direction);
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none', DIR_CHIP[dk])}>
      {DIR_LABEL[dk]}
    </span>
  );
}

/** Collapsible section built on <details> — works without JS state and on mobile. */
function Section({ title, count, defaultOpen = true, children }: { title: string; count?: number; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="group/section rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/40">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs font-semibold text-[var(--color-text-primary)] [&::-webkit-details-marker]:hidden">
        <span>
          {title}
          {count !== undefined && <span className="ml-1.5 font-normal text-[var(--color-text-muted)]">{count}</span>}
        </span>
        <ChevronDown size={14} className="text-[var(--color-text-muted)] transition-transform group-open/section:rotate-180" />
      </summary>
      <div className="px-3 pb-3">{children}</div>
    </details>
  );
}

/** Numbered citation buttons: [1] [2] … → scroll to / open the cited article. */
function StoryRefs({
  ids,
  onOpenStory,
  articleLookup,
}: {
  ids: string[];
  onOpenStory?: OpenStory;
  articleLookup?: ReadonlyMap<string, ArticleRef>;
}) {
  if (ids.length === 0) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-0.5 align-middle">
      {ids.slice(0, 6).map((id, i) => {
        const ref = articleLookup?.get(id);
        if (articleLookup && !ref) {
          // Cited when the brief was built, since pruned from the news store.
          return (
            <span
              key={id}
              title="Source article no longer available"
              aria-label={`Source ${i + 1}: no longer available`}
              className="min-w-[1.25rem] rounded bg-[var(--color-bg-tertiary)] px-1 text-center text-[10px] font-medium leading-4 text-[var(--color-text-muted)] line-through"
            >
              {i + 1}
            </span>
          );
        }
        return (
          <button
            key={id}
            type="button"
            onClick={() => onOpenStory?.(id, ref?.url)}
            title={ref?.title || 'Open source article'}
            aria-label={`Source ${i + 1}${ref?.title ? `: ${ref.title}` : ''}`}
            className="min-w-[1.25rem] rounded bg-[var(--color-bg-tertiary)] px-1 text-[10px] font-medium leading-4 text-[var(--color-accent-blue)] hover:bg-[var(--color-accent-blue)]/15"
          >
            {i + 1}
          </button>
        );
      })}
    </span>
  );
}

function GroupList({
  rows,
  onOpenStory,
  articleLookup,
}: {
  rows: (AiBriefPoint & { label?: string })[];
  onOpenStory?: OpenStory;
  articleLookup?: ReadonlyMap<string, ArticleRef>;
}) {
  return (
    <ul className="space-y-2">
      {rows.map((g, i) => (
        <li key={`${g.label ?? g.name}-${i}`} className="text-xs leading-snug">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-[var(--color-text-primary)]">{g.label ?? g.name}</span>
            <DirChip direction={g.direction} />
          </div>
          <p className="mt-0.5 text-[var(--color-text-secondary)]">
            {g.summary}
            <StoryRefs ids={g.articleIds} onOpenStory={onOpenStory} articleLookup={articleLookup} />
          </p>
        </li>
      ))}
    </ul>
  );
}

function ToneCard({
  label,
  tone,
  onOpenStory,
  articleLookup,
}: {
  label: string;
  tone: AiTone | null;
  onOpenStory?: OpenStory;
  articleLookup?: ReadonlyMap<string, ArticleRef>;
}) {
  if (!tone || (!tone.summary && tone.articleIds.length === 0)) return null;
  return (
    <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/40 p-3">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</span>
        <DirChip direction={tone.direction} />
      </div>
      <p className="text-xs leading-snug text-[var(--color-text-primary)]">
        {tone.summary}
        <StoryRefs ids={tone.articleIds} onOpenStory={onOpenStory} articleLookup={articleLookup} />
      </p>
    </div>
  );
}

/** Presentational AI market brief. No data fetching — see NewsBrief below. */
export function NewsBriefView({
  brief,
  isLoading,
  error,
  isRefreshing,
  building,
  enabled,
  ready,
  canRefresh,
  refreshMessage,
  onRefresh,
  onOpenStory,
  articleLookup,
  now,
}: NewsBriefViewProps) {
  const [open, setOpen] = useState(true);
  const b = brief?.brief;
  const stale = brief ? isStale(brief.createdAt, now) : false;
  const busy = !!isRefreshing || !!building;

  let body: ReactNode;
  if (isLoading && !brief) {
    body = (
      <div className="space-y-2" aria-busy>
        <div className="h-12 animate-pulse rounded-md bg-[var(--color-bg-tertiary)]" />
        <div className="h-24 animate-pulse rounded-md bg-[var(--color-bg-tertiary)]" />
      </div>
    );
  } else if (!brief || !b) {
    body = (
      <p className="text-xs text-[var(--color-text-muted)]">
        {error
          ? 'The AI brief is unavailable right now. The news feed below is unaffected.'
          : building
            ? 'Claude is reading the latest news — the brief will appear here in a minute or two.'
            : enabled === false
              ? 'AI news analysis is switched off on the server (NEWS_AI=off).'
              : ready === false
                ? 'AI news analysis is not set up on the server yet.'
                : canRefresh
                  ? 'No AI brief yet. It is built through the trading day once articles have AI reads; press Refresh to build one now.'
                  : 'No AI brief yet. It is built through the trading day (weekdays 08:00–23:30 IST) once articles have AI reads.'}
      </p>
    );
  } else {
    const hasTone = (b.indiaTone && b.indiaTone.summary) || (b.globalTone && b.globalTone.summary);
    body = (
      <div className="space-y-2.5">
        {b.headline && (
          <p className="text-sm font-medium leading-snug text-[var(--color-text-primary)]" data-testid="ai-brief-headline">
            {b.headline}
          </p>
        )}

        {hasTone && (
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            <ToneCard label="India" tone={b.indiaTone} onOpenStory={onOpenStory} articleLookup={articleLookup} />
            <ToneCard label="Global" tone={b.globalTone} onOpenStory={onOpenStory} articleLookup={articleLookup} />
          </div>
        )}

        {b.topStories.length > 0 && (
          <Section title="Top stories" count={b.topStories.length}>
            <ol className="space-y-2">
              {b.topStories.map((s, i) => {
                const ref = articleLookup?.get(s.articleId);
                return (
                  <li key={`${s.articleId}-${i}`} className="flex gap-2 text-xs leading-snug">
                    <span className="mt-px shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{i + 1}.</span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenStory?.(s.articleId, ref?.url)}
                          className="text-left font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-accent-blue)] hover:underline"
                        >
                          {s.headline || ref?.title || 'Untitled story'}
                        </button>
                        <DirChip direction={s.direction} />
                      </div>
                      {s.whyItMatters && <p className="mt-0.5 text-[var(--color-text-secondary)]">{s.whyItMatters}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          </Section>
        )}

        <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
          {b.indices.length > 0 && (
            <Section title="Indices" count={b.indices.length}>
              <GroupList rows={b.indices} onOpenStory={onOpenStory} articleLookup={articleLookup} />
            </Section>
          )}
          {b.holdings.length > 0 && (
            <Section title="Your holdings" count={b.holdings.length}>
              <GroupList
                rows={b.holdings.map((h) => ({ ...h, name: h.symbol, label: h.symbol }))}
                onOpenStory={onOpenStory}
                articleLookup={articleLookup}
              />
            </Section>
          )}
          {b.sectors.length > 0 && (
            <Section title="Sectors" count={b.sectors.length} defaultOpen={false}>
              <GroupList rows={b.sectors} onOpenStory={onOpenStory} articleLookup={articleLookup} />
            </Section>
          )}
          {b.commodities.length > 0 && (
            <Section title="Commodities" count={b.commodities.length} defaultOpen={false}>
              <GroupList rows={b.commodities} onOpenStory={onOpenStory} articleLookup={articleLookup} />
            </Section>
          )}
        </div>

        {b.watchNext.length > 0 && (
          <Section title="Watch next" count={b.watchNext.length}>
            <ul className="space-y-1">
              {b.watchNext.map((w, i) => (
                <li key={i} className="flex gap-1.5 text-xs leading-snug text-[var(--color-text-secondary)]">
                  <Eye size={12} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
                  <span>
                    {w.item}
                    <StoryRefs ids={w.articleIds} onOpenStory={onOpenStory} articleLookup={articleLookup} />
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  return (
    <section
      className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-3 sm:p-4"
      data-testid="ai-brief"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <Sparkles size={16} className="shrink-0 text-[var(--color-accent-blue)]" />
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">AI Market Brief</h2>
          <ChevronDown size={14} className={cn('shrink-0 text-[var(--color-text-muted)] transition-transform', open && 'rotate-180')} />
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {building && brief && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--color-accent-blue)]">
              <Loader2 size={10} className="animate-spin" />
              Building a new brief…
            </span>
          )}
          {brief && (
            <span
              className={cn('flex items-center gap-1 text-[10px]', stale ? 'text-amber-400' : 'text-[var(--color-text-muted)]')}
              title={`Generated ${clockIst(brief.createdAt)} IST${brief.windowFrom ? ` · news ${clockIst(brief.windowFrom)} – ${clockIst(brief.windowTo)}` : ''}${brief.model ? ` · ${brief.model}` : ''}`}
            >
              {stale && <AlertTriangle size={10} />}
              {ageLabel(brief.createdAt, now)}
              <span className="hidden sm:inline">· {clockIst(brief.createdAt)} IST</span>
            </span>
          )}
          {onRefresh && canRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={busy}
              className={cn(
                'flex items-center gap-1.5 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-secondary)] transition-colors',
                'hover:border-[var(--color-accent-blue)] hover:text-[var(--color-accent-blue)]',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
              {busy ? 'Analysing…' : 'Refresh'}
            </button>
          )}
        </div>
      </div>

      {refreshMessage && <p className="mt-2 text-[11px] text-amber-400">{refreshMessage}</p>}

      {open && <div className="mt-3">{body}</div>}
    </section>
  );
}

/** Scroll to the story's card in the feed and flash it; else open its link. */
export function openStory(articleId: string, url?: string): boolean {
  const el = typeof document !== 'undefined' ? document.getElementById(newsCardDomId(articleId)) : null;
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-[var(--color-accent-blue)]');
    window.setTimeout(() => el.classList.remove('ring-2', 'ring-[var(--color-accent-blue)]'), 2000);
    return true;
  }
  if (url) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
  return false;
}

export function errorText(err: unknown): string {
  const e = err as { message?: string; status?: number } | null;
  if (e?.status === 403 || e?.status === 429) return e.message ?? 'Refresh not allowed right now.';
  return e?.message ? `Refresh failed: ${e.message}` : 'Refresh failed.';
}

export function refreshText(r: NewsAiRefreshResponse | undefined): string | null {
  if (!r) return null;
  if (r.status === 'off') return 'AI news analysis is switched off on the server (NEWS_AI=off).';
  if (r.status === 'unavailable') return 'AI news analysis is not set up on the server yet.';
  return null;
}

/** Merge the feed's articles with the brief's own cited refs (feed wins: it has the card to scroll to). */
export function mergeLookup(
  feed: ReadonlyMap<string, ArticleRef> | undefined,
  cited: AiBriefState['articles'] | undefined,
): Map<string, ArticleRef> {
  const m = new Map<string, ArticleRef>();
  for (const [id, a] of cited ?? []) m.set(id, { title: a.title, ...(a.url ? { url: a.url } : {}) });
  for (const [id, a] of feed ?? []) m.set(id, { title: a.title || m.get(id)?.title || '', url: a.url || m.get(id)?.url });
  return m;
}

/** Data-connected AI market brief for the top of the news page. */
export default function NewsBrief({ articleLookup }: { articleLookup?: ReadonlyMap<string, ArticleRef> }) {
  const qc = useQueryClient();
  const [notFound, setNotFound] = useState<string | null>(null);
  const q = useQuery({
    queryKey: BRIEF_QUERY_KEY,
    queryFn: getNewsBrief,
    refetchInterval: (query) => (query.state.data?.building ? POLL_BUILDING_MS : POLL_IDLE_MS),
    staleTime: 60_000,
    retry: false,
  });

  const refresh = useMutation({
    mutationFn: refreshNewsBrief,
    onSuccess: (res) => {
      if (res.status === 'started' || res.status === 'running') {
        // Show "building" at once; the GET then reports building=true and the query polls every 5 s until done.
        const prev = qc.getQueryData<AiBriefState>(BRIEF_QUERY_KEY);
        if (prev) qc.setQueryData<AiBriefState>(BRIEF_QUERY_KEY, { ...prev, building: true });
      }
      void qc.invalidateQueries({ queryKey: BRIEF_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ['news-ai', 'sentiment-overview'] });
    },
    onError: () => {
      // The run may still finish server-side; pick it up shortly.
      window.setTimeout(() => void qc.invalidateQueries({ queryKey: BRIEF_QUERY_KEY }), 30_000);
    },
  });

  const lookup = useMemo(() => mergeLookup(articleLookup, q.data?.articles), [articleLookup, q.data?.articles]);

  const onOpenStory = (id: string, url?: string) => {
    const ok = openStory(id, url ?? lookup.get(id)?.url);
    setNotFound(ok ? null : 'That story is not in the loaded feed — scroll the feed or clear filters to find it.');
    if (!ok) window.setTimeout(() => setNotFound(null), 5000);
  };

  return (
    <NewsBriefView
      brief={q.data?.brief}
      isLoading={q.isLoading}
      error={q.isError ? (q.error as Error)?.message ?? 'error' : null}
      isRefreshing={refresh.isPending}
      building={q.data?.building}
      enabled={q.data?.enabled}
      ready={q.data?.ready}
      canRefresh={q.data?.canRefresh}
      refreshMessage={refresh.isError ? errorText(refresh.error) : (refreshText(refresh.data) ?? notFound)}
      onRefresh={() => refresh.mutate()}
      onOpenStory={onOpenStory}
      articleLookup={lookup}
    />
  );
}
