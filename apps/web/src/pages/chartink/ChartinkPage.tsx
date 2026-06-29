import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { listScanners, listAlerts, getAlert } from '@/services/chartink';
import type { ChartinkScanner, ChartinkAlert } from '@/types';
import ChartinkScoreTable from '@/components/chartink/ChartinkScoreTable';

const REFRESH_MS = 30_000;

function fmtDelta(receivedAt: string, triggeredAt: string): string {
  const delta = (new Date(receivedAt).getTime() - new Date(triggeredAt).getTime()) / 1000;
  if (delta < 1) return '<1s';
  if (delta < 60) return `${delta.toFixed(0)}s`;
  return `${(delta / 60).toFixed(1)}m`;
}

function fmtKindCount(setups: ChartinkAlert['setups']): string {
  const counts: Record<string, number> = {
    setup: 0, 'no-setup': 0, 'mtf-misaligned': 0, unresolved: 0, error: 0,
  };
  for (const s of setups ?? []) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  const parts: string[] = [];
  if (counts.setup) parts.push(`${counts.setup} setups`);
  if (counts['no-setup']) parts.push(`${counts['no-setup']} no-setup`);
  if (counts['mtf-misaligned']) parts.push(`${counts['mtf-misaligned']} mtf-misaligned`);
  if (counts.unresolved) parts.push(`${counts.unresolved} unresolved`);
  if (counts.error) parts.push(`${counts.error} error`);
  return parts.length ? parts.join(' · ') : '—';
}

function fmtAlertScore(setups: ChartinkAlert['setups']): string {
  const scored = (setups ?? []).filter((s) => typeof s.score === 'number');
  if (scored.length === 0) return '—';
  const max = Math.max(...scored.map((s) => s.score as number));
  const maxSetup = scored.find((s) => s.score === max);
  const lots = maxSetup?.lotCount ?? 0;
  return `${max}/100 (${lots} lot${lots !== 1 ? 's' : ''})`;
}

export default function ChartinkPage() {
  const [scanners, setScanners] = useState<ChartinkScanner[]>([]);
  const [alerts, setAlerts] = useState<ChartinkAlert[]>([]);
  const [selectedAlert, setSelectedAlert] = useState<ChartinkAlert | null>(null);

  const refresh = async () => {
    try {
      const [s, a] = await Promise.all([listScanners(), listAlerts(50)]);
      setScanners(s);
      setAlerts(a);
    } catch (err) {
      console.warn('chartink refresh failed', err);
    }
  };

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, []);

  const onSelectAlert = async (alert: ChartinkAlert) => {
    try {
      const full = await getAlert(alert.id);
      setSelectedAlert(full);
    } catch {
      setSelectedAlert(alert);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Chartink</h1>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Scanners ({scanners.length})
        </h2>
        <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Slug</th>
                <th className="px-3 py-2 text-right">Fires</th>
                <th className="px-3 py-2">Last fired</th>
              </tr>
            </thead>
            <tbody>
              {scanners.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-[var(--color-text-muted)]">
                    No scanners configured yet. Configure your Chartink scanner's webhook URL to start.
                  </td>
                </tr>
              )}
              {scanners.map((s) => (
                <tr key={s.id} className="border-t border-[var(--color-border-subtle)]">
                  <td className="px-3 py-2">{s.scanName}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--color-text-muted)]">
                    <a
                      href={`https://chartink.com/screener/${s.scanUrl}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {s.scanUrl}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.fireCount}</td>
                  <td className="px-3 py-2 text-[var(--color-text-muted)]">
                    {s.lastFiredAt ? new Date(s.lastFiredAt).toLocaleString('en-IN') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Recent alerts ({alerts.length})
        </h2>
        <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2">Scanner</th>
                <th className="px-3 py-2">Triggered</th>
                <th className="px-3 py-2">Received delta</th>
                <th className="px-3 py-2">Outcomes</th>
                <th className="px-3 py-2">Score</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr
                  key={a.id}
                  onClick={() => onSelectAlert(a)}
                  className={clsx(
                    'cursor-pointer border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]',
                    selectedAlert?.id === a.id && 'bg-[var(--color-bg-tertiary)]',
                  )}
                >
                  <td className="px-3 py-2">{a.scanner?.scanName ?? '—'}</td>
                  <td className="px-3 py-2 text-[var(--color-text-muted)]">
                    {new Date(a.triggeredAt).toLocaleString('en-IN')}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
                    {fmtDelta(a.receivedAt, a.triggeredAt)}
                  </td>
                  <td className="px-3 py-2">{fmtKindCount(a.setups)}</td>
                  <td className="px-3 py-2 tabular-nums">{fmtAlertScore(a.setups)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selectedAlert && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Alert {selectedAlert.id} — per-symbol decisions
          </h2>
          <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
                <tr>
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2 text-right">Hit price</th>
                  <th className="px-3 py-2">Outcome</th>
                  <th className="px-3 py-2">Reason / Setup</th>
                </tr>
              </thead>
              <tbody>
                {(selectedAlert.setups ?? []).map((s) => (
                  <React.Fragment key={s.id}>
                    <tr className="border-t border-[var(--color-border-subtle)]">
                      <td className="px-3 py-2 font-mono">{s.symbol}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.hitPrice.toFixed(2)}</td>
                      <td
                        className={clsx(
                          'px-3 py-2 font-semibold uppercase tracking-wider',
                          s.kind === 'setup' && 'text-emerald-400',
                          s.kind === 'no-setup' && 'text-amber-400',
                          s.kind === 'unresolved' && 'text-gray-400',
                          s.kind === 'error' && 'text-red-400',
                        )}
                      >
                        {s.kind}
                      </td>
                      <td className="px-3 py-2 text-[var(--color-text-muted)]">
                        {s.setupId ? (
                          <a href={`/signals?signalId=${s.setupId}`} className="hover:underline">
                            → setup {s.setupId}
                          </a>
                        ) : (
                          s.rejectReason ?? '—'
                        )}
                      </td>
                    </tr>
                    {s.scoreBreakdown && typeof s.score === 'number' && typeof s.lotCount === 'number' && (
                      <tr className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/40">
                        <td colSpan={4} className="px-3 py-2">
                          <ChartinkScoreTable
                            score={s.score}
                            lotCount={s.lotCount as 0 | 1 | 2 | 3}
                            checks={s.scoreBreakdown}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
