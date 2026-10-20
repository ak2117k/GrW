import { useEffect, useState } from 'react';
import { useNightReport } from '@/hooks/useNightReport';
import { apiErrorMessage } from '@/pages/core-strategies/core-strategy-picker';
import { rerunNightAnalysis } from '@/services/nightReport';
import { NightReportSkeleton, NightReportView } from './NightReportView';

/** How long the page keeps polling after a re-run starts (one judge call per position takes minutes). */
const RERUN_POLL_MS = 30_000;
const RERUN_WATCH_MS = 10 * 60_000;

/** The morning read: everything that happened overnight on one page. */
export default function NightReportPage() {
  const q = useNightReport();
  const [rerunUntil, setRerunUntil] = useState<number | null>(null);
  const [rerunNote, setRerunNote] = useState<string | null>(null);

  useEffect(() => {
    if (rerunUntil === null) return;
    const id = window.setInterval(() => {
      if (Date.now() > rerunUntil) {
        setRerunUntil(null);
        setRerunNote('Re-run finished. The report shows the newest analysis.');
        return;
      }
      void q.refetch();
    }, RERUN_POLL_MS);
    return () => window.clearInterval(id);
  }, [rerunUntil, q]);

  const onRerun = async () => {
    try {
      const res = await rerunNightAnalysis();
      if (!res.started) {
        setRerunNote(res.reason ?? 'The re-run did not start.');
        return;
      }
      setRerunNote('Re-running the night analysis. It takes a few minutes; this page refreshes itself.');
      setRerunUntil(Date.now() + RERUN_WATCH_MS);
    } catch (e) {
      setRerunNote(apiErrorMessage(e, 'Could not start the re-run'));
    }
  };

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

  return (
    <NightReportView
      report={q.data}
      onRefresh={() => void q.refetch()}
      refreshing={q.isFetching}
      onRerun={() => void onRerun()}
      rerunning={rerunUntil !== null}
      rerunNote={rerunNote}
    />
  );
}
