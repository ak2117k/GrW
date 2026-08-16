import { useEffect, useRef, useState } from 'react';
import { PieChart, RefreshCw, Download, ChevronDown, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useBrokerOverview } from '@/hooks/useBrokerOverview';
import { useBrokerTrades, type BrokerTrade } from '@/hooks/useBrokerTrades';
import { useTradeTrackers, type TradeTracker } from '@/hooks/useTradeTrackers';
import { useSoldTrades, type SoldTrade } from '@/hooks/useSoldTrades';
import { formatMoney } from '@/hooks/formatMoney';
import { exportTrackersXlsx, exportTrackersPdf } from '@/utils/exportTrackers';
import { exportOhlcXlsx, exportOhlcPdf, type DailyOhlc } from '@/utils/exportOhlc';
import api from '@/services/api';
import { LoadingSkeleton } from '@/components/common';
import { SymbolChartLink } from '@/components/common/SymbolChartLink';
import { isDerivative } from '@/utils/positionRow';

/** How often to re-pull Angel One's live holdings/positions during market hours. */
const AUTO_REFRESH_MS = 20_000;

/** True during NSE cash hours (Mon–Fri, 09:15–15:30 IST). Off-hours we don't
 *  auto-poll — each pull is a broker login, and prices don't move anyway. */
