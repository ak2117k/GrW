import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDeskDecisions, useDeskState } from '@/hooks/useDesk';
import { apiErrorMessage } from '@/pages/core-strategies/core-strategy-picker';
import { pauseDesk, resetDeskGuard, resumeDesk, type DeskDecision, type DeskGuard } from '@/services/deskManager';

const inr = (n: number) => `${n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const time = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—';

const STATUS_TONE: Record<string, string> = {
  DONE: 'text-emerald-500',
  PENDING: 'text-amber-500',
  RECORDED: 'text-slate-400',
  REFUSED: 'text-orange-500',
  FAILED: 'text-red-500',
  INVALID: 'text-red-500',
  VALID: 'text-slate-400',
};

function isGuard(g: unknown): g is DeskGuard {
  return !!g && typeof g === 'object' && 'path' in g;
}

function GuardCard({ guard, onChanged }: { guard: DeskGuard | { error: string }; onChanged: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setNote(done);
      onChanged();
    } catch (e) {
      setNote(apiErrorMessage(e, 'The request failed'));
    }
  };
  if (!isGuard(guard)) return <section className="rounded-lg border border-red-500/40 p-4 text-sm">Guard unreadable: {guard.error}</section>;
  const p = guard.path;
  return (
    <section className="rounded-lg border border-slate-700/60 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">Day guard</h2>
        <span className={guard.blocked ? 'font-semibold text-red-500' : 'text-emerald-500'}>{guard.blocked ? 'New automatic entries BLOCKED' : 'Entries allowed'}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
        <div>Total <b>{inr(p.total)}</b></div>
        <div>Realised {inr(p.realised)}</div>
        <div>Open {inr(p.open)}</div>
        <div>Peak {inr(p.peak)} · drawdown {inr(p.drawdownFromPeak)}</div>
        <div>Losers in a row <b>{p.lossStreak}</b></div>
      </div>
      {guard.reasons.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm text-red-400">{guard.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        <button className="rounded border px-3 py-1" onClick={() => act(() => pauseDesk('all', 30), 'Paused all automatic entries for 30 min.')}>Pause 30 min</button>
        <button className="rounded border px-3 py-1" onClick={() => act(resumeDesk, 'Pause lifted.')}>Resume</button>
        <button className="rounded border px-3 py-1" onClick={() => act(resetDeskGuard, 'Guard reset: trades closed before now no longer count today.')}>Reset guard</button>
      </div>
      {note && <p className="mt-2 text-xs text-slate-400">{note}</p>}
    </section>
  );
}

function DecisionRow({ d }: { d: DeskDecision }) {
  const tone = STATUS_TONE[d.status] ?? 'text-slate-300';
  const evidence = Array.isArray(d.payload?.evidence) ? d.payload.evidence : [];
  return (
    <li className="border-b border-slate-800 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="tabular-nums text-slate-400">{time(d.createdAt)}</span>
        <b>{d.action}</b>
        {d.underlying && <span>{d.underlying}</span>}
        <span className={tone}>{d.status}</span>
        {d.result?.detail && <span className="text-slate-400">— {d.result.detail}</span>}
      </div>
      {d.payload?.reason && <p className="mt-1">{d.payload.reason}</p>}
      {evidence.length > 0 && <p className="mt-1 text-xs text-slate-400">Evidence: {evidence.join(' · ')}</p>}
      {!d.validation.ok && <p className="mt-1 text-xs text-red-400">Rejected by code: {d.validation.problems.join('; ')}</p>}
    </li>
  );
}

/** The desk manager's page: what it thinks, what it decided and why, the day guard, and the data it could not see. */
export default function DeskPage() {
  const qc = useQueryClient();
  const s = useDeskState();
  const d = useDeskDecisions();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['desk-state'] });
    void qc.invalidateQueries({ queryKey: ['desk-decisions'] });
  };

  if (s.isLoading) return <div className="p-4 text-sm text-slate-400">Loading the desk…</div>;
  if (s.error || !s.data) return <div className="p-4 text-sm text-red-400">{apiErrorMessage(s.error, 'Could not load the desk')}</div>;
  const st = s.data;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Desk manager</h1>
        <span className="text-sm">
          Mode <b className={st.mode === 'live' ? 'text-emerald-500' : st.mode === 'shadow' ? 'text-amber-500' : 'text-slate-400'}>{st.mode.toUpperCase()}</b>
          {' · '}last run {time(st.lastRun?.finishedAt ?? st.lastRun?.startedAt)}
          {st.opensBlocked && <span className="ml-2 text-red-500">new manager entries blocked (manager silent or capped)</span>}
        </span>
      </header>

      <section className="rounded-lg border border-slate-700/60 p-4">
        <h2 className="mb-1 font-semibold">Manager's view</h2>
        {st.lastRun?.error ? <p className="text-sm text-red-400">Last run failed: {st.lastRun.error}</p> : <p className="whitespace-pre-wrap text-sm">{st.lastRun?.summary ?? 'No run yet.'}</p>}
      </section>

      <GuardCard guard={st.guard} onChanged={refresh} />

      <section className="rounded-lg border border-slate-700/60 p-4">
        <h2 className="mb-1 font-semibold">Decisions today</h2>
        {d.isLoading ? <p className="text-sm text-slate-400">Loading…</p> : (d.data ?? []).length === 0 ? <p className="text-sm text-slate-400">No decisions yet today.</p> : <ul>{(d.data ?? []).map((x) => <DecisionRow key={x.id} d={x} />)}</ul>}
      </section>

      <section className="rounded-lg border border-slate-700/60 p-4">
        <h2 className="mb-1 font-semibold">Data the reader could not check today</h2>
        {st.dataHoles.length === 0 ? <p className="text-sm text-slate-400">None.</p> : (
          <ul className="text-sm">{st.dataHoles.map((h) => <li key={h.code}>{h.code}: {h.count}</li>)}</ul>
        )}
      </section>
    </div>
  );
}
