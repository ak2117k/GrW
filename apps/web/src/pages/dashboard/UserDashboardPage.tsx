import { useEffect, useState } from 'react';
import { LayoutDashboard, Plug, RefreshCw, Wallet, UserCircle, ListOrdered, Bot } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { TiltCard } from '@/components/depth';
import { ConnectAngelOne } from '@/components/broker';
import { Toggle } from '@/components/common';
import { useDashboard, pickHeroStats } from '@/hooks/useDashboard';
import { useBrokerOverview } from '@/hooks/useBrokerOverview';
import { useAutoExec, type AutoExecSegment, type AutoExecState } from '@/hooks/useAutoExec';
import { formatMoney } from '@/hooks/formatMoney';
import { useAuthStore } from '@/stores/auth-store';
import { SymbolChartLink } from '@/components/common/SymbolChartLink';
import { isDerivative } from '@/utils/positionRow';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const fmtRs = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${inr.format(Math.abs(Math.round(n)))}`;
const moneyColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[var(--color-text-muted)]');

export default function UserDashboardPage() {
  const { summary, segments, broker, loading } = useDashboard();
  const hero = pickHeroStats(summary);
  const email = useAuthStore((s) => s.user?.email);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <LayoutDashboard size={24} className="text-[var(--color-text-secondary)]" />
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Dashboard</h1>
          <p className="text-xs text-[var(--color-text-muted)]">{email}</p>
        </div>
      </div>

      {/* Hero */}
      <TiltCard maxTiltDeg={5}>
        <div className="glass-panel depth-card p-6">
          <div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">Total P&L</div>
          <div className={clsx('mt-1 text-4xl font-bold tabular-nums', moneyColor(hero.totalPnl))}>
            {loading ? '—' : fmtRs(hero.totalPnl)}
          </div>
          <div className="mt-2 flex gap-6 text-xs text-[var(--color-text-muted)]">
            <span>{(hero.winRate * 100).toFixed(0)}% win rate</span>
            <span>{hero.trades} trades</span>
          </div>
          {!loading && hero.trades === 0 && (
            <p className="mt-3 text-xs text-[var(--color-text-muted)]">No executed trades yet — connect your broker and subscribe to a segment to begin.</p>
          )}
        </div>
      </TiltCard>

      {/* Segment breakdown */}
      {segments.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {segments.map((s) => (
            <TiltCard key={s.segment} maxTiltDeg={5}>
              <div className="depth-card depth-rise rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
                <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{s.segment}</div>
                <div className={clsx('mt-1 text-xl font-bold tabular-nums', moneyColor(s.pnl))}>{fmtRs(s.pnl)}</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">{s.trades} trades</div>
              </div>
            </TiltCard>
          ))}
        </div>
      )}

      {/* Angel One management */}
      <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5">
        <div className="mb-3 flex items-center gap-2">
          <Plug size={18} className="text-[var(--color-text-secondary)]" />
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Angel One Account</h2>
          {broker?.connected && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">Connected</span>}
        </div>
        <ConnectAngelOne />
      </div>

      {/* Live broker overview: Balance & Margin, Profile, Positions (one login) */}
      <BrokerOverviewSections />

      {/* Auto-execution controls (per-segment) */}
      <AutoExecSection />
    </div>
  );
}

// ─── Balance & Margin + Profile + Positions (share one useBrokerOverview) ─────

function BrokerOverviewSections() {
  const { data, loading, error, notConnected, refresh } = useBrokerOverview();
  const hasFetched = data !== null || notConnected || error !== null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wallet size={18} className="text-[var(--color-text-secondary)]" />
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Balance &amp; Positions</h2>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw size={13} className={clsx(loading && 'animate-spin')} />
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {!hasFetched && !loading && (
        <p className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5 text-xs text-[var(--color-text-muted)]">
          Press Refresh to pull your live balance, profile and open positions from Angel One. Each refresh performs one broker login.
        </p>
      )}

      {notConnected && (
        <p className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5 text-xs text-[var(--color-text-muted)]">
          Connect your Angel One account to see balance &amp; positions.
        </p>
      )}

      {error && (
        <p className="rounded-2xl border border-red-500/40 bg-red-500/10 p-5 text-xs text-red-400">{error}</p>
      )}

      {data && (
        <>
          {/* Balance & Margin */}
          <div className="grid gap-3 sm:grid-cols-3">
            <FundTile label="Available Cash" value={data.funds?.availableCash} />
            <FundTile label="Used Margin" value={data.funds?.utilisedMargin} />
            <FundTile label="Net" value={data.funds?.net} />
          </div>

          {/* Account Profile */}
          <TiltCard maxTiltDeg={4}>
            <div className="depth-card rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
              <div className="mb-3 flex items-center gap-2">
                <UserCircle size={16} className="text-[var(--color-text-secondary)]" />
                <span className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Account Profile</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Name" value={data.profile?.name || '—'} />
                <Field label="Broker" value={data.profile?.broker || '—'} />
                <div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">Exchanges</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {data.profile?.exchanges?.length ? (
                      data.profile.exchanges.map((ex) => (
                        <span key={ex} className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                          {ex}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm text-[var(--color-text-muted)]">—</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </TiltCard>

          {/* Positions / Holdings */}
          <div className="depth-card rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
            <div className="mb-3 flex items-center gap-2">
              <ListOrdered size={16} className="text-[var(--color-text-secondary)]" />
              <span className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Positions</span>
            </div>
            {data.positions?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                      <th className="py-1 pr-3 font-medium">Symbol</th>
                      <th className="py-1 pr-3 font-medium">Exch</th>
                      <th className="py-1 pr-3 text-right font-medium">Qty</th>
                      <th className="py-1 pr-3 text-right font-medium">LTP</th>
                      <th className="py-1 text-right font-medium">P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.positions.map((p, i) => (
                      <tr key={`${p.symbol}-${p.exchange}-${i}`} className="border-t border-[var(--color-border-subtle)]">
                        {/* LEFT: the UNDERLYING's chart. That is where the S/R
                            levels, zones and trend live — all of them are
                            computed for cash equities, so an option's own chart
                            comes up with bare overlays. Falls back to the traded
                            symbol for cash, where the two are the same thing. */}
                        <td className="py-1.5 pr-3 text-[var(--color-text-primary)]">
                          <SymbolChartLink
                            symbol={p.underlyingSymbol || p.symbol}
                            token={p.underlyingToken}
                            exchange="NSE"
                          />
                        </td>
                        <td className="py-1.5 pr-3 text-[var(--color-text-muted)]">{p.exchange}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{p.netQty}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{formatMoney(p.ltp)}</td>
                        {/* RIGHT: the traded CONTRACT's own chart — the premium
                            line this P&L is actually made of. Only for a real
                            derivative: on cash it would be the same destination
                            as the symbol cell, and a second link to one place
                            teaches the reader that the two ends differ when they
                            do not. */}
                        <td className={clsx('py-1.5 text-right tabular-nums font-medium', moneyColor(p.pnl ?? 0))}>
                          {isDerivative(p) ? (
                            <SymbolChartLink
                              symbol={p.symbol}
                              token={p.token}
                              exchange={p.exchange}
                              label={fmtRs(p.pnl ?? 0)}
                              className="justify-end"
                            />
                          ) : (
                            fmtRs(p.pnl ?? 0)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-[var(--color-text-muted)]">No open positions.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FundTile({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <TiltCard maxTiltDeg={5}>
      <div className="depth-card depth-rise rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
        <div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
        <div className="mt-1 text-xl font-bold tabular-nums text-[var(--color-text-primary)]">{formatMoney(value)}</div>
      </div>
    </TiltCard>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1 text-sm text-[var(--color-text-primary)]">{value}</div>
    </div>
  );
}

// ─── Auto-execution controls ──────────────────────────────────────────────────

const SEGMENT_ORDER: AutoExecSegment[] = ['INTRADAY', 'SWING'];

function AutoExecSection() {
  const { segments, loading, error, update } = useAutoExec();

  // Ensure both rows render (defaults) even before/without persisted state.
  const rows: AutoExecState[] = SEGMENT_ORDER.map(
    (seg) =>
      segments.find((s) => s.segment === seg) ?? {
        segment: seg,
        enabled: false,
        killSwitch: false,
        riskPerTrade: null,
        maxCapital: null,
        enabledAt: null,
      },
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Bot size={18} className="text-[var(--color-text-secondary)]" />
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Auto-Execution Controls</h2>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="grid gap-3">
        {rows.map((row) => (
          <AutoExecRow key={row.segment} row={row} disabled={loading} update={update} />
        ))}
      </div>
    </div>
  );
}

function AutoExecRow({
  row,
  disabled,
  update,
}: {
  row: AutoExecState;
  disabled: boolean;
  update: ReturnType<typeof useAutoExec>['update'];
}) {
  const [enabled, setEnabled] = useState(row.enabled);
  const [killSwitch, setKillSwitch] = useState(row.killSwitch);
  const [risk, setRisk] = useState<string>(row.riskPerTrade != null ? String(row.riskPerTrade) : '');
  const [cap, setCap] = useState<string>(row.maxCapital != null ? String(row.maxCapital) : '');
  const [saving, setSaving] = useState(false);

  // Keep local state in sync when the hook refreshes from the server.
  useEffect(() => {
    setEnabled(row.enabled);
    setKillSwitch(row.killSwitch);
    setRisk(row.riskPerTrade != null ? String(row.riskPerTrade) : '');
    setCap(row.maxCapital != null ? String(row.maxCapital) : '');
  }, [row.enabled, row.killSwitch, row.riskPerTrade, row.maxCapital]);

  const patchField = async (patch: Parameters<typeof update>[1], optimistic: () => void, revert: () => void) => {
    optimistic();
    setSaving(true);
    const res = await update(row.segment, patch);
    setSaving(false);
    if (!res.ok) {
      revert();
      toast.error(res.message);
    } else {
      toast.success(`${row.segment} settings saved`);
    }
  };

  const onToggleEnabled = (next: boolean) =>
    patchField(
      { enabled: next },
      () => setEnabled(next),
      () => setEnabled(!next), // revert on 409 consent rejection
    );

  const onToggleKill = (next: boolean) =>
    patchField(
      { killSwitch: next },
      () => setKillSwitch(next),
      () => setKillSwitch(!next),
    );

  const numOrNull = (s: string): number | null => {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  const onSaveLimits = () =>
    patchField(
      { riskPerTrade: numOrNull(risk), maxCapital: numOrNull(cap) },
      () => {},
      () => {},
    );

  return (
    <TiltCard maxTiltDeg={4}>
      <div className="depth-card rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-primary)]">{row.segment}</div>
          {killSwitch && (
            <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">Kill-switch on</span>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Toggle checked={enabled} disabled={disabled || saving} onChange={onToggleEnabled} label="Auto-execute" size="sm" />
          <Toggle checked={killSwitch} disabled={disabled || saving} onChange={onToggleKill} label="Kill switch" size="sm" />
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--color-text-muted)]">Risk / trade (₹)</span>
            <input
              type="number"
              inputMode="decimal"
              value={risk}
              onChange={(e) => setRisk(e.target.value)}
              placeholder="e.g. 2000"
              className="w-32 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent-blue)] focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--color-text-muted)]">Max capital (₹)</span>
            <input
              type="number"
              inputMode="decimal"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="e.g. 50000"
              className="w-32 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent-blue)] focus:outline-none"
            />
          </label>
          <button
            onClick={() => void onSaveLimits()}
            disabled={disabled || saving}
            className="rounded-md bg-[var(--color-accent-blue)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save limits'}
          </button>
        </div>
      </div>
    </TiltCard>
  );
}
