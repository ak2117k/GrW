import { useState } from 'react';
import { useStrategyReview } from '../../hooks/useStrategyReview';
import type {
  StrategyReviewDayRow,
  StrategyReviewFactorRow,
  StrategyReviewRealized,
  StrategyReviewScannerRow,
  StrategyReviewScoreBucketRow,
} from '../../hooks/useStrategyReview';
import { fmtPct, fmtRupees, fmtCount, signColor } from '../../utils/strategyReviewFormat';

/** A boxed metric in a summary strip. */
function SummaryCard({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${valueClass ?? 'text-[var(--color-text-primary)]'}`}>
        {value}
      </div>
    </div>
  );
}

const th = 'py-2 px-3 text-xs font-medium text-[var(--color-text-muted)]';
const td = 'py-2 px-3 text-sm text-[var(--color-text-primary)]';
const tdNum = `${td} text-right tabular-nums`;

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
      <h2 className="border-b border-[var(--color-border-subtle)] px-4 py-3 text-sm font-semibold text-[var(--color-text-primary)]">
        {title}
      </h2>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

function ScannerTable({ rows }: { rows: StrategyReviewScannerRow[] }) {
  if (rows.length === 0) {
    return <div className="px-4 py-6 text-sm text-[var(--color-text-muted)]">No scanner data.</div>;
  }
  return (
    <table className="min-w-full">
      <thead className="border-b border-[var(--color-border-subtle)]">
        <tr>
          <th className={`${th} text-left`}>Scanner</th>
          <th className={`${th} text-right`}>Entries</th>
          <th className={`${th} text-right`}>Resolved</th>
          <th className={`${th} text-right`}>Wins</th>
          <th className={`${th} text-right`}>Win Rate</th>
          <th className={`${th} text-right`} title="Average maximum favorable excursion">
            Avg MFE %
          </th>
          <th className={`${th} text-right`} title="Average maximum adverse excursion">
            Avg MAE %
          </th>
          <th className={`${th} text-right`}>Executed</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.scanner} className="border-b border-[var(--color-border-subtle)] last:border-0">
            <td className={`${td} text-left`}>{r.scanner}</td>
            <td className={tdNum}>{fmtCount(r.entries)}</td>
            <td className={tdNum}>{fmtCount(r.resolved)}</td>
            <td className={tdNum}>{fmtCount(r.wins)}</td>
            <td className={tdNum}>{fmtPct(r.winRate)}</td>
            <td className={`${tdNum} text-emerald-400`}>{fmtPct(r.avgMfePct)}</td>
            <td className={`${tdNum} text-red-400`}>{fmtPct(r.avgMaePct)}</td>
            <td className={tdNum}>{fmtCount(r.executed)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ScoreBucketTable({ rows }: { rows: StrategyReviewScoreBucketRow[] }) {
  if (rows.length === 0) {
    return <div className="px-4 py-6 text-sm text-[var(--color-text-muted)]">No score-bucket data.</div>;
  }
  return (
    <table className="min-w-full">
      <thead className="border-b border-[var(--color-border-subtle)]">
        <tr>
          <th className={`${th} text-left`}>Score Bucket</th>
          <th className={`${th} text-right`}>Entries</th>
          <th className={`${th} text-right`}>Resolved</th>
          <th className={`${th} text-right`}>Wins</th>
          <th className={`${th} text-right`}>Win Rate</th>
          <th className={`${th} text-right`} title="Average maximum favorable excursion">
            Avg MFE %
          </th>
          <th className={`${th} text-right`} title="Average maximum adverse excursion">
            Avg MAE %
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.bucket} className="border-b border-[var(--color-border-subtle)] last:border-0">
            <td className={`${td} text-left`}>{r.bucket}</td>
            <td className={tdNum}>{fmtCount(r.entries)}</td>
            <td className={tdNum}>{fmtCount(r.resolved)}</td>
            <td className={tdNum}>{fmtCount(r.wins)}</td>
            <td className={tdNum}>{fmtPct(r.winRate)}</td>
            <td className={`${tdNum} text-emerald-400`}>{fmtPct(r.avgMfePct)}</td>
            <td className={`${tdNum} text-red-400`}>{fmtPct(r.avgMaePct)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FactorTable({ rows }: { rows: StrategyReviewFactorRow[] }) {
  if (rows.length === 0) {
    return <div className="px-4 py-6 text-sm text-[var(--color-text-muted)]">No factor data.</div>;
  }
  return (
    <table className="min-w-full">
      <thead className="border-b border-[var(--color-border-subtle)]">
        <tr>
          <th className={`${th} text-left`}>Factor</th>
          <th className={`${th} text-right`} title="Resolved alerts where this factor passed">
            Pass W/R
          </th>
          <th className={`${th} text-right`}>Pass Win Rate</th>
          <th className={`${th} text-right`} title="Resolved alerts where this factor failed">
            Fail W/R
          </th>
          <th className={`${th} text-right`}>Fail Win Rate</th>
          <th
            className={`${th} text-right`}
            title="Pass win rate minus fail win rate — the factor's edge"
          >
            Edge
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.factor} className="border-b border-[var(--color-border-subtle)] last:border-0">
            <td className={`${td} text-left`}>{r.factor}</td>
            <td className={tdNum}>
              {fmtCount(r.passWins)} / {fmtCount(r.passResolved)}
            </td>
            <td className={tdNum}>{fmtPct(r.passWinRate)}</td>
            <td className={tdNum}>
              {fmtCount(r.failWins)} / {fmtCount(r.failResolved)}
            </td>
            <td className={tdNum}>{fmtPct(r.failWinRate)}</td>
            <td
              className={`${tdNum} font-semibold ${
                Number.isFinite(r.edge) && r.edge > 0
                  ? 'text-emerald-400'
                  : Number.isFinite(r.edge) && r.edge < 0
                    ? 'text-red-400'
                    : 'text-[var(--color-text-secondary)]'
              }`}
            >
              {Number.isFinite(r.edge) && r.edge > 0 ? '+' : ''}
              {fmtPct(r.edge)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DayTable({ rows }: { rows: StrategyReviewDayRow[] }) {
  if (rows.length === 0) {
    return <div className="px-4 py-6 text-sm text-[var(--color-text-muted)]">No daily data.</div>;
  }
  return (
    <table className="min-w-full">
      <thead className="border-b border-[var(--color-border-subtle)]">
        <tr>
          <th className={`${th} text-left`}>Date</th>
          <th className={`${th} text-right`}>Entries</th>
          <th className={`${th} text-right`}>Resolved</th>
          <th className={`${th} text-right`}>Wins</th>
          <th className={`${th} text-right`}>Win Rate</th>
          <th className={`${th} text-right`}>Executed</th>
          <th className={`${th} text-right`}>Realized Net P&amp;L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.date} className="border-b border-[var(--color-border-subtle)] last:border-0">
            <td className={`${td} text-left`}>{r.date}</td>
            <td className={tdNum}>{fmtCount(r.entries)}</td>
            <td className={tdNum}>{fmtCount(r.resolved)}</td>
            <td className={tdNum}>{fmtCount(r.wins)}</td>
            <td className={tdNum}>{fmtPct(r.winRate)}</td>
            <td className={tdNum}>{fmtCount(r.executed)}</td>
            <td className={`${tdNum} ${signColor(r.realizedNetPnl)}`}>
              {fmtRupees(r.realizedNetPnl)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Real-money panel. Visually distinct (indigo border + tint) so the executed
 * win rate is never confused with the watched-alert win rate.
 */
function RealizedPanel({ realized }: { realized: StrategyReviewRealized }) {
  return (
    <section className="mb-6 rounded-lg border-2 border-indigo-500/50 bg-indigo-500/[0.06]">
      <h2 className="border-b border-indigo-500/40 px-4 py-3 text-sm font-semibold text-indigo-300">
        Executed Trades — Real Money
      </h2>
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-7">
        <SummaryCard label="Closed Trades" value={fmtCount(realized.closedTrades)} />
        <SummaryCard label="Winners" value={fmtCount(realized.winners)} />
        <SummaryCard label="Win Rate" value={fmtPct(realized.winRate)} />
        <SummaryCard
          label="Gross P&L"
          value={fmtRupees(realized.grossPnl)}
          valueClass={signColor(realized.grossPnl)}
        />
        <SummaryCard
          label="Fees"
          value={fmtRupees(-Math.abs(realized.fees))}
          valueClass="text-red-400"
        />
        <SummaryCard
          label="Net P&L"
          value={fmtRupees(realized.netPnl)}
          valueClass={signColor(realized.netPnl)}
        />
        <SummaryCard
          label="Expectancy"
          value={fmtRupees(realized.expectancy)}
          valueClass={signColor(realized.expectancy)}
        />
      </div>
    </section>
  );
}

type ReviewViewMode = 'cumulative' | 'daywise';

export function StrategyReviewPage() {
  const { review, loading, error } = useStrategyReview();
  const [viewMode, setViewMode] = useState<ReviewViewMode>('cumulative');

  return (
    <div className="p-6 text-[var(--color-text-primary)]">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-[var(--color-text-primary)]">Strategy Review</h1>
        {review?.range && (review.range.from || review.range.to) && (
          <div className="text-sm text-[var(--color-text-muted)]">
            {review.range.from ?? '…'} → {review.range.to ?? '…'}
          </div>
        )}
      </div>

      <div className="mb-4 flex gap-2">
        {(['cumulative', 'daywise'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              viewMode === mode
                ? 'bg-blue-600 text-white'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            {mode === 'cumulative' ? 'Cumulative' : 'Day-wise'}
          </button>
        ))}
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">Error: {error}</div>}

      {!loading && !error && review && (
        <>
          {review.sampleWarning && (
            <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-300">
              {review.sampleWarning}
            </div>
          )}

          {viewMode === 'daywise' ? (
            <SectionCard title="By Day">
              <DayTable rows={review.byDay ?? []} />
            </SectionCard>
          ) : (
            <>
              {/* Watched Alerts — headline analysis of ALL alerts */}
              <section className="mb-6">
                <h2 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
                  Watched Alerts
                </h2>
                <p className="mb-3 text-xs text-[var(--color-text-muted)]">
                  Every watched alert — win = hit target, loss = stopped out. Not real money.
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
                  <SummaryCard
                    label="Watch Entries"
                    value={fmtCount(review.summary.watchEntries)}
                  />
                  <SummaryCard label="Resolved" value={fmtCount(review.summary.resolved)} />
                  <SummaryCard label="Wins" value={fmtCount(review.summary.wins)} />
                  <SummaryCard label="Losses" value={fmtCount(review.summary.losses)} />
                  <SummaryCard label="Win Rate" value={fmtPct(review.summary.winRate)} />
                  <SummaryCard label="Open" value={fmtCount(review.summary.open)} />
                  <SummaryCard label="Executed" value={fmtCount(review.summary.executed)} />
                  <SummaryCard
                    label="Avg MFE %"
                    value={fmtPct(review.summary.avgMfePct)}
                    valueClass="text-emerald-400"
                  />
                  <SummaryCard
                    label="Avg MAE %"
                    value={fmtPct(review.summary.avgMaePct)}
                    valueClass="text-red-400"
                  />
                </div>
              </section>

              {/* Executed Trades — real money, visually distinct */}
              <RealizedPanel realized={review.realized} />

              <SectionCard title="By Scanner">
                <ScannerTable rows={review.byScanner ?? []} />
              </SectionCard>

              <SectionCard title="By Score Bucket">
                <ScoreBucketTable rows={review.byScoreBucket ?? []} />
              </SectionCard>

              <SectionCard title="By Factor">
                <FactorTable rows={review.byFactor ?? []} />
              </SectionCard>
            </>
          )}
        </>
      )}

      {!loading && !error && !review && (
        <div className="text-[var(--color-text-muted)]">No review data available.</div>
      )}
    </div>
  );
}

export default StrategyReviewPage;
