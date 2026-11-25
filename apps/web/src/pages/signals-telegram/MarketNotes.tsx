import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/common';
import { cn } from '@/utils/cn';
import { SetupCard } from './SetupCard';
import {
  fetchAiSetups,
  fetchMarketNotes,
  fetchReaderHealth,
  latencyLabel,
  modeBadge,
  readerNotReading,
  verdictChip,
  type AiSetupRow,
  type MarketNote,
  type NoteClaim,
  type ReaderHealth,
} from './signalsTelegram';

const CARD = 'rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-3 sm:p-4';
const MUTED = 'text-[var(--color-text-muted)]';
const PRIMARY = 'text-[var(--color-text-primary)]';
const SECONDARY = 'text-[var(--color-text-secondary)]';
const POLL_MS = 30_000;

const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
};

function ClaimRow({ c }: { c: NoteClaim }) {
  const chip = verdictChip(c.verdict);
  return (
    <li className="text-xs" data-testid="note-claim">
      <div className="flex flex-wrap items-center gap-1.5">
        <span data-testid={`verdict-${c.verdict}`} className="contents">
          <Badge label={chip.label} variant={chip.variant} size="sm" className={chip.outline ? 'bg-transparent' : undefined} />
        </span>
        <span className={cn('break-words', SECONDARY)}>{c.text}</span>
        <span className={MUTED}>
          {c.subject} · {c.bias}
        </span>
      </div>
      {c.evidence.length > 0 && (
        <details className="mt-1">
          <summary className={cn('cursor-pointer', MUTED)}>Evidence ({c.evidence.length})</summary>
          <ul className="mt-1 space-y-0.5 pl-2">
            {c.evidence.map((e, i) => (
              <li key={i} className={MUTED}>
                <span className={SECONDARY}>{e.fact}</span> <span className={cn('font-medium tabular-nums', PRIMARY)}>{e.value}</span> · {e.source}
              </li>
            ))}
          </ul>
        </details>
      )}
      {c.evidenceMissing && <p className={cn('mt-0.5', MUTED)}>no evidence given — downgraded to UNCLEAR</p>}
    </li>
  );
}

function NoteRow({ n, setups }: { n: MarketNote; setups: AiSetupRow[] }) {
  return (
    <li className={CARD} data-testid="market-note">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('text-xs font-medium tabular-nums', SECONDARY)}>{time(n.postedAt)}</span>
        <span className={cn('text-sm font-medium', PRIMARY)}>{n.channelTitle}</span>
        {n.kind && <span className={cn('text-xs', MUTED)}>{n.kind}</span>}
        {n.status !== 'READ' && <Badge label={n.status} variant={n.status === 'FAILED' ? 'danger' : 'neutral'} size="sm" />}
        <span className={cn('ml-auto text-xs', MUTED)}>{latencyLabel(n.latencyMs)}</span>
      </div>
      {n.summary && <p className={cn('mt-1 break-words text-sm', SECONDARY)}>{n.summary}</p>}
      {n.error && <p className="mt-1 break-words text-xs text-red-400">{n.error}</p>}
      {n.claims.length > 0 && <ul className="mt-2 space-y-1.5">{n.claims.map((c, i) => <ClaimRow key={i} c={c} />)}</ul>}
      {setups.map((s) => (
        <SetupCard key={s.id} s={s} />
      ))}
    </li>
  );
}

/**
 * Pure: the reader's header (mode, p95, dead-reader badge) and one row per reading, each with the AI setup cards it
 * produced; setups whose reading is not in the list are shown after it. Nothing when the reader is off.
 */
export function MarketNotesView({ health, notes, nowMs, setups = [] }: { health: ReaderHealth; notes: MarketNote[]; nowMs: number; setups?: AiSetupRow[] }) {
  if (health.mode === 'off') return null;
  const badge = modeBadge(health.mode);
  const byReading = new Map<string, AiSetupRow[]>();
  for (const s of setups) byReading.set(s.readingId, [...(byReading.get(s.readingId) ?? []), s]);
  const shown = new Set(notes.map((n) => n.messageId));
  const other = setups.filter((s) => !shown.has(s.readingId));
  return (
    <section data-testid="market-notes">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className={cn('text-sm font-semibold', PRIMARY)}>Market notes</h2>
        <Badge label={badge.label} variant={badge.variant} size="sm" />
        <span className={cn('text-xs', MUTED)}>
          p95 {latencyLabel(health.lastHour.p95Ms)} · {health.lastHour.posts} post{health.lastHour.posts === 1 ? '' : 's'} last hour
        </span>
        {readerNotReading(health, nowMs) && (
          <span data-testid="reader-not-reading" className="contents">
            <Badge label="Reader not reading" variant="danger" size="sm" />
          </span>
        )}
      </div>
      {notes.length === 0 ? (
        <p className={cn('text-sm', MUTED)}>No posts read yet today.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <NoteRow key={n.messageId} n={n} setups={byReading.get(n.messageId) ?? []} />
          ))}
        </ul>
      )}
      {other.length > 0 && (
        <div className={cn('mt-2', CARD)} data-testid="other-setups">
          <p className={cn('text-xs font-medium', SECONDARY)}>AI setups from other posts</p>
          {other.map((s) => (
            <SetupCard key={s.id} s={s} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Owner-only "Market notes": the AI reader's verdicts on each Telegram post for one IST session, with the AI setup
 * cards under the reading they came from (hidden when AI_SETUPS=off). Polls every 30 s.
 */
export function MarketNotes({ date }: { date: string }) {
  const health = useQuery({ queryKey: ['message-reader', 'health'], queryFn: fetchReaderHealth, refetchInterval: POLL_MS, staleTime: 15_000 });
  const on = !!health.data && health.data.mode !== 'off';
  const notes = useQuery({
    queryKey: ['message-reader', 'notes', date],
    queryFn: () => fetchMarketNotes(date),
    refetchInterval: POLL_MS,
    staleTime: 15_000,
    enabled: on,
  });
  const setups = useQuery({
    queryKey: ['ai-setups', date],
    queryFn: () => fetchAiSetups(date),
    refetchInterval: POLL_MS,
    staleTime: 15_000,
    enabled: on,
  });
  const cards = setups.data && setups.data.mode !== 'off' ? setups.data.setups : [];
  if (health.isError) return <p className="text-sm text-[var(--color-accent-red)]">Could not load the message reader's health.</p>;
  if (!health.data || !on) return null;
  return (
    <>
      <MarketNotesView health={health.data} notes={notes.data?.notes ?? []} nowMs={Date.now()} setups={cards} />
      {notes.isError && <p className="mt-1 text-sm text-[var(--color-accent-red)]">Could not load market notes.</p>}
      {setups.isError && <p className="mt-1 text-sm text-[var(--color-accent-red)]">Could not load AI setups.</p>}
    </>
  );
}
