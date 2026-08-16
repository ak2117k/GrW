import { useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LineChart, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import api from '@/services/api';
import { buildChartHref } from '@/utils/chartHref';

interface SymbolChartLinkProps {
  symbol: string;
  /** Instrument token. When absent (e.g. rejection rows), it is resolved from
   *  the symbol on click before navigating. */
  token?: string | null;
  /** Defaults to NSE. */
  exchange?: string | null;
  /** Extra classes (the parent cell keeps its own font styling). */
  className?: string;
  /**
   * What the link READS AS, when that is not the symbol itself. The dashboard's
   * positions table links the P&L figure to the traded contract's own chart
   * while the symbol cell links to the underlying, so one row offers both
   * without repeating the tradingsymbol twice.
   *
   * `symbol` still decides WHERE it goes and what the tooltip names, so a
   * relabelled link cannot quietly point somewhere other than it claims.
   */
  label?: ReactNode;
}

/**
 * Renders a symbol as a link to its chart. Used in the watch / ungated / swing /
 * intraday / rejections tables. `stopPropagation` keeps a row's own click
 * handler (expand / select) from firing when the symbol itself is clicked.
 *
 * When a token is known (watch/ungated/most swing+intraday rows) it's a plain
 * Link — instant client-side navigation. When the token is missing (rejection
 * rows carry only a symbol), it resolves the token from the instrument search
 * on click and THEN navigates with a full deep link. We always navigate WITH a
 * token because a token-less /charts URL loses a race with the chart's URL↔store
 * sync and falls back to the default symbol.
 */
export function SymbolChartLink({ symbol, token, exchange, className, label }: SymbolChartLinkProps) {
  const navigate = useNavigate();
  const [resolving, setResolving] = useState(false);

  const cls = clsx(
    'group inline-flex items-center gap-1 text-left underline-offset-2 transition-colors',
    'hover:text-[var(--color-accent-blue)] hover:underline',
    className,
  );
  const icon = (
    <LineChart size={11} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-70" />
  );

  // Fast path: token known → plain Link, instant navigation.
  if (token) {
    return (
      <Link
        to={buildChartHref(symbol, token, exchange)}
        onClick={(e) => e.stopPropagation()}
        title={`Open ${symbol} chart`}
        className={cls}
      >
        {label ?? symbol}
        {icon}
      </Link>
    );
  }

  // Token-less: resolve, then navigate with a full deep link.
  const handleClick = async (e: MouseEvent) => {
    e.stopPropagation();
    if (resolving) return;
    setResolving(true);
    try {
      const resp = await api.get('/market-data/instruments', { params: { search: symbol } });
      const p = resp.data;
      const list: Array<{ symbol: string; token: string; exchange: string }> =
        p?.instruments ?? p?.data ?? (Array.isArray(p) ? p : []);
      const ex = exchange || 'NSE';
      const match =
        list.find((i) => i.symbol === symbol && i.exchange === ex) ??
        list.find((i) => i.symbol === symbol) ??
        list[0];
      navigate(buildChartHref(symbol, match?.token, match?.exchange ?? ex));
    } catch {
      // Best-effort — navigate by symbol; the chart shows its empty state if
      // the token couldn't be resolved.
      navigate(buildChartHref(symbol, null, exchange));
    } finally {
      setResolving(false);
    }
  };

  return (
    <button type="button" onClick={handleClick} title={`Open ${symbol} chart`} className={cls} disabled={resolving}>
      {label ?? symbol}
      {resolving ? (
        <Loader2 size={11} className="shrink-0 animate-spin opacity-70" />
      ) : (
        icon
      )}
    </button>
  );
}
