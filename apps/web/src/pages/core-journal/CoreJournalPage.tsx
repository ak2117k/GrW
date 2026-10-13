import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ScrollText } from 'lucide-react';
import { LoadingSkeleton } from '@/components/common';
import {
  ackReconFinding,
  getCoreComparison,
  getCoreJournalDay,
  getCoreJournalStatus,
  getCorePositionTimeline,
} from '@/services/coreJournal';
import { apiErrorMessage } from '@/pages/core-strategies/core-strategy-picker';
import { BUTTON, CARD, FIELD, LABEL, QUIET, TONE } from '@/pages/core-risk/core-risk-styles';
import { createVisibilityAwarePoller } from '@/services/interval-poller';
import { useAuthStore } from '@/stores/auth-store';
import { ackPayload, eventLine, istTime, pnlTone, pollsDay, rupees, skipRows, statusBanner } from './core-journal';

/** Status (and today's day) refresh cadence; paused while the tab is hidden. */
const POLL_MS = 15_000;

const todayIst = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * SP2 Core Journal (spec §8.4): status (entries mode, journal health, blind and exiting positions,
 * reconciliation findings with their acknowledgement), the day's summary and closed trades, a
 * per-position timeline, skip reasons, and — for the owner — the core-vs-silo comparison.
 */
