import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { Tabs } from '@/components/common';
import { cn } from '@/utils/cn';
import { apiErrorMessage } from '@/pages/core-strategies/core-strategy-picker';
import { SELF_REVIEW_KEYS, useLessons, useProposals, useSelfReviewRuns } from '@/hooks/useSelfReview';
import { retireLesson } from '@/services/selfReview';
import type { AgentLesson, TuningProposal } from '@/types/selfReview.types';
import { decideProposal, type Decision } from './proposalDecision';
import { sortLessons } from './selfReviewFormat';
import { Empty, LessonCard, MUTED, PRIMARY, ProposalCard, RunCard, SECONDARY } from './SelfReviewViews';

const TABS = [
  { key: 'proposals', label: 'Proposals' },
  { key: 'lessons', label: 'Lessons' },
  { key: 'history', label: 'History' },
];

function Failed({ error, onRetry, what }: { error: unknown; onRetry: () => void; what: string }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-[var(--color-accent-red)]">{apiErrorMessage(error, `Could not load ${what}`)}</p>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-10 rounded border border-[var(--color-border-default)] px-3 text-sm text-[var(--color-text-secondary)]"
      >
        Try again
      </button>
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-3" aria-busy="true">
      <div className="h-32 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
      <div className="h-32 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
    </div>
  );
}

function ProposalsTab() {
  const q = useProposals();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showDecided, setShowDecided] = useState(false);

  const onDecide = async (id: string, decision: Decision) => {
    setBusyId(id);
    await decideProposal(id, decision, {
      get: () => qc.getQueryData<TuningProposal[]>(SELF_REVIEW_KEYS.proposals) ?? [],
      set: (next) => qc.setQueryData(SELF_REVIEW_KEYS.proposals, next),
      onSuccess: (p) =>
        toast.success(decision === 'approve' ? `Approved: ${p.target} is ${p.status === 'APPLIED' ? 'applied' : 'being applied'}` : 'Proposal rejected'),
      onError: (e) => toast.error(apiErrorMessage(e, `Could not ${decision} the proposal`)),
    });
    setBusyId(null);
    void qc.invalidateQueries({ queryKey: SELF_REVIEW_KEYS.pendingCount });
  };

  if (q.isLoading) return <Loading />;
  if (q.isError) return <Failed error={q.error} onRetry={() => void q.refetch()} what="proposals" />;
  const all = q.data ?? [];
  const pending = all.filter((p) => p.status === 'PENDING');
  const decided = all.filter((p) => p.status !== 'PENDING');
  return (
    <div className="space-y-4">
      <p className={cn('text-xs', MUTED)}>
        Bounded changes the review raised from the evidence. Nothing changes until you approve; hard risk limits are never proposed.
      </p>
      {pending.length === 0 ? (
        <Empty text="No pending proposals." />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {pending.map((p) => (
            <ProposalCard key={p.id} p={p} busy={busyId === p.id} onDecide={(id, d) => void onDecide(id, d)} />
          ))}
        </div>
      )}
      {decided.length > 0 && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setShowDecided((v) => !v)}
            className={cn('min-h-10 text-sm font-medium text-[var(--color-accent-blue)]')}
          >
            {showDecided ? 'Hide' : 'Show'} decided ({decided.length})
          </button>
          {showDecided && (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {decided.map((p) => (
                <ProposalCard key={p.id} p={p} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LessonsTab() {
  const q = useLessons();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const onRetire = async (id: string) => {
    const before = qc.getQueryData<AgentLesson[]>(SELF_REVIEW_KEYS.lessons) ?? [];
    setBusyId(id);
    qc.setQueryData<AgentLesson[]>(SELF_REVIEW_KEYS.lessons, before.map((l) => (l.id === id ? { ...l, status: 'RETIRED' } : l)));
    try {
      await retireLesson(id);
      toast.success('Lesson retired');
    } catch (e) {
      qc.setQueryData(SELF_REVIEW_KEYS.lessons, before);
      toast.error(apiErrorMessage(e, 'Could not retire the lesson'));
    } finally {
      setBusyId(null);
    }
  };

  if (q.isLoading) return <Loading />;
  if (q.isError) return <Failed error={q.error} onRetry={() => void q.refetch()} what="lessons" />;
  const lessons = sortLessons(q.data ?? []);
  if (lessons.length === 0) return <Empty text="No lessons yet. They appear after the review diagnoses its first misses." />;
  return (
    <div className="space-y-3">
      <p className={cn('text-xs', MUTED)}>
        Active lessons with at least 2 right cases are fed to the agent. A lesson retires itself once it is wrong more often than right.
      </p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {lessons.map((l) => (
          <LessonCard key={l.id} l={l} busy={busyId === l.id} onRetire={(id) => void onRetire(id)} />
        ))}
      </div>
    </div>
  );
}

function HistoryTab() {
  const q = useSelfReviewRuns(30);
  if (q.isLoading) return <Loading />;
  if (q.isError) return <Failed error={q.error} onRetry={() => void q.refetch()} what="review runs" />;
  const runs = q.data ?? [];
  if (runs.length === 0) return <Empty text="No review runs yet." />;
  return (
    <div className="space-y-3">
      {runs.map((r) => (
        <RunCard key={r.id} run={r} />
      ))}
    </div>
  );
}

/** The self-review loop: proposals to approve, lessons the agent learned, and how past calls scored. */
export default function SelfReviewPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? (params.get('tab') as string) : 'proposals';
  const qc = useQueryClient();
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className={cn('text-lg font-semibold', PRIMARY)}>Self-review</h1>
          <p className={cn('text-xs', SECONDARY)}>Every call checked against what happened next session.</p>
        </div>
        <button
          type="button"
          onClick={() => void qc.invalidateQueries({ queryKey: ['self-review'] })}
          className="inline-flex min-h-10 items-center gap-1.5 rounded border border-[var(--color-border-default)] px-3 text-sm text-[var(--color-text-secondary)]"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <Tabs
        tabs={TABS}
        activeTab={tab}
        onChange={(k) => setParams(k === 'proposals' ? {} : { tab: k }, { replace: true })}
        className="overflow-x-auto"
      />
      {tab === 'proposals' && <ProposalsTab />}
      {tab === 'lessons' && <LessonsTab />}
      {tab === 'history' && <HistoryTab />}
    </div>
  );
}
