import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Badge, EmptyState } from '@/components/common';
import { cn } from '@/utils/cn';
import {
  SOURCE_LABEL,
  STATE_LABEL,
  STATE_VARIANT,
  filterBoard,
  getSignalBoard,
  istToday,
  levelsLine,
  resultLine,
  type BoardFilter,
  type BoardItem,
  type SignalBoard,
} from './signalBoard';

const CARD = 'rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-3 sm:p-4';
const MUTED = 'text-[var(--color-text-muted)]';
const PRIMARY = 'text-[var(--color-text-primary)]';
const SECONDARY = 'text-[var(--color-text-secondary)]';
const REFRESH_MS = 30_000;

const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
};

const FILTERS: { key: BoardFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'actionable', label: 'Waiting / open' },
  { key: 'NIGHT_SETUP', label: 'Night setups' },
  { key: 'NEWS_IDEA', label: 'News ideas' },
  { key: 'TELEGRAM', label: 'Telegram' },
  { key: 'WATCH', label: 'Watches' },
];

function BoardRow({ x }: { x: BoardItem }) {
  const levels = levelsLine(x);
  const result = resultLine(x);
  return (
    <li className={CARD} data-testid="board-row">
      <div className="flex flex-wrap items-center gap-2">
        <Badge label={STATE_LABEL[x.state]} variant={STATE_VARIANT[x.state]} size="sm" />
        <span className={cn('text-xs font-medium', SECONDARY)}>{SOURCE_LABEL[x.source]}</span>
        <span className={cn('text-sm font-medium', PRIMARY)}>
          {x.side ? `${x.side} ` : ''}
          {x.instrument ?? x.symbol}
        </span>
        {x.channel && <span className={cn('text-xs', MUTED)}>{x.channel}</span>}
        {x.aiCorrect !== null && (
          <Badge label={x.aiCorrect ? 'AI right' : 'AI wrong'} variant={x.aiCorrect ? 'success' : 'danger'} size="sm" />
        )}
        <span className={cn('ml-auto text-xs', MUTED)}>{time(x.at)}</span>
      </div>
      {levels && <p className={cn('mt-1.5 text-sm', SECONDARY)}>{levels}</p>}
      {x.entryNote && x.source !== 'TELEGRAM' && <p className={cn('mt-1 text-xs', MUTED)}>{x.entryNote}</p>}
      {x.why.length > 0 && <p className={cn('mt-1 text-xs', MUTED)}>{x.why.join(' · ')}</p>}
      <p className={cn('mt-1 text-xs', MUTED)}>
        {x.status}
        {result && <span className={cn('ml-2 font-medium', x.state === 'WON' ? 'text-emerald-400' : x.state === 'LOST' ? 'text-red-400' : SECONDARY)}>{result}</span>}
      </p>
    </li>
  );
}

/** The Signals page's default tab: the session's night analysis + the day's calls and watches in one list. */
export default function SignalBoardTab() {
  const [date, setDate] = useState(istToday());
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [board, setBoard] = useState<SignalBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBoard(await getSignalBoard(date));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not load the signals');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    setLoading(true);
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const items = board ? filterBoard(board.items, filter) : [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-card)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
          aria-label="Session date"
        />
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              filter === f.key ? 'bg-amber-500/20 text-amber-400' : cn(MUTED, 'hover:text-[var(--color-text-primary)]'),
            )}
          >
            {f.label}
            {board && f.key !== 'all' && f.key !== 'actionable' ? ` (${board.counts[f.key]})` : ''}
          </button>
        ))}
        <button onClick={() => void load()} className={cn('ml-auto p-1', MUTED)} aria-label="Refresh">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {!loading && board && items.length === 0 ? (
        <EmptyState title="No signals yet" description={`Nothing ${filter === 'all' ? '' : 'in this filter '}for ${board.session} so far. Night setups arrive at 23:50 and 08:50 IST; Telegram calls as they are posted.`} />
      ) : (
        <ul className="space-y-2">
          {items.map((x) => (
            <BoardRow key={x.id} x={x} />
          ))}
        </ul>
      )}
    </div>
  );
}