export default function CoreJournalPage() {
  const qc = useQueryClient();
  const isOwner = useAuthStore((s) => s.user?.role) === 'ADMIN';
  const [day, setDay] = useState(todayIst());
  const [positionId, setPositionId] = useState<string | null>(null);
  const [ackFor, setAckFor] = useState<string | null>(null);
  const [ackReason, setAckReason] = useState('');

  const statusQ = useQuery({ queryKey: ['trade-core', 'journal', 'status'], queryFn: getCoreJournalStatus });
  const dayQ = useQuery({ queryKey: ['trade-core', 'journal', 'day', day], queryFn: () => getCoreJournalDay(day) });
  const timelineQ = useQuery({ queryKey: ['trade-core', 'journal', 'position', positionId], queryFn: () => getCorePositionTimeline(positionId as string), enabled: positionId !== null });
  const comparisonQ = useQuery({ queryKey: ['trade-core', 'journal', 'comparison', day], queryFn: () => getCoreComparison(day), enabled: isOwner });

  // Poll through the shared visibility-aware poller (no refresh while the tab is hidden).
  const dayRef = useRef(day);
  dayRef.current = day;
  useEffect(() => {
    const poller = createVisibilityAwarePoller({
      intervalMs: POLL_MS,
      shouldPoll: () => true,
      task: async () => {
        await qc.invalidateQueries({ queryKey: ['trade-core', 'journal', 'status'] });
        if (pollsDay(dayRef.current, todayIst())) await qc.invalidateQueries({ queryKey: ['trade-core', 'journal', 'day', dayRef.current] });
      },
    });
    return () => poller.stop();
  }, [qc]);

  const ack = useMutation({
    mutationFn: (a: { id: string; reason: string }) => ackReconFinding(a.id, a.reason),
    onSuccess: () => {
      toast.success('Acknowledged — entries for it are unblocked');
      setAckFor(null);
      setAckReason('');
      void qc.invalidateQueries({ queryKey: ['trade-core', 'journal'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not acknowledge')),
  });

  if (statusQ.isLoading || dayQ.isLoading) return <LoadingSkeleton />;
  const status = statusQ.data;
  const d = dayQ.data;
  const banner = status ? statusBanner(status) : null;

  return (
    <div className="space-y-4 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <ScrollText size={18} className="text-[var(--color-accent-blue)]" />
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Core Journal</h1>
        <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Paper only</span>
        <label className={`${LABEL} ml-auto`}>
          Day
          <input type="date" className={FIELD} value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
      </header>

      {(statusQ.isError || dayQ.isError) && (
        <p className={`text-sm ${TONE.danger}`}>
          {statusQ.isError ? apiErrorMessage(statusQ.error, 'Could not read the journal status') : apiErrorMessage(dayQ.error, 'Could not read the day')}
        </p>
      )}

      {banner && status && (
        <section className={`${CARD} border-2 ${banner.tone === 'danger' ? 'border-[var(--color-accent-red)]' : ''}`}>
          {banner.lines.map((l) => (
            <p key={l} className={`text-sm ${TONE[banner.tone === 'ok' ? 'ok' : banner.tone === 'warn' ? 'warn' : 'danger']}`}>{l}</p>
          ))}
          {status.mismatches.map((m) => (
            <div key={m.id} className="space-y-1 border-t border-[var(--color-border-default)] pt-2 text-xs">
              <p className="text-[var(--color-text-secondary)]">
                {istTime(m.createdAt)} · {String(m.payload.check)} · {String(m.payload.detail)}
              </p>
              {ackFor === m.id ? (
                <div className="flex flex-wrap gap-2">
                  <input className={FIELD} placeholder="Why is it safe to resume?" value={ackReason} onChange={(e) => setAckReason(e.target.value)} />
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={ack.isPending}
                    onClick={() => {
                      const p = ackPayload(ackReason);
                      if (!p.ok) return toast.error(p.error);
                      ack.mutate({ id: m.id, reason: p.value.reason });
                    }}
                  >
                    Acknowledge
                  </button>
                  <button type="button" className={QUIET} onClick={() => setAckFor(null)}>Cancel</button>
                </div>
              ) : (
                <button type="button" className={QUIET} onClick={() => setAckFor(m.id)}>Acknowledge…</button>
              )}
            </div>
          ))}
        </section>
      )}

      {d && (
        <section className={CARD}>
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {d.day}{d.latched ? ' · daily loss reached: entries blocked for the day' : ''}
          </h2>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            <div>Net <span className={TONE[pnlTone(d.summary.netPnl)]}>{rupees(d.summary.netPnl)}</span></div>
            <div>Trades {d.summary.trades} ({d.summary.wins}W / {d.summary.losses}L)</div>
            <div>Win rate {d.summary.winRatePct ?? '—'}%</div>
            <div>Costs {rupees(d.summary.costs)} ({d.summary.costsPctOfGross ?? '—'}% of gross)</div>
            <div>Setups {d.setups}</div>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--color-text-muted)]">
                <th>Closed</th><th>Symbol</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Net</th><th>R</th><th>Exit reason</th>
              </tr>
            </thead>
            <tbody>
              {d.trades.map((t) => (
                <tr key={t.positionId} className="cursor-pointer hover:bg-[var(--color-bg-secondary)]" onClick={() => setPositionId(t.positionId)}>
                  <td>{istTime(t.closedAt)}</td><td>{t.symbol}</td><td>{t.qty}</td><td>{t.entryAvgPrice}</td><td>{t.exitAvgPrice}</td>
                  <td className={TONE[pnlTone(t.netPnl)]}>{rupees(t.netPnl)}</td><td>{t.rMultiple ?? '—'}</td><td>{t.exitReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {skipRows(d.skips).length > 0 && (
            <div className="text-xs text-[var(--color-text-secondary)]">
              Skipped: {skipRows(d.skips).map((s) => `${s.label} ${s.count}`).join(' · ')}
            </div>
          )}
        </section>
      )}

      {positionId && timelineQ.data && (
        <section className={CARD}>
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {timelineQ.data.position.instrument.symbol} · {timelineQ.data.position.status}
            <button type="button" className={`${QUIET} ml-2`} onClick={() => setPositionId(null)}>Close</button>
          </h2>
          <ol className="space-y-1 text-xs">
            {timelineQ.data.events.map((e) => {
              const l = eventLine(e);
              return (
                <li key={e.id}>
                  <span className="text-[var(--color-text-muted)]">{l.time}</span> <span className="font-medium">{l.title}</span>
                  {l.detail && <span className="text-[var(--color-text-secondary)]"> — {l.detail}</span>}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {isOwner && comparisonQ.data && comparisonQ.data.length > 0 && (
        <section className={CARD}>
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Core vs silo (same Chartink alert)</h2>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--color-text-muted)]"><th>Symbol</th><th>Strategy</th><th>Core</th><th>Core net</th><th>Silo</th><th>Silo P&amp;L</th></tr>
            </thead>
            <tbody>
              {comparisonQ.data.map((r) => (
                <tr key={r.intentId}>
                  <td>{r.symbol ?? r.token}</td><td>{r.strategyKey}</td>
                  <td>{r.core.outcome}{r.core.reason ? ` (${r.core.reason})` : ''}</td>
                  <td className={TONE[pnlTone(r.core.netPnl)]}>{rupees(r.core.netPnl)}</td>
                  <td>{r.silo ? `${r.silo.status}${r.silo.exitReason ? ` (${r.silo.exitReason})` : ''}` : '—'}</td>
                  <td>{r.silo?.pnl === null || r.silo?.pnl === undefined ? '—' : rupees(String(r.silo.pnl))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
