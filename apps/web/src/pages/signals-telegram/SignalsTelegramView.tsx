import { Badge } from '@/components/common';
import { cn } from '@/utils/cn';
import {
  channelStatsLine,
  decisionWhy,
  fundsLine,
  modeBadge,
  outcomeLine,
  paperState,
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
  const paper = d.decision === 'PAPER';
  return (
    <div className={CARD} data-testid="signal-decision">
      <div className="flex flex-wrap items-center gap-2">
        <Badge label={d.decision ?? d.status} variant={take ? 'success' : paper ? 'warning' : d.decision === 'SKIP' ? 'neutral' : 'info'} size="sm" />
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
        {(d.decision === 'SKIP' || paper) && <span className="font-medium text-amber-400">{skipLabel(d.skipReason)}: </span>}
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

const TONE = { good: 'text-emerald-400', bad: 'text-red-400', neutral: SECONDARY } as const;

/** Owner toggle: a TAKE the account cannot fund becomes a paper trade (on) or a plain skip (off). */
function PaperToggle({ data, onToggle, busy }: { data: SignalOverview; onToggle?: (enabled: boolean) => void; busy?: boolean }) {
  const s = data.paperOnNoFunds;
  if (!s) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="paper-toggle">
      <span className={cn('text-xs', SECONDARY)}>
        Not enough funds → <span className={cn('font-semibold', PRIMARY)}>{s.enabled ? 'paper trade' : 'skip'}</span>
      </span>
      {onToggle && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggle(!s.enabled)}
          className="inline-flex min-h-10 items-center rounded border border-[var(--color-border-default)] px-3 text-xs text-[var(--color-text-secondary)] disabled:opacity-50"
          aria-pressed={s.enabled}
        >
          {s.enabled ? 'Turn off (skip instead)' : 'Turn on (paper trade)'}
        </button>
      )}
    </div>
  );
}

function PaperSection({ paper }: { paper: NonNullable<SignalOverview['paper']> }) {
  return (
    <section data-testid="paper-section">
      <h2 className={cn('mb-2 text-sm font-semibold', PRIMARY)}>Paper (no funds)</h2>
      <div className={CARD}>
        <p className={cn('text-xs', MUTED)}>Last {paper.lookbackDays} days — signals taken on paper because the account lacked funds, next to the live ones.</p>
        <p className={cn('mt-1 text-sm', SECONDARY)} data-testid="paper-summary">
          Paper: <span className={TONE[paper.summary.pnl > 0 ? 'good' : paper.summary.pnl < 0 ? 'bad' : 'neutral']}>{outcomeLine(paper.summary)}</span>
        </p>
        <p className={cn('text-sm', SECONDARY)} data-testid="live-summary">
          Live: <span className={TONE[paper.live.pnl > 0 ? 'good' : paper.live.pnl < 0 ? 'bad' : 'neutral']}>{outcomeLine(paper.live)}</span>
        </p>
      </div>
      {paper.rows.length > 0 && (
        <ul className="mt-2 space-y-2">
          {paper.rows.map((r) => {
            const st = paperState(r);
            return (
              <li key={r.decisionId} className={CARD} data-testid="paper-row">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge label="PAPER" variant="warning" size="sm" />
                  <span className={cn('text-sm font-medium', PRIMARY)}>
                    {r.plan?.side} {r.plan?.tradingsymbol ?? r.underlying ?? '—'} x{r.plan?.qty ?? '?'}
                  </span>
                  <span className={cn('text-xs', MUTED)}>{r.channel ?? 'unknown channel'}</span>
                  <span className={cn('ml-auto text-xs', TONE[st.tone])}>{st.label}</span>
                </div>
                <p className={cn('mt-1 text-xs', MUTED)}>
                  entry {r.plan?.limitPrice ?? '?'} · SL {r.plan?.sl ?? '?'}
                  {r.plan?.targets?.length ? ` · T ${r.plan.targets.join('/')}` : ''}
                  {r.funds ? ` · ${fundsLine(r.funds)}` : ''}
                  {r.trigger === 'broker_reject' ? ' · broker rejected for funds' : ''}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function SignalsTelegramView({ data, onTogglePaper, toggleBusy }: { data: SignalOverview; onTogglePaper?: (enabled: boolean) => void; toggleBusy?: boolean }) {
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
        <PaperToggle data={data} onToggle={onTogglePaper} busy={toggleBusy} />
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

      {data.paper && <PaperSection paper={data.paper} />}

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