function isMarketHoursIST(): boolean {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

/** Tailwind text color for a signed P&L value. */
function pnlColor(v: number): string {
  if (v > 0) return 'text-[var(--color-accent-green)]';
  if (v < 0) return 'text-[var(--color-accent-red)]';
  return 'text-[var(--color-text-secondary)]';
}

/** "+7.14%" / "-3.20%" / "0.00%" */
function fmtPct(v: number | null | undefined): string {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function SummaryTile({
  label,
  value,
  pct,
  pnl = false,
}: {
  label: string;
  value: number | null | undefined;
  pct?: number | null;
  pnl?: boolean;
}) {
  const v = typeof value === 'number' ? value : 0;
  return (
    <div className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        {label}
      </div>
      <div
        className={`mt-1 text-xl font-bold tabular-nums ${
          pnl ? pnlColor(v) : 'text-[var(--color-text-primary)]'
        }`}
      >
        {formatMoney(v)}
      </div>
      {pnl && pct != null && (
        <div className={`text-xs tabular-nums ${pnlColor(v)}`}>{fmtPct(pct)}</div>
      )}
    </div>
  );
}

const TH = 'py-2 px-3 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]';
const THR = `${TH} text-right`;
const TD = 'py-1.5 px-3 tabular-nums text-[var(--color-text-secondary)]';
const TDR = `${TD} text-right`;

/** Nullable rupee amount — em-dash when unset (formatMoney would show ₹0). */
function money(v: number | null | undefined): string {
  return v == null ? '—' : formatMoney(v);
}

/** ISO → "DD MMM, HH:mm" (local), or em-dash when null. */
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Angel One's raw filltime string → a trimmed display string, or em-dash when
 * absent. The broker sends an already-formatted string (e.g. "13:37:57" or a
 * full datetime) and an empty string when it omits the time — we render it
 * verbatim rather than re-parsing, since the format is broker-defined.
 */
export function fmtFillTime(time: string | null | undefined): string {
  const t = typeof time === 'string' ? time.trim() : '';
  return t === '' ? '—' : t;
}

/** Tailwind text color for a trade side — BUY green, SELL red, else muted. */
function sideColor(side: string): string {
  const s = side.toUpperCase();
  if (s === 'BUY') return 'text-[var(--color-accent-green)]';
  if (s === 'SELL') return 'text-[var(--color-accent-red)]';
  return 'text-[var(--color-text-secondary)]';
}

/** A pill distinguishing OPEN (green) from CLOSED (muted). */
/** Holding classification badge. Always shows a visible label (Normal / MTF /
 *  Pledged); an unknown/missing value falls back to Normal. */
function HoldingTypeBadge({ type }: { type?: 'NORMAL' | 'MTF' | 'PLEDGED' | null }) {
  const t = type === 'MTF' || type === 'PLEDGED' ? type : 'NORMAL';
  const cls =
    t === 'PLEDGED'
      ? 'bg-[var(--color-accent-yellow)]/15 text-[var(--color-accent-yellow)]'
      : t === 'MTF'
        ? 'bg-[var(--color-accent-purple)]/15 text-[var(--color-accent-purple)]'
        : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]';
  const label = t === 'NORMAL' ? 'Normal' : t;
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: TradeTracker['status'] }) {
  const open = status === 'OPEN';
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        open
          ? 'bg-[var(--color-accent-green)]/15 text-[var(--color-accent-green)]'
          : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]'
      }`}
    >
      {status}
    </span>
  );
}

/**
 * Trade Tracker — persistent per-position/holding tracker rows from the DB
 * (independent of the live broker snapshot above), with a client-side Excel/PDF
 * export of the loaded rows.
 */
function TradeTrackerSection({
  data,
  loading,
  error,
  notConnected,
}: {
  data: TradeTracker[] | null;
  loading: boolean;
  error: string | null;
  notConnected: boolean;
}) {
  const rows = data ?? [];
  const hasRows = rows.length > 0;

  return (
    <section className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2.5">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Trade Tracker</h2>
      </div>

      {loading && !data && <LoadingSkeleton variant="card" count={1} className="m-3 h-24" />}

      {notConnected && (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
          Connect your Angel One account on the Dashboard to start tracking trades.
        </p>
      )}

      {error && (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-accent-red)]">{error}</p>
      )}

      {!loading && !error && !notConnected && !hasRows && (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
          No tracked trades yet.
        </p>
      )}

      {hasRows && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border-subtle)]">
                <th className={TH}>Symbol</th>
                <th className={TH}>Exch</th>
                <th className={TH}>Kind</th>
                <th className={THR}>Entry</th>
                <th className={THR}>Qty</th>
                <th className={THR}>Exit</th>
                <th className={THR}>Exit Time</th>
                <th className={THR}>Holding H/L</th>
                <th className={THR}>Day H/L</th>
                <th className={THR}>P&amp;L</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-[var(--color-border-subtle)] last:border-0"
                >
                  <td className="px-3 py-1.5 font-medium text-[var(--color-text-primary)]">
                    {t.symbol}
                  </td>
                  <td className="px-3 py-1.5 text-[10px] text-[var(--color-text-muted)]">
                    {t.exchange}
                  </td>
                  <td className="px-3 py-1.5 text-[10px] text-[var(--color-text-muted)]">
                    {t.kind}
                  </td>
                  <td className={TDR}>{money(t.entryPrice)}</td>
                  <td className={TDR}>{t.qty}</td>
                  <td className={TDR}>{money(t.exitPrice)}</td>
                  <td className={TDR}>{fmtDateTime(t.exitTime)}</td>
                  <td className={TDR}>
                    {money(t.holdingHigh)} <span className="text-[var(--color-text-muted)]">/</span>{' '}
                    {money(t.holdingLow)}
                  </td>
                  <td className={TDR}>
                    {money(t.dayHigh)} <span className="text-[var(--color-text-muted)]">/</span>{' '}
                    {money(t.dayLow)}
                  </td>
                  <td className={`${TDR} ${pnlColor(t.pnl ?? 0)}`}>
                    {money(t.pnl)}
                    {t.pnlPercent != null && (
                      <span className="text-[10px]"> ({fmtPct(t.pnlPercent)})</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <StatusBadge status={t.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Trades (Angel One) — the connected account's executed trades for the day,
 * pulled live from the broker (independent of the DB-backed Trade Tracker
 * above). Read-only; mirrors the loading / notConnected / empty patterns used
 * across this page.
 */
function BrokerTradesSection({
  data,
  loading,
  error,
  notConnected,
}: {
  data: BrokerTrade[] | null;
  loading: boolean;
  error: string | null;
  notConnected: boolean;
}) {
  const rows = data ?? [];
  const hasRows = rows.length > 0;

  return (
    <section className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2.5">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Trades (Angel One)</h2>
      </div>

      {loading && !data && <LoadingSkeleton variant="card" count={1} className="m-3 h-24" />}

      {notConnected && (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
          Connect your Angel One account on the Dashboard to see your trades.
        </p>
      )}

      {error && (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-accent-red)]">{error}</p>
      )}

      {!loading && !error && !notConnected && !hasRows && (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
          No trades today.
        </p>
      )}

      {hasRows && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border-subtle)]">
                <th className={TH}>Symbol</th>
                <th className={TH}>Exch</th>
                <th className={TH}>Side</th>
                <th className={THR}>Qty</th>
                <th className={THR}>Price</th>
                <th className={THR}>Time</th>
                <th className={TH}>Product</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, i) => (
                <tr
                  key={`${t.orderId}-${i}`}
                  className="border-b border-[var(--color-border-subtle)] last:border-0"
                >
                  <td className="px-3 py-1.5 font-medium text-[var(--color-text-primary)]">
                    {t.symbol}
                  </td>
                  <td className="px-3 py-1.5 text-[10px] text-[var(--color-text-muted)]">
                    {t.exchange}
                  </td>
                  <td className={`px-3 py-1.5 font-semibold ${sideColor(t.side)}`}>{t.side}</td>
                  <td className={TDR}>{t.qty}</td>
                  <td className={TDR}>{formatMoney(t.price)}</td>
                  <td className={TDR}>{fmtFillTime(t.time)}</td>
                  <td className="px-3 py-1.5 text-[10px] text-[var(--color-text-muted)]">
                    {t.product}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Response shape of `GET /api/portfolio/sold/:id/ohlc`. */
interface OhlcResponse {
  symbol: string;
  ohlc: DailyOhlc[];
}

/**
 * A single Sold row with its own per-row **Download ▾** menu (Excel / PDF).
 * On download it fetches the trade's daily OHLC series on demand, then hands it
 * to the OHLC exporter. While that fetch is in flight the row shows an inline
 * spinner and disables its button; an empty series toasts instead of exporting.
 */
function SoldTradeRow({ t }: { t: SoldTrade }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const download = async (fmt: 'xlsx' | 'pdf') => {
    setMenuOpen(false);
    setBusy(true);
    try {
      const { data } = await api.get<OhlcResponse>(`/portfolio/sold/${t.id}/ohlc`);
      if (!data.ohlc || data.ohlc.length === 0) {
        toast.error(`No daily data for ${data.symbol || t.symbol}`);
        return;
      }
      if (fmt === 'xlsx') await exportOhlcXlsx(data.symbol, data.ohlc);
      else await exportOhlcPdf(data.symbol, data.ohlc);
    } catch {
      toast.error(`Could not load daily data for ${t.symbol}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-b border-[var(--color-border-subtle)] last:border-0">
      <td className="px-3 py-1.5 font-medium text-[var(--color-text-primary)]">{t.symbol}</td>
      <td className="px-3 py-1.5 text-[10px] text-[var(--color-text-muted)]">{t.exchange}</td>
      <td className="px-3 py-1.5 text-[10px] text-[var(--color-text-muted)]">{t.kind}</td>
      <td className={TDR}>{t.qty}</td>
      <td className={TDR}>{money(t.entryPrice)}</td>
      <td className={TDR}>{money(t.exitPrice)}</td>
      <td className={TDR}>{fmtDateTime(t.exitTime)}</td>
      <td className={`${TDR} ${pnlColor(t.pnl ?? 0)}`}>
        {money(t.pnl)}
        {t.pnlPercent != null && <span className="text-[10px]"> ({fmtPct(t.pnlPercent)})</span>}
      </td>
      <td className={TDR}>
        {money(t.holdingHigh)} <span className="text-[var(--color-text-muted)]">/</span>{' '}
        {money(t.holdingLow)}
      </td>
      <td className="px-3 py-1.5 text-right">
        <div className="relative inline-block text-left" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            Download
            <ChevronDown size={12} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 z-10 mt-1 w-36 overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-card)] shadow-lg">
              <button
                onClick={() => void download('xlsx')}
                className="block w-full px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)]"
              >
                Excel (.xlsx)
              </button>
              <button
                onClick={() => void download('pdf')}
                className="block w-full px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)]"
              >
                PDF
              </button>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * Sold — the caller's CLOSED trade-tracker rows (positions/holdings they've
 * sold), newest exit first. Per row the user can download that stock's daily
 * OHLC series (fetched on demand) as Excel/PDF for post-trade review. Mirrors
 * the loading / notConnected / empty patterns used across this page.
 */
