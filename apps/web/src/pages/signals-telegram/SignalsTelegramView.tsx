import { Badge } from '@/components/common';
import { cn } from '@/utils/cn';
import {
  channelStatsLine,
  decisionWhy,
  modeBadge,
  openOrders,
  planLine,
  skipLabel,
  type SignalDecisionRow,
  type SignalOverview,
} from './signalsTelegram';

const CARD = 'rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-3 sm:p-4';
const MUTED = 'text-[var(--color-text-muted)]';
const PRIMARY = 'text-[var(--color-text-primary)]';
const SECONDARY = 'text-[var(--color-text-secondary)]';

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
};

function DecisionCard({ d }: { d: SignalDecisionRow }) {
  const take = d.decision === 'TAKE';
  return (
    <div className={CARD} data-testid="signal-decision">
      <div className="flex flex-wrap items-center gap-2">
        <Badge label={d.decision ?? d.status} variant={take ? 'success' : d.decision === 'SKIP' ? 'neutral' : 'info'} size="sm" />
        <span className={cn('text-sm font-medium', PRIMARY)}>{d.underlying ?? '—'}</span>
        <span className={cn('text-xs', MUTED)}>{d.channel ?? 'unknown channel'}</span>
        {d.conflict && <Badge label="CONFLICT" variant="warning" size="sm" />}
        {(d.agreeCount ?? 0) > 1 && <span className={cn('text-xs', SECONDARY)}>{d.agreeCount} channels agree</span>}
        <span className={cn('ml-auto text-xs', MUTED)}>
          {time(d.decidedAt)} · {d.mode}
          {d.evaluation > 1 ? ` · re-eval ${d.evaluation}` : ''}
        </span>
      </div>
      {d.plan?.tradingsymbol && <p className={cn('mt-2 text-sm', SECONDARY)}>{planLine(d.plan)}</p>}
      <p className={cn('mt-1 text-xs', MUTED)}>
        {d.decision === 'SKIP' && <span className="font-medium text-amber-400">{skipLabel(d.skipReason)}: </span>}
        {decisionWhy(d)}
        {typeof d.judge?.effectiveConfidence === 'number' && ` (AI confidence ${d.judge.effectiveConfidence})`}
      </p>
      {d.gate && d.gate.length > 0 && (
        <details className="mt-2">
          <summary className={cn('cursor-pointer text-xs', MUTED)}>Gate checks</summary>
          <ul className="mt-1 space-y-0.5">
            {d.gate.map((c) => (
              <li key={c.name} className="text-xs">
                <span className={c.ok === true ? 'text-emerald-400' : c.ok === false ? (c.required ? 'text-red-400' : 'text-amber-400') : MUTED}>
                  {c.ok === true ? '✓' : c.ok === false ? '✗' : '·'} {c.name}
                </span>{' '}
                <span className={MUTED}>{c.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function SignalsTelegramView({ data }: { data: SignalOverview }) {
  const badge = modeBadge(data.mode);
  const open = openOrders(data.orders);
  const takes = data.decisions.filter((d) => d.decision === 'TAKE').length;
  return (
    <div className="space-y-4">
      <div className={CARD}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge label={badge.label} variant={badge.variant} />
          <span className={cn('text-sm', SECONDARY)}>
            {takes} take{takes === 1 ? '' : 's'} / {data.decisions.length} signal decisions today
          </span>
        </div>
        <p className={cn('mt-2 text-xs', MUTED)} data-testid="signal-caps">
          Caps: max {data.caps.maxLots} lots · max loss {inr(data.caps.maxLossPerTrade)}/trade · {data.caps.maxTradesPerDay} trades/day · daily stop{' '}
          {inr(data.caps.dailyLossStop)} · entry band {data.caps.entryTolerancePct}% · {data.caps.product}
        </p>
        <p className={cn('mt-1 text-xs', data.slEnforcement.ok ? 'text-emerald-400' : 'text-amber-400')}>
          SL execution: {data.slEnforcement.ok ? 'enforced' : 'NOT enforced'} — {data.slEnforcement.detail}
        </p>
      </div>

      <section>
        <h2 className={cn('mb-2 text-sm font-semibold', PRIMARY)}>Open signal trades</h2>
        {open.length === 0 ? (
          <p className={cn('text-sm', MUTED)}>No open signal trades.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {open.map((o) => (
              <div key={o.id} className={CARD} data-testid="signal-open-trade">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge label={o.status} variant={o.status === 'UNCERTAIN' ? 'danger' : 'info'} size="sm" />
                  <span className={cn('text-sm font-medium', PRIMARY)}>
                    {o.side} {o.tradingsymbol} x{o.qty}
                  </span>
                </div>
                <p className={cn('mt-1 text-xs', SECONDARY)}>
                  {o.fillPrice !== null ? `filled ${o.fillPrice}` : `limit ${o.limitPrice}`} · SL {o.sl}
                  {o.lastLtp !== null ? ` · LTP ${o.lastLtp}` : ''}
                  {o.pnl !== null ? ` · P&L ${inr(o.pnl)}` : ''}
                </p>
                {o.statusReason && <p className={cn('mt-1 text-xs', MUTED)}>{o.statusReason}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className={cn('mb-2 text-sm font-semibold', PRIMARY)}>Today's signals</h2>
        {data.decisions.length === 0 ? (
          <p className={cn('text-sm', MUTED)}>No signals evaluated today.</p>
        ) : (
          <div className="space-y-2">
            {data.decisions.map((d) => (
              <DecisionCard key={d.id} d={d} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className={cn('mb-2 text-sm font-semibold', PRIMARY)}>Channels</h2>
        {data.channels.length === 0 ? (
          <p className={cn('text-sm', MUTED)}>No per-channel stats yet (the nightly self-review publishes them).</p>
        ) : (
          <ul className="space-y-1">
            {data.channels.map((c) => (
              <li key={c.id} className="flex flex-wrap justify-between gap-2 text-sm">
                <span className={PRIMARY}>{c.title}</span>
                <span className={MUTED}>{channelStatsLine(c.stats)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
