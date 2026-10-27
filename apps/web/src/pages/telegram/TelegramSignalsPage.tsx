import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Send } from 'lucide-react';
import {
  DataTable,
  Badge,
  EmptyState,
  LoadingSkeleton,
  type Column,
} from '@/components/common';
import { useTelegramScorecard } from '@/hooks/useTelegramScorecard';
import { cn } from '@/utils/cn';
import type { ChannelScorecard } from '@/types';
import { FILTERS, getAiScorecard, getTelegramFeed, scorecardLine } from './telegramFeed';
import { TelegramFeedView } from './TelegramFeedView';

type BoardRow = ChannelScorecard & Record<string, unknown>;

/**
 * Telegram feed: every post the reader stored, newest first, with what the signal-intake
 * classifier made of it (call / update / information / result / noise) and, for a call, the
 * trade decision. The old leaderboard (pre-intake pipeline, nothing new since 2026-07) stays as
 * a second tab.
 */
export default function TelegramSignalsPage() {
  const [tab, setTab] = useState<'feed' | 'leaderboard'>('feed');
  const [filter, setFilter] = useState('all');
  const [channelId, setChannelId] = useState('');
  const statuses = FILTERS.find((f) => f.key === filter)?.statuses;
  const feed = useQuery({
    queryKey: ['telegram', 'feed', filter, channelId],
    queryFn: () => getTelegramFeed({ status: statuses, channelId: channelId || undefined }),
    refetchInterval: 15_000,
    enabled: tab === 'feed',
  });
  const { scorecards, channels, isLoading: boardLoading } = useTelegramScorecard();
  // Learning mode: the AI judge's calls held against the paper results.
  const scorecard = useQuery({ queryKey: ['telegram', 'ai-scorecard'], queryFn: () => getAiScorecard(14), refetchInterval: 60_000, enabled: tab === 'feed' });

  const boardCols: Column<BoardRow>[] = [
    { key: 'title', header: 'Channel' },
    {
      key: 'winRate',
      header: 'Win rate',
      render: (_v, r) =>
        r.winRate == null ? (
          <span className="text-gray-500">—</span>
        ) : (
          <Badge label={`${(r.winRate * 100).toFixed(0)}%`} variant={r.winRate >= 0.5 ? 'success' : 'danger'} />
        ),
    },
    { key: 'wins', header: 'W' },
    { key: 'losses', header: 'L' },
    { key: 'expired', header: 'Exp' },
    { key: 'untrackable', header: 'Untr.' },
    { key: 'avgResultPct', header: 'Avg %', render: (_v, r) => (r.avgResultPct == null ? '—' : `${r.avgResultPct.toFixed(2)}%`) },
  ];

  const chip = (active: boolean) => cn('px-3 py-1 rounded text-sm', active ? 'bg-blue-600 text-white' : 'bg-gray-800/60');

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <header className="flex items-center gap-2">
        <Send className="w-5 h-5 text-blue-400" />
        <h1 className="text-lg font-semibold">Telegram Feed</h1>
        {tab === 'feed' && (
          <button
            onClick={() => feed.refetch()}
            className="ml-auto flex items-center gap-1 text-sm px-3 py-1 rounded bg-gray-800/60 border border-gray-700/60"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', feed.isFetching && 'animate-spin')} /> Refresh
          </button>
        )}
      </header>

      <div className="flex gap-2">
        <button onClick={() => setTab('feed')} className={chip(tab === 'feed')}>Live feed</button>
        <button onClick={() => setTab('leaderboard')} className={chip(tab === 'leaderboard')}>Old leaderboard (to July)</button>
      </div>

      {tab === 'feed' ? (
        <>
          {scorecard.data && (
            <p className="rounded border border-gray-700/60 bg-gray-800/40 px-3 py-2 text-sm">{scorecardLine(scorecard.data)}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => (
              <button key={f.key} onClick={() => setFilter(f.key)} className={chip(filter === f.key)}>
                {f.label}
              </button>
            ))}
            <select
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              className="ml-auto max-w-full rounded bg-gray-800/60 border border-gray-700/60 px-2 py-1 text-sm"
            >
              <option value="">All channels</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Every post the reader stored, newest first. Refreshes every 15 s.
          </p>
          {feed.isError ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
              Could not load the feed. It will retry automatically.
            </p>
          ) : feed.isLoading ? (
            <LoadingSkeleton variant="card" />
          ) : (
            <TelegramFeedView items={feed.data ?? []} />
          )}
        </>
      ) : boardLoading ? (
        <LoadingSkeleton variant="card" />
      ) : scorecards.length ? (
        <DataTable columns={boardCols} data={scorecards as BoardRow[]} />
      ) : (
        <EmptyState title="No channels tracked yet" />
      )}
    </div>
  );
}