function SoldTradesSection({
  data,
  loading,
  error,
  notConnected,
}: {
  data: SoldTrade[] | null;
  loading: boolean;
  error: string | null;
  notConnected: boolean;
}) {
  const rows = data ?? [];
  const hasRows = rows.length > 0;

  return (
    <section className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2.5">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Sold</h2>
      </div>

      {loading && !data && <LoadingSkeleton variant="card" count={1} className="m-3 h-24" />}

      {notConnected && (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
          Connect your Angel One account on the Dashboard to see your sold trades.
        </p>
      )}

      {error && (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-accent-red)]">{error}</p>
      )}

      {!loading && !error && !notConnected && !hasRows && (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
          No sold trades yet.
        </p>
      )}

      {hasRows && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border-subtle)]">
                <th className={TH}>Symbol</th>
                <th className={TH}>Exch</th>
                <th className={TH}>Kind</th>
                <th className={THR}>Qty</th>
                <th className={THR}>Entry</th>
                <th className={THR}>Exit</th>
                <th className={THR}>Exit Time</th>
                <th className={THR}>P&amp;L</th>
                <th className={THR}>Holding H/L</th>
                <th className={THR}>Download</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <SoldTradeRow key={t.id} t={t} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function PortfolioPage() {
  const { data, loading, error, notConnected, refresh } = useBrokerOverview();
  // Trade trackers lifted to the page so the Download button (top header) can
  // export ALL tracked-trade data. The hook backfills the book on load.
  const trackers = useTradeTrackers();
  const trackerRows = trackers.data ?? [];
  // The connected account's executed trades (live broker book). Loads on mount.
  const brokerTrades = useBrokerTrades();
  // The caller's sold trades (CLOSED trackers). Loads on mount + manual refresh.
  const sold = useSoldTrades();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Fetch overview on mount; the trade-tracker hook loads (+ backfills) itself.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-refresh Angel One's live holdings/positions during market hours so the
  // page tracks the broker instead of a frozen snapshot. Uses Angel One's own
  // LTP/P&L (no recompute) — just pulled continuously. Manual Refresh still works.
  useEffect(() => {
    const id = setInterval(() => {
      if (isMarketHoursIST()) void refresh();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Dismiss the download menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const download = (fn: (r: TradeTracker[]) => Promise<void>) => {
    setMenuOpen(false);
    void fn(trackerRows);
  };

  const refreshAll = () => {
    void refresh();
    void trackers.refresh();
    void brokerTrades.refresh();
    void sold.refresh();
  };

  const busy = loading || trackers.loading || brokerTrades.loading || sold.loading;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PieChart size={22} className="text-[var(--color-accent-blue)]" />
          <h1 className="text-xl font-bold text-[var(--color-text-primary)]">Portfolio</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Page-level export of ALL tracked-trade data. */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              disabled={trackerRows.length === 0}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
            >
              <Download size={13} />
              Download
              <ChevronDown size={13} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 z-10 mt-1 w-40 overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-card)] shadow-lg">
                <button
                  onClick={() => download(exportTrackersXlsx)}
                  className="block w-full px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)]"
                >
                  Excel (.xlsx)
                </button>
                <button
                  onClick={() => download(exportTrackersPdf)}
                  className="block w-full px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)]"
                >
                  PDF
                </button>
              </div>
            )}
          </div>
          <button
            onClick={refreshAll}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
          >
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {loading && !data && <LoadingSkeleton variant="card" count={1} className="h-32" />}

      {notConnected && (
        <div className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
          Connect your Angel One account on the{' '}
          <span className="font-medium text-[var(--color-text-primary)]">Dashboard</span> to see
          your holdings and positions.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red)]/10 p-4 text-sm text-[var(--color-accent-red)]">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Summary strip */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryTile label="Available Cash" value={data.funds?.availableCash} />
            <SummaryTile label="Invested" value={data.holdingSummary?.investedValue} />
            <SummaryTile label="Current Value" value={data.holdingSummary?.currentValue} />
            <SummaryTile
              label="Total P&L"
              value={data.holdingSummary?.totalPnl}
              pct={data.holdingSummary?.totalPnlPercent}
              pnl
            />
          </div>

          {/* Holdings */}
          <section className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)]">
            <h2 className="border-b border-[var(--color-border-subtle)] px-4 py-2.5 text-sm font-semibold text-[var(--color-text-primary)]">
              Holdings
            </h2>
            {data.holdings?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[var(--color-border-subtle)]">
                      <th className={TH}>Symbol</th>
                      <th className={TH}>Type</th>
                      <th className={THR}>Qty</th>
                      <th className={THR}>Avg Cost</th>
                      <th className={THR}>LTP</th>
                      <th className={THR}>Cur. Value</th>
                      <th className={THR}>P&amp;L</th>
                      <th className={THR}>Day %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.holdings.map((h, i) => (
                      <tr key={`${h.symbol}-${i}`} className="border-b border-[var(--color-border-subtle)] last:border-0">
                        {/* A holding is cash equity, so the thing held IS the
                            thing charted — one link, unlike a position. */}
                        <td className="px-3 py-1.5">
                          <SymbolChartLink
                            symbol={h.symbol}
                            token={h.token}
                            exchange={h.exchange}
                            className="font-medium text-[var(--color-text-primary)]"
                          />
                          <span className="ml-1.5 text-[10px] text-[var(--color-text-muted)]">{h.exchange}</span>
                        </td>
                        <td className="px-3 py-1.5"><HoldingTypeBadge type={h.holdingType} /></td>
                        <td className={TDR}>{h.qty}</td>
                        <td className={TDR}>{formatMoney(h.avgPrice)}</td>
                        <td className={TDR}>{formatMoney(h.ltp)}</td>
                        <td className={TDR}>{formatMoney(h.currentValue)}</td>
                        <td className={`${TDR} ${pnlColor(h.pnl)}`}>
                          {formatMoney(h.pnl)} <span className="text-[10px]">({fmtPct(h.pnlPercent)})</span>
                        </td>
                        <td className={`${TDR} ${pnlColor(h.dayChangePercent)}`}>{fmtPct(h.dayChangePercent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">No equity holdings.</p>
            )}
          </section>

          {/* Open positions */}
          <section className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)]">
            <h2 className="border-b border-[var(--color-border-subtle)] px-4 py-2.5 text-sm font-semibold text-[var(--color-text-primary)]">
              Open Positions
            </h2>
            {data.positions?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[var(--color-border-subtle)]">
                      <th className={TH}>Symbol</th>
                      <th className={THR}>Net Qty</th>
                      <th className={THR}>LTP</th>
                      <th className={THR}>P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.positions.map((p, i) => (
                      <tr key={`${p.symbol}-${i}`} className="border-b border-[var(--color-border-subtle)] last:border-0">
                        {/* Same split as the dashboard's positions table, and
                            deliberately identical: symbol → the underlying's
                            chart, P&L → the traded contract's own. Two tables
                            of the same data behaving differently is worse than
                            either behaviour on its own. */}
                        <td className="px-3 py-1.5">
                          <SymbolChartLink
                            symbol={p.underlyingSymbol || p.symbol}
                            token={p.underlyingToken}
                            exchange="NSE"
                            className="font-medium text-[var(--color-text-primary)]"
                          />
                          <span className="ml-1.5 text-[10px] text-[var(--color-text-muted)]">{p.exchange}</span>
                        </td>
                        <td className={TDR}>{p.netQty}</td>
                        <td className={TDR}>{formatMoney(p.ltp)}</td>
                        <td className={`${TDR} ${pnlColor(p.pnl)}`}>
                          {isDerivative(p) ? (
                            <SymbolChartLink
                              symbol={p.symbol}
                              token={p.token}
                              exchange={p.exchange}
                              label={formatMoney(p.pnl)}
                              className="justify-end"
                            />
                          ) : (
                            formatMoney(p.pnl)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">No open positions.</p>
            )}
          </section>

          <p className="text-center text-[10px] text-[var(--color-text-muted)]">
            Angel One's own LTP &amp; P&amp;L, auto-refreshed every {AUTO_REFRESH_MS / 1000}s during market hours (09:15–15:30 IST). Press Refresh to pull now.
          </p>
        </>
      )}

      {/* Persistent per-trade trackers (DB-backed). Export lives in the top header. */}
      <TradeTrackerSection
        data={trackers.data}
        loading={trackers.loading}
        error={trackers.error}
        notConnected={trackers.notConnected}
      />

      {/* Executed trades pulled live from the connected Angel One account. */}
      <BrokerTradesSection
        data={brokerTrades.data}
        loading={brokerTrades.loading}
        error={brokerTrades.error}
        notConnected={brokerTrades.notConnected}
      />

      {/* Sold trades (CLOSED trackers) with per-row daily-OHLC Excel/PDF export. */}
      <SoldTradesSection
        data={sold.data}
        loading={sold.loading}
        error={sold.error}
        notConnected={sold.notConnected}
      />
    </div>
  );
}
