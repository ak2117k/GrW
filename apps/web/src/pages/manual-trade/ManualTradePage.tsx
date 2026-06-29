import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, Power, X, Inbox, ChevronRight } from 'lucide-react';
import OrderTicket from '@/components/trading/OrderTicket';
import {
  useTradeStore,
  tradesToPositions,
  overlayLivePrices,
  deriveCapitalDeployed,
} from '@/stores/trade-store';
import { wsService } from '@/services/websocket';
import api from '@/services/api';
import { getTradeEvents } from '@/services/tradeEvents.service';
import { cn } from '@/utils/cn';
import { TradeStatus, type Position, type Trade, type Quote } from '@/types';
import type { TradeEvent } from '@/types/tradeEvent.types';
import { TradeEventLog } from './TradeEventLog';

// ---- formatting helpers (mirrors PositionsPage conventions) ----
function formatINR(amount: number, opts?: { withSign?: boolean }): string {
  const formatted = amount.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  });
  if (opts?.withSign && amount > 0) return `+${formatted}`;
  return formatted;
}

function formatPrice(value: number): string {
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatTime(value: Date | string | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// ---- Risk strip ----
function RiskMetric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'bad' | 'neutral';
}) {
  const valueColor =
    tone === 'good'
      ? 'text-emerald-400'
      : tone === 'bad'
        ? 'text-red-400'
        : 'text-[var(--color-text-primary)]';
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </span>
      <span className={cn('text-lg font-bold leading-tight', valueColor)}>
        {value}
      </span>
      {sub && (
        <span className="text-[11px] text-[var(--color-text-muted)]">{sub}</span>
      )}
    </div>
  );
}

function RiskStrip({
  onKillSwitch,
  killSwitchActive,
  capitalDeployed,
  positionsCount,
}: {
  onKillSwitch: () => void;
  killSwitchActive: boolean;
  // Derived from the MANUAL open trades (single source = DB), NOT the
  // in-memory position-manager that diverged and only counted one trade.
  capitalDeployed: number;
  positionsCount: number;
}) {
  // Limits (capitalLimit / dailyLossLimit / positionsLimit) still come from
  // /trades/risk-status — only the *used* values are derived from the page's
  // MANUAL open trades so the strip matches the panel + order book below.
  const riskStatus = useTradeStore((s) => s.riskStatus);

  const capitalPct =
    riskStatus.capitalLimit > 0
      ? (capitalDeployed / riskStatus.capitalLimit) * 100
      : 0;
  // Daily P&L: positive loss-used means a loss; expose it as a signed P&L.
  const dailyPnl = -(riskStatus.dailyLossUsed ?? 0);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <RiskMetric
          label="Capital Deployed"
          value={formatINR(capitalDeployed ?? 0)}
          sub={`${capitalPct.toFixed(0)}% of ${formatINR(riskStatus.capitalLimit ?? 0)}`}
          tone={capitalPct >= 90 ? 'bad' : 'neutral'}
        />
        <RiskMetric
          label="Daily P&L"
          value={formatINR(dailyPnl, { withSign: true })}
          sub={`Limit ${formatINR(riskStatus.dailyLossLimit ?? 0)}`}
          tone={dailyPnl > 0 ? 'good' : dailyPnl < 0 ? 'bad' : 'neutral'}
        />
        <RiskMetric
          label="Positions"
          value={`${positionsCount} / ${riskStatus.positionsLimit ?? 0}`}
          sub="used / limit"
          tone={
            (riskStatus.positionsLimit ?? 0) > 0 &&
            positionsCount >= (riskStatus.positionsLimit ?? 0)
              ? 'bad'
              : 'neutral'
          }
        />
      </div>

      <button
        onClick={onKillSwitch}
        disabled={killSwitchActive}
        className={cn(
          'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all',
          killSwitchActive
            ? 'cursor-not-allowed bg-red-500/10 text-red-400/50'
            : 'bg-red-500/15 text-red-400 hover:bg-red-500/25',
        )}
      >
        <Power size={16} />
        {killSwitchActive ? 'Squaring off…' : 'Kill Switch'}
      </button>
    </div>
  );
}

