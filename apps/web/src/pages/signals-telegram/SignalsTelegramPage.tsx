import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { apiErrorMessage } from '@/pages/core-strategies/core-strategy-picker';
import { getSignalOverview } from './signalsTelegram';
import { SignalsTelegramView } from './SignalsTelegramView';

/** Owner-only: Telegram signal trading — decisions, open signal trades, per-channel stats. */
export default function SignalsTelegramPage() {
  const q = useQuery({ queryKey: ['signal-trader', 'overview'], queryFn: getSignalOverview, refetchInterval: 30_000, staleTime: 15_000 });
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Telegram signals</h1>
        <button
          type="button"
          onClick={() => void q.refetch()}
          className="inline-flex min-h-10 items-center gap-1.5 rounded border border-[var(--color-border-default)] px-3 text-sm text-[var(--color-text-secondary)]"
          aria-label="Refresh"
        >
          <RefreshCw className={q.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </button>
      </div>
      {q.isLoading ? (
        <div className="h-32 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" aria-busy="true" />
      ) : q.isError ? (
        <p className="text-sm text-[var(--color-accent-red)]">{apiErrorMessage(q.error, 'Could not load signal trading')}</p>
      ) : q.data ? (
        <SignalsTelegramView data={q.data} />
      ) : null}
    </div>
  );
}
