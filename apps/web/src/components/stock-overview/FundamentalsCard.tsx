import { Card, Stat, formatINR } from './_shared';
import { useFundamentals } from '@/hooks/useFundamentals';

interface Props {
  symbol: string;
  exchange: string;
}

/** Exchange codes that have no fundamentals concept — commodities + derivatives. */
const NON_EQUITY_EXCHANGES = new Set(['MCX', 'NFO', 'CDS']);

/**
 * Index symbols that ride the NSE exchange code but aren't equities. Yahoo
 * doesn't carry fundamentals for these — sending them would 404 the
 * endpoint and (without this guard) flash a Retry button on the user.
 */
const INDEX_SYMBOLS = new Set([
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'NIFTYIT',
  'NIFTY MIDCAP 50',
  'NIFTY IT',
  'SENSEX',
  'BANKEX',
]);

/**
 * Card 7 — Fundamentals. Real data from Yahoo Finance via
 * GET /api/fundamentals/:symbol (24h server cache).
 *
 * Visibility rules:
 *   - Hidden entirely for empty symbol or non-equity exchange (indices,
 *     MCX commodities) — fundamentals don't apply.
 *   - Loading → caption while the first fetch is in flight.
 *   - 503 / fetch error → "Fundamentals unavailable" + Retry button.
 *   - Success → header (sector · industry), 4-col stats grid, optional
 *     next-earnings line, optional last-4-quarters table.
 */
export default function FundamentalsCard({ symbol, exchange }: Props) {
  const { data, loading, error, refetch } = useFundamentals(symbol, exchange);

  if (
    !symbol ||
    NON_EQUITY_EXCHANGES.has(exchange) ||
    INDEX_SYMBOLS.has(symbol.toUpperCase())
  ) {
    return null;
  }

  if (loading && !data) {
    return (
      <Card title="Fundamentals">
        <p className="text-sm text-zinc-500">Loading fundamentals…</p>
      </Card>
    );
  }

  if (error || !data) {
    // 404 ('fundamentals_not_listed') = Yahoo doesn't carry this ticker.
    // Render a quiet caption — Retry won't help, no need to alarm the user.
    if (error === 'fundamentals_not_listed') {
      return (
        <Card title="Fundamentals">
          <p className="text-sm text-zinc-500">
            Fundamentals not available for this instrument on Yahoo Finance.
          </p>
        </Card>
      );
    }
    // 503 / network blip / unknown — show Retry.
    return (
      <Card title="Fundamentals">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-zinc-500">Fundamentals temporarily unavailable</p>
          <button
            type="button"
            onClick={refetch}
            className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 transition-colors"
          >
            Retry
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Fundamentals"
      action={<span className="text-xs text-zinc-600">via Yahoo Finance</span>}
    >
      {(data.sector || data.industry) && (
        <div className="text-xs text-zinc-400 mb-3">
          {[data.sector, data.industry].filter(Boolean).join(' · ')}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Market Cap" value={formatINR(data.marketCap)} />
        <Stat label="P/E" value={fmtRatio(data.trailingPE)} />
        <Stat label="P/B" value={fmtRatio(data.priceToBook)} />
        <Stat label="EPS" value={fmtRatio(data.trailingEPS)} />
        <Stat label="ROE" value={fmtPercent(data.returnOnEquity)} />
        <Stat label="Debt / Equity" value={fmtRatio(data.debtToEquity)} />
        <Stat label="52w High" value={fmtPrice(data.fiftyTwoWeekHigh)} />
        <Stat label="52w Low" value={fmtPrice(data.fiftyTwoWeekLow)} />
        <Stat label="Div Yield" value={fmtPercent(data.dividendYield)} />
        <Stat label="Beta" value={fmtRatio(data.beta)} />
      </div>

      {data.nextEarningsDate && (
        <div className="mt-4 pt-3 border-t border-zinc-800 text-xs text-zinc-400">
          Next Earnings:{' '}
          <span className="text-zinc-200 tabular-nums">
            {formatEarningsWhen(data.nextEarningsDate)}
          </span>
        </div>
      )}

      {data.recentEarnings && data.recentEarnings.length > 0 && (
        <div className="mt-3">
          <div className="text-xs text-zinc-500 mb-1.5">Recent Quarters</div>
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="text-zinc-500 text-left">
                <th className="font-normal pb-1">Quarter</th>
                <th className="font-normal pb-1 text-right">Reported</th>
                <th className="font-normal pb-1 text-right">Estimate</th>
                <th className="font-normal pb-1 text-right">Surprise</th>
              </tr>
            </thead>
            <tbody>
              {data.recentEarnings.slice(-4).map((q) => (
                <tr key={q.date || q.quarter} className="border-t border-zinc-800/60">
                  <td className="py-1 text-zinc-300">{q.quarter}</td>
                  <td className="py-1 text-right text-zinc-200">
                    {fmtRatio(q.reportedEPS)}
                  </td>
                  <td className="py-1 text-right text-zinc-200">
                    {fmtRatio(q.estimateEPS)}
                  </td>
                  <td
                    className={`py-1 text-right ${
                      q.surprise == null
                        ? 'text-zinc-500'
                        : q.surprise >= 0
                          ? 'text-emerald-400'
                          : 'text-red-400'
                    }`}
                  >
                    {q.surprise == null
                      ? '—'
                      : `${q.surprise >= 0 ? '+' : ''}${q.surprise.toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** "24.07" — two decimals, "—" when missing. Used for P/E, P/B, EPS, beta. */
function fmtRatio(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(2);
}

/** "1,612" — Indian-locale, no decimals. Used for 52w High/Low (price). */
function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-IN', { maximumFractionDigits: 1 });
}

/**
 * Yahoo gives ROE / dividend yield as decimals (0.18 = 18%) but
 * `debtToEquity` already as a percentage-style number (45.2 = 45.2%).
 * The card already routes D/E through `fmtRatio`, so this helper only
 * sees the genuinely-decimal fields.
 */
function fmtPercent(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * Render an earnings date as relative ("in 12 days") when in the future,
 * absolute ("29 Apr 2026") when in the past or unparseable.
 *
 * Yahoo gives an ISO `YYYY-MM-DD`, which is timezone-naive. We compare
 * day boundaries in local time so "tomorrow" doesn't flicker to "today"
 * around UTC midnight.
 */
function formatEarningsWhen(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((d.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));

  if (diffDays > 0 && diffDays <= 60) {
    return diffDays === 1 ? 'tomorrow' : `in ${diffDays} days`;
  }
  if (diffDays === 0) return 'today';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
