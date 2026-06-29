import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import type { BacktestTradeResult } from '@/stores/backtest-store';

interface BacktestEquityCurveProps {
  trades: BacktestTradeResult[];
  initialCapital: number;
  comparison?: Array<{
    strategy: string;
    trades: BacktestTradeResult[];
    initialCapital: number;
  }>;
}

interface EquityPoint {
  date: string;
  equity: number;
  drawdown: number;
  [key: string]: string | number;
}

const STRATEGY_COLORS = [
  '#3b82f6',
  '#00cf84',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
];

function formatINR(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

function buildEquityCurve(
  trades: BacktestTradeResult[],
  initialCapital: number,
): EquityPoint[] {
  if (trades.length === 0) return [];

  const sorted = [...trades].sort(
    (a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime(),
  );

  let equity = initialCapital;
  let peak = initialCapital;
  const points: EquityPoint[] = [
    {
      date: new Date(sorted[0].entryTime).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
      }),
      equity: initialCapital,
      drawdown: 0,
    },
  ];

  for (const trade of sorted) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;

    points.push({
      date: new Date(trade.exitTime).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
      }),
      equity,
      drawdown,
    });
  }

  return points;
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2 shadow-xl">
      <p className="text-xs text-[var(--color-text-muted)] mb-1">{label}</p>
      {payload.map((entry: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-xs text-[var(--color-text-secondary)]">
            {entry.name}:
          </span>
          <span
            className={`text-sm font-semibold ${
              entry.value >= 0
                ? 'text-[var(--color-accent-green)]'
                : 'text-[var(--color-accent-red)]'
            }`}
          >
            {typeof entry.value === 'number' ? formatINR(entry.value) : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function BacktestEquityCurve({
  trades,
  initialCapital,
  comparison,
}: BacktestEquityCurveProps) {
  // Comparison mode: multiple equity lines
  if (comparison && comparison.length > 0) {
    // Build merged data points
    const allCurves = comparison.map((c) =>
      buildEquityCurve(c.trades, c.initialCapital),
    );

    // Find the longest curve for x-axis
    let maxLen = 0;
    let longestIdx = 0;
    allCurves.forEach((curve, i) => {
      if (curve.length > maxLen) {
        maxLen = curve.length;
        longestIdx = i;
      }
    });

    if (maxLen === 0) {
      return (
        <div className="flex h-64 items-center justify-center text-sm text-[var(--color-text-muted)]">
          No equity data for comparison
        </div>
      );
    }

    // Merge into a single data array using the longest curve's dates
    const merged = allCurves[longestIdx].map((point, idx) => {
      const result: Record<string, any> = { date: point.date };
      comparison.forEach((c, i) => {
        result[c.strategy] = allCurves[i][idx]?.equity ?? null;
      });
      return result;
    });

    return (
      <div>
        <h3 className="mb-3 text-base font-semibold text-[var(--color-text-primary)]">
          Equity Curve Comparison
        </h3>
        <ResponsiveContainer width="100%" height={360}>
          <AreaChart data={merged} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
            <XAxis
              dataKey="date"
              tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
              axisLine={{ stroke: 'var(--color-border-subtle)' }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={formatINR}
              width={90}
            />
            <Tooltip content={<CustomTooltip />} />
            {comparison.map((c, i) => (
              <Area
                key={c.strategy}
                type="monotone"
                dataKey={c.strategy}
                stroke={STRATEGY_COLORS[i % STRATEGY_COLORS.length]}
                strokeWidth={2}
                fill="none"
                dot={false}
                activeDot={{
                  r: 4,
                  fill: STRATEGY_COLORS[i % STRATEGY_COLORS.length],
                  stroke: '#fff',
                  strokeWidth: 1,
                }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
        <div className="mt-2 flex flex-wrap gap-4 justify-center">
          {comparison.map((c, i) => (
            <div key={c.strategy} className="flex items-center gap-1.5 text-xs">
              <div
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: STRATEGY_COLORS[i % STRATEGY_COLORS.length] }}
              />
              <span className="text-[var(--color-text-secondary)]">{c.strategy}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Single backtest mode
  const data = buildEquityCurve(trades, initialCapital);

  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-[var(--color-text-muted)]">
        No equity data available
      </div>
    );
  }

  const lastEquity = data[data.length - 1]?.equity ?? initialCapital;
  const isPositive = lastEquity >= initialCapital;
  const strokeColor = isPositive ? 'var(--color-accent-green)' : 'var(--color-accent-red)';
  const fillId = isPositive ? 'btEquityGreen' : 'btEquityRed';
  const fillColor = isPositive ? '#00cf84' : '#ef4444';

  const maxDrawdown = Math.max(...data.map((d) => d.drawdown));
  const hasDrawdown = maxDrawdown > 0;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold text-[var(--color-text-primary)]">
          Equity Curve
        </h3>
        {hasDrawdown && (
          <span className="text-xs text-[var(--color-accent-red)]">
            Max DD: {maxDrawdown.toFixed(2)}%
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={360}>
        <AreaChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="btEquityGreen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#00cf84" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#00cf84" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="btEquityRed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ef4444" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#ef4444" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="btDrawdownFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ef4444" stopOpacity={0.15} />
              <stop offset="100%" stopColor="#ef4444" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
          <XAxis
            dataKey="date"
            tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--color-border-subtle)' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={formatINR}
            width={90}
          />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine
            y={initialCapital}
            stroke="var(--color-border-default)"
            strokeDasharray="4 4"
          />
          <Area
            type="monotone"
            dataKey="equity"
            name="Equity"
            stroke={strokeColor}
            strokeWidth={2}
            fill={`url(#${fillId})`}
            dot={false}
            activeDot={{ r: 4, fill: fillColor, stroke: '#fff', strokeWidth: 1 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
