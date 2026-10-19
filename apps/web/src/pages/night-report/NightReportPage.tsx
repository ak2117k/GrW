import { useNightReport } from '@/hooks/useNightReport';
import { apiErrorMessage } from '@/pages/core-strategies/core-strategy-picker';
import { NightReportSkeleton, NightReportView } from './NightReportView';

/** The morning read: everything that happened overnight on one page. */
export default function NightReportPage() {
  const q = useNightReport();

  if (q.isLoading) return <NightReportSkeleton />;

  if (q.isError || !q.data) {
    return (
      <div className="mx-auto max-w-5xl space-y-3 p-4">
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Night Report</h1>
        <p className="text-sm text-[var(--color-accent-red)]">{apiErrorMessage(q.error, 'Could not load the night report')}</p>
        <button
          type="button"
          onClick={() => void q.refetch()}
          className="min-h-10 rounded border border-[var(--color-border-default)] px-3 text-sm text-[var(--color-text-secondary)]"
        >
          Try again
        </button>
      </div>
    );
  }

  return <NightReportView report={q.data} onRefresh={() => void q.refetch()} refreshing={q.isFetching} />;
}