// ---- Positions panel ----
function PositionsPanel({
  positions,
  onExit,
}: {
  positions: Position[];
  onExit: (symbol: string) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-3">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
          Open Positions
        </h2>
        {positions.length > 0 && (
          <span className="text-xs text-[var(--color-text-muted)]">
            {positions.length} open
          </span>
        )}
      </div>

      {positions.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-[var(--color-text-muted)]">
          <Inbox size={28} />
          <span className="text-sm">No open positions</span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[var(--color-border-subtle)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                <th className="px-4 py-2 font-medium">Symbol</th>
                <th className="px-4 py-2 font-medium">Side</th>
                <th className="px-4 py-2 font-medium text-right">Qty</th>
                <th className="px-4 py-2 font-medium text-right">Entry</th>
                <th className="px-4 py-2 font-medium text-right">LTP</th>
                <th className="px-4 py-2 font-medium text-right">P&amp;L</th>
                <th className="px-4 py-2 font-medium text-right" />
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const isProfit = p.pnl >= 0;
                return (
                  <tr
                    key={p.symbol}
                    className="border-b border-[var(--color-border-subtle)]/60 last:border-0 hover:bg-white/5"
                  >
                    <td className="px-4 py-2.5 text-sm font-medium text-[var(--color-text-primary)]">
                      {p.symbol}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                          p.side === 'BUY'
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'bg-red-500/15 text-red-400',
                        )}
                      >
                        {p.side}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-sm text-[var(--color-text-secondary)]">
                      {p.quantity}
                    </td>
                    <td className="px-4 py-2.5 text-right text-sm text-[var(--color-text-secondary)]">
                      {formatPrice(p.averagePrice)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-sm text-[var(--color-text-secondary)]">
                      {formatPrice(p.ltp)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div
                        className={cn(
                          'text-sm font-semibold',
                          isProfit ? 'text-emerald-400' : 'text-red-400',
                        )}
                      >
                        {formatINR(p.pnl, { withSign: true })}
                      </div>
                      <div
                        className={cn(
                          'text-[11px]',
                          isProfit ? 'text-emerald-400/70' : 'text-red-400/70',
                        )}
                      >
                        {p.pnlPercent >= 0 ? '+' : ''}
                        {p.pnlPercent.toFixed(2)}%
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => onExit(p.symbol)}
                        className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-2.5 py-1 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/25"
                      >
                        <X size={12} />
                        Exit
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Order book ----
function statusTone(status: TradeStatus | string): string {
  switch (status) {
    case TradeStatus.OPEN:
    case TradeStatus.FILLED:
    case TradeStatus.PARTIALLY_FILLED:
      return 'bg-blue-500/15 text-blue-400';
    case TradeStatus.CLOSED:
      return 'bg-gray-500/15 text-gray-300';
    case TradeStatus.REJECTED:
    case TradeStatus.CANCELLED:
      return 'bg-red-500/15 text-red-400';
    case TradeStatus.PENDING:
      return 'bg-amber-500/15 text-amber-400';
    default:
      return 'bg-gray-500/15 text-gray-300';
  }
}

// One order-book row + its lazily-loaded lifecycle event log. The events are
// fetched only when the row is first expanded, then cached for the row's
// lifetime so re-expanding is instant.
function OrderRow({
  trade,
  expanded,
  onToggle,
}: {
  trade: Trade;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [events, setEvents] = useState<TradeEvent[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Lazy fetch on first expand. A 404 (backend not ready) or any failure
  // resolves to an empty log rather than crashing the row.
  useEffect(() => {
    if (!expanded || events !== null || loading) return;
    let cancelled = false;
    setLoading(true);
    getTradeEvents(trade.id)
      .then((data) => {
        if (!cancelled) setEvents(data);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, events, loading, trade.id]);

  return (
    <Fragment>
      <tr
        onClick={onToggle}
        className={cn(
          'cursor-pointer border-b border-[var(--color-border-subtle)]/60 last:border-0 hover:bg-white/5',
          expanded && 'bg-white/5',
        )}
      >
        <td className="px-4 py-2.5 text-sm font-medium text-[var(--color-text-primary)]">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide event log' : 'Show event log'}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="mr-2 inline-flex align-middle text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <ChevronRight
              size={14}
              className={cn('transition-transform', expanded && 'rotate-90')}
            />
          </button>
          {trade.symbol}
        </td>
        <td className="px-4 py-2.5">
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-semibold',
              trade.side === 'BUY'
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-red-500/15 text-red-400',
            )}
          >
            {trade.side}
          </span>
        </td>
        <td className="px-4 py-2.5 text-right text-sm text-[var(--color-text-secondary)]">
          {trade.quantity}
        </td>
        <td className="px-4 py-2.5 text-right text-sm text-[var(--color-text-secondary)]">
          {formatPrice(trade.entryPrice ?? 0)}
        </td>
        <td className="px-4 py-2.5">
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-semibold',
              statusTone(trade.status),
            )}
          >
            {trade.status}
          </span>
        </td>
        <td className="px-4 py-2.5 text-right text-xs text-[var(--color-text-muted)]">
          {formatTime(trade.createdAt)}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-[var(--color-border-subtle)]/60 last:border-0">
          <td
            colSpan={6}
            className="bg-[var(--color-bg-tertiary)]/40 px-4 py-3"
          >
            <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              Event log
            </div>
            {events === null ? (
              <div className="text-xs text-[var(--color-text-muted)]">
                Loading events…
              </div>
            ) : (
              <TradeEventLog events={events} />
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function OrderBookTable({ trades }: { trades: Trade[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (trades.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-[var(--color-text-muted)]">
        <Inbox size={28} />
        <span className="text-sm">No orders</span>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-[var(--color-border-subtle)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
            <th className="px-4 py-2 font-medium">Symbol</th>
            <th className="px-4 py-2 font-medium">Side</th>
            <th className="px-4 py-2 font-medium text-right">Qty</th>
            <th className="px-4 py-2 font-medium text-right">Price</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium text-right">Time</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <OrderRow
              key={t.id}
              trade={t}
              expanded={t.id === expandedId}
              onToggle={() =>
                setExpandedId((cur) => (cur === t.id ? null : t.id))
              }
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Pending orders ----
// The pending-orders contract carries fields the shared `Trade` type does not
// expose (resting limit/trigger prices, the nested instrument). Model it
// locally rather than widening the shared type for a single page.
interface PendingOrder {
  id: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType: 'LIMIT' | 'STOPLOSS' | 'STOPLOSS_MARKET';
  limitPrice: number | null;
  triggerPrice: number | null;
  target?: number | null;
  status: string;
  createdAt: string;
  source: string;
  isPaperTrade: boolean;
  instrument: { symbol: string; token: string; exchange: string };
}

/** The price the order is resting at (limit for LIMIT, trigger otherwise). */
function restingPrice(o: PendingOrder): { label: string; value: number | null } {
  if (o.orderType === 'LIMIT') return { label: 'Limit', value: o.limitPrice };
  return { label: 'Trigger', value: o.triggerPrice };
}

function formatAge(value: string): string {
  const created = new Date(value).getTime();
  if (Number.isNaN(created)) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - created) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d`;
}

function PendingOrdersTable({
  orders,
  ltpBySymbol,
  quoteByToken,
  onCancel,
  cancellingId,
  error,
}: {
  orders: PendingOrder[];
  ltpBySymbol: Record<string, number>;
  quoteByToken: Record<string, number>;
  onCancel: (id: string) => void;
  cancellingId: string | null;
  error: string | null;
}) {
  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-[var(--color-text-muted)]">
        <Inbox size={28} />
        <span className="text-sm">No pending orders</span>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      {error && (
        <div className="px-4 py-2 text-xs text-red-400">{error}</div>
      )}
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-[var(--color-border-subtle)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
            <th className="px-4 py-2 font-medium">Symbol</th>
            <th className="px-4 py-2 font-medium">Side</th>
            <th className="px-4 py-2 font-medium text-right">Qty</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium text-right">Resting</th>
            <th className="px-4 py-2 font-medium text-right">LTP</th>
            <th className="px-4 py-2 font-medium text-right">Age</th>
            <th className="px-4 py-2 font-medium text-right" />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const symbol = o.instrument?.symbol ?? '';
            const token = o.instrument?.token ?? '';
            const { label, value: resting } = restingPrice(o);
            // Prefer a live tick (freshest); fall back to the fetched per-token
            // quote so the column still shows a price when the feed is quiet.
            const ltp = ltpBySymbol[symbol] ?? quoteByToken[token];
            const hasLtp = typeof ltp === 'number';
            const distPct =
              hasLtp && typeof resting === 'number' && resting > 0
                ? ((resting - ltp) / ltp) * 100
                : null;
            const cancelling = cancellingId === o.id;
            return (
              <tr
                key={o.id}
                className="border-b border-[var(--color-border-subtle)]/60 last:border-0 hover:bg-white/5"
              >
                <td className="px-4 py-2.5 text-sm font-medium text-[var(--color-text-primary)]">
                  {symbol}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                      o.side === 'BUY'
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-red-500/15 text-red-400',
                    )}
                  >
                    {o.side}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right text-sm text-[var(--color-text-secondary)]">
                  {o.quantity}
                </td>
                <td className="px-4 py-2.5 text-xs text-[var(--color-text-muted)]">
                  {o.orderType}
                </td>
                <td className="px-4 py-2.5 text-right text-sm text-[var(--color-text-secondary)]">
                  {typeof resting === 'number'
                    ? `${label} ₹${formatPrice(resting)}`
                    : '—'}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {hasLtp ? (
                    <>
                      <div className="text-sm text-[var(--color-text-secondary)]">
                        {formatPrice(ltp)}
                      </div>
                      {distPct !== null && (
                        <div className="text-[11px] text-[var(--color-text-muted)]">
                          {distPct >= 0 ? '+' : ''}
                          {distPct.toFixed(2)}% to fill
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-sm text-[var(--color-text-muted)]">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right text-xs text-[var(--color-text-muted)]">
                  {formatAge(o.createdAt)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => onCancel(o.id)}
                    disabled={cancelling}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
                      cancelling
                        ? 'cursor-not-allowed bg-red-500/10 text-red-400/50'
                        : 'bg-red-500/15 text-red-400 hover:bg-red-500/25',
                    )}
                  >
                    <X size={12} />
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OrderBook({
  openTrades,
  ltpBySymbol,
  onPendingChange,
}: {
  openTrades: Trade[];
  ltpBySymbol: Record<string, number>;
  // Refetch the open trades when a pending order is cancelled/filled, since
  // a fill moves an order from PENDING into the open book.
  onPendingChange: () => void;
}) {
  const [tab, setTab] = useState<'open' | 'recent' | 'pending'>('open');
  const [recent, setRecent] = useState<Trade[]>([]);
  const [pending, setPending] = useState<PendingOrder[]>([]);
  // Fetched last/live quote per token for the LTP column — covers symbols that
  // aren't on the tick WS feed (e.g. after hours). Live ticks still take
  // precedence over this when available.
  const [quoteByToken, setQuoteByToken] = useState<Record<string, number>>({});
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get<Trade[]>('/trades?limit=20');
        if (!cancelled) setRecent(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setRecent([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchPending = useCallback(async () => {
    try {
      const { data } = await api.get<PendingOrder[]>('/trades/pending', {
        params: { source: 'MANUAL' },
      });
      setPending(Array.isArray(data) ? data : []);
    } catch {
      // Keep the last-good list on a transient error. Clearing to [] here would
      // flash the table empty AND reset pendingTokensKey, aborting the in-flight
      // LTP-quote effect mid-fetch. The list updates only on real data changes.
    }
  }, []);

  // Stable key for the set of pending tokens — changes only when an order is
  // added/cancelled, NOT on every 5s poll. Drives the LTP fetch below.
  const pendingTokensKey = pending
    .map((o) => o.instrument?.token)
    .filter((t): t is string => Boolean(t))
    .sort()
    .join(',');

  // Seed the LTP column for resting orders. The tick WS only carries subscribed
  // symbols, so pending tokens are usually absent — fetch the per-token quote
  // endpoint (falls back to prevClose / level-book when the feed is quiet).
  // Runs only when the token SET changes, and MERGES results so a transient
  // failure never wipes already-known prices. Live WS ticks still override this.
  useEffect(() => {
    if (!pendingTokensKey) return;
    let cancelled = false;
    const tokens = pendingTokensKey.split(',');
    (async () => {
      const results = await Promise.all(
        tokens.map(async (token) => {
          try {
            const { data: q } = await api.get<{ quote: { ltp?: number } | null }>(
              `/market-data/instruments/${token}/quote`,
            );
            const ltp = q?.quote?.ltp;
            return typeof ltp === 'number' && ltp > 0 ? ([token, ltp] as const) : null;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const good = results.filter((x): x is readonly [string, number] => x !== null);
      if (good.length) {
        setQuoteByToken((prev) => ({ ...prev, ...Object.fromEntries(good) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingTokensKey]);

  // Initial load + 5s poll, mirroring the page's open-trades poll.
  useEffect(() => {
    fetchPending();
    const id = setInterval(fetchPending, 5000);
    return () => clearInterval(id);
  }, [fetchPending]);

  const handleCancel = useCallback(
    async (id: string) => {
      setCancellingId(id);
      setPendingError(null);
      try {
        await api.post(`/trades/${id}/cancel`);
        // A fill/cancel changes both the pending list and the open book.
        await fetchPending();
        onPendingChange();
      } catch (err) {
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response
            ?.data?.message ?? 'Failed to cancel order';
        setPendingError(msg);
      } finally {
        setCancellingId(null);
      }
    },
    [fetchPending, onPendingChange],
  );

  const tabs: Array<{ key: 'open' | 'recent' | 'pending'; label: string }> = [
    { key: 'open', label: `Open (${openTrades.length})` },
    { key: 'pending', label: `Pending (${pending.length})` },
    { key: 'recent', label: 'Recent' },
  ];

  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div className="flex items-center gap-1 border-b border-[var(--color-border-subtle)] px-3 py-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
              tab === t.key
                ? 'bg-[var(--color-accent-blue)]/15 text-[var(--color-accent-blue)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'pending' ? (
        <PendingOrdersTable
          orders={pending}
          ltpBySymbol={ltpBySymbol}
          quoteByToken={quoteByToken}
          onCancel={handleCancel}
          cancellingId={cancellingId}
          error={pendingError}
        />
      ) : (
        <OrderBookTable trades={tab === 'open' ? openTrades : recent} />
      )}
    </div>
  );
}

// ---- Page ----
export default function ManualTradePage() {
  const openTrades = useTradeStore((s) => s.openTrades);
  const isKillSwitchActive = useTradeStore((s) => s.isKillSwitchActive);
  const fetchOpenTrades = useTradeStore((s) => s.fetchOpenTrades);
  const fetchRiskStatus = useTradeStore((s) => s.fetchRiskStatus);
  const closeTrade = useTradeStore((s) => s.closeTrade);
  const closeAllPositions = useTradeStore((s) => s.closeAllPositions);

  // Live LTP overlay by symbol. Fed by the tick WS; merged onto the derived
  // positions for live P&L without round-tripping through the position-manager
  // store (which is no longer this page's source of truth).
  const [ltpBySymbol, setLtpBySymbol] = useState<Record<string, number>>({});
  // Fetched per-token quote, keyed by symbol — the fallback price source for
  // held positions. Held symbols are NOT on the tick WS feed (the feed only
  // carries subscribed/scanning tokens), so without this the overlay above
  // would never fire and P&L would sit pinned at 0. Live ticks still take
  // precedence over these when they do arrive. Mirrors the Pending tab.
  const [quoteBySymbol, setQuoteBySymbol] = useState<Record<string, number>>({});

  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Single source of truth for the whole page: the MANUAL open trades.
  // The top PositionsPanel, the Capital Deployed / Positions metrics, and the
  // bottom Order Book all derive from this list, so they cannot diverge.
  const positions = useMemo<Position[]>(() => {
    const base = tradesToPositions(openTrades as Trade[]);
    // Merge price sources: live WS ticks override fetched quotes (fresher),
    // but a fetched quote still marks a position no tick has reached.
    const priceBySymbol = { ...quoteBySymbol, ...ltpBySymbol };
    return overlayLivePrices(base, priceBySymbol);
  }, [openTrades, ltpBySymbol, quoteBySymbol]);

  const capitalDeployed = useMemo(
    () => deriveCapitalDeployed(openTrades as Trade[]),
    [openTrades],
  );
  const positionsCount = openTrades.length;

  const refetchAll = useCallback(() => {
    fetchOpenTrades('MANUAL');
    fetchRiskStatus();
  }, [fetchOpenTrades, fetchRiskStatus]);

  // Initial load + 5s poll fallback (refetch the MANUAL open trades).
  useEffect(() => {
    refetchAll();
    pollRef.current = setInterval(() => {
      fetchOpenTrades('MANUAL');
    }, 5000);
    return () => {
      clearInterval(pollRef.current);
    };
  }, [refetchAll, fetchOpenTrades]);

  // Live LTP/P&L: capture each tick that matches a held symbol into the local
  // overlay. The `positions` memo recomputes P&L from it. We deliberately do
  // NOT write back to the position-manager store here — this page derives its
  // positions from openTrades, not /trades/positions.
  useEffect(() => {
    const unsubTick = wsService.subscribe('tick', (data) => {
      const q = data as Quote;
      if (!q?.symbol || typeof q.ltp !== 'number') return;
      setLtpBySymbol((prev) =>
        prev[q.symbol] === q.ltp ? prev : { ...prev, [q.symbol]: q.ltp },
      );
    });
    return () => {
      unsubTick();
    };
  }, []);

  // Stable key for the held (token,symbol) set — changes only when a position
  // is opened/closed, NOT on every 5s open-trades refetch. Drives the quote
  // poll below. Token comes from the raw `/trades/open` row's instrument.
  const heldKey = useMemo(() => {
    const rows = openTrades as Array<
      Trade & { token?: string; instrument?: { token?: string } }
    >;
    return rows
      .map((t) => `${t.instrument?.token ?? t.token ?? ''}:${t.symbol}`)
      .filter((s) => !s.startsWith(':'))
      .sort()
      .join(',');
  }, [openTrades]);

  // Quote fallback for held positions. The tick WS only carries subscribed
  // symbols, so held tokens are usually absent — poll the per-token quote
  // endpoint (falls back to prevClose / level-book when the feed is quiet) so
  // P&L marks even with no live tick. Live ticks still override this at render.
  // Re-arms only when the held SET changes; polls every 5s while mounted.
  useEffect(() => {
    if (!heldKey) return;
    let cancelled = false;
    const pairs = heldKey.split(',').map((s) => {
      const idx = s.indexOf(':');
      return { token: s.slice(0, idx), symbol: s.slice(idx + 1) };
    });
    const fetchQuotes = async () => {
      const results = await Promise.all(
        pairs.map(async ({ token, symbol }) => {
          try {
            const { data: q } = await api.get<{ quote: { ltp?: number } | null }>(
              `/market-data/instruments/${token}/quote`,
            );
            const ltp = q?.quote?.ltp;
            return typeof ltp === 'number' && ltp > 0
              ? ([symbol, ltp] as const)
              : null;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const good = results.filter(
        (x): x is readonly [string, number] => x !== null,
      );
      if (good.length) {
        setQuoteBySymbol((prev) => ({ ...prev, ...Object.fromEntries(good) }));
      }
    };
    fetchQuotes();
    const id = setInterval(fetchQuotes, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [heldKey]);

  const handleKillSwitch = useCallback(() => {
    if (
      window.confirm(
        'Kill switch will immediately square off ALL open positions. Continue?',
      )
    ) {
      closeAllPositions();
    }
  }, [closeAllPositions]);

  // Position has no trade id — match by symbol against openTrades (same
  // mapping PositionsPage uses) to resolve the closable trade id.
  const handleExit = useCallback(
    (symbol: string) => {
      const trade = openTrades.find((t) => t.symbol === symbol);
      if (trade) {
        closeTrade(trade.id);
      } else {
        // No open trade row to map; still refetch so the panel reconciles.
        refetchAll();
      }
    },
    [openTrades, closeTrade, refetchAll],
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Send size={24} className="text-[var(--color-accent-blue)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
          Manual Trade
        </h1>
      </div>

      {/* Risk strip */}
      <RiskStrip
        onKillSwitch={handleKillSwitch}
        killSwitchActive={isKillSwitchActive}
        capitalDeployed={capitalDeployed}
        positionsCount={positionsCount}
      />

      {/* Two-column workspace */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(320px,420px)_1fr]">
        {/* Left: order ticket */}
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
          <OrderTicket variant="panel" onSubmitted={refetchAll} />
        </div>

        {/* Right: positions + order book */}
        <div className="space-y-5">
          <PositionsPanel positions={positions} onExit={handleExit} />
          <OrderBook
            openTrades={openTrades}
            ltpBySymbol={ltpBySymbol}
            onPendingChange={refetchAll}
          />
        </div>
      </div>
    </div>
  );
}
