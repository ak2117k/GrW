import { useState } from 'react';
import { Send } from 'lucide-react';
import {
  DataTable,
  Badge,
  StatCard,
  EmptyState,
  LoadingSkeleton,
  type Column,
} from '@/components/common';
import { useTelegramScorecard } from '@/hooks/useTelegramScorecard';
import type { ChannelScorecard, TelegramSignalRow } from '@/types';

const statusVariant: Record<
  string,
  'success' | 'danger' | 'warning' | 'neutral' | 'info'
> = {
  TARGET_HIT: 'success',
  SL_HIT: 'danger',
  EXPIRED: 'warning',
  UNTRACKABLE: 'neutral',
  ACTIVE: 'info',
  PENDING: 'info',
};

type BoardRow = ChannelScorecard & Record<string, unknown>;
type SignalRow = TelegramSignalRow & Record<string, unknown>;

export default function TelegramSignalsPage() {
  const { scorecards, signals, isLoading, refresh } = useTelegramScorecard();
  const [tab, setTab] = useState<'leaderboard' | 'signals'>('leaderboard');

  const boardCols: Column<BoardRow>[] = [
    { key: 'title', header: 'Channel' },
    {
      key: 'winRate',
      header: 'Win rate',
      render: (_v, r) =>
        r.winRate == null ? (
          <span className="text-gray-500">—</span>
        ) : (
          <Badge
            label={`${(r.winRate * 100).toFixed(0)}%`}
            variant={r.winRate >= 0.5 ? 'success' : 'danger'}
          />
        ),
    },
    { key: 'wins', header: 'W' },
    { key: 'losses', header: 'L' },
    { key: 'expired', header: 'Exp' },
    { key: 'untrackable', header: 'Untr.' },
    {
      key: 'avgResultPct',
      header: 'Avg %',
      render: (_v, r) =>
        r.avgResultPct == null ? '—' : `${r.avgResultPct.toFixed(2)}%`,
    },
  ];

  const signalCols: Column<SignalRow>[] = [
    { key: 'symbol', header: 'Symbol' },
    { key: 'signalType', header: 'Type' },
    { key: 'side', header: 'Side' },
    {
      key: 'status',
      header: 'Status',
      render: (_v, r) => (
        <Badge label={r.status} variant={statusVariant[r.status] ?? 'neutral'} />
      ),
    },
    {
      key: 'resultPct',
      header: 'Result',
      render: (_v, r) =>
        r.resultPct == null ? '—' : `${r.resultPct.toFixed(2)}%`,
    },
    {
      key: 'createdAt',
      header: 'When',
      render: (_v, r) => new Date(r.createdAt).toLocaleString(),
    },
  ];

  return (
    <div className="p-6 space-y-4">
      <header className="flex items-center gap-2">
        <Send className="w-5 h-5 text-blue-400" />
        <h1 className="text-lg font-semibold">Telegram Signals</h1>
        <button
          onClick={refresh}
          className="ml-auto text-sm px-3 py-1 rounded bg-gray-800/60 border border-gray-700/60"
        >
          Refresh
        </button>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard title="Channels" value={scorecards.length} trend="flat" />
        <StatCard title="Signals" value={signals.length} trend="flat" />
      </div>

      <div className="flex gap-2">
        {(['leaderboard', 'signals'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1 rounded text-sm ${tab === t ? 'bg-blue-600' : 'bg-gray-800/60'}`}
          >
            {t === 'leaderboard' ? 'Leaderboard' : 'Signals feed'}
          </button>
        ))}
      </div>

      {isLoading ? (
        <LoadingSkeleton variant="card" />
      ) : tab === 'leaderboard' ? (
        scorecards.length ? (
          <DataTable columns={boardCols} data={scorecards as BoardRow[]} />
        ) : (
          <EmptyState title="No channels tracked yet" />
        )
      ) : signals.length ? (
        <DataTable columns={signalCols} data={signals as SignalRow[]} />
      ) : (
        <EmptyState title="No signals yet" />
      )}
    </div>
  );
}
