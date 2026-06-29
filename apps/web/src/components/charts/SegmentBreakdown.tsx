import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from 'recharts';

interface SegmentBreakdownProps {
  data: Array<{ segment: string; pnl: number; trades: number }>;
}

const SEGMENT_COLORS: Record<string, string> = {
  OPTIONS: '#3b82f6',
  EQUITY: '#00cf84',
  FUTURES: '#f59e0b',
  COMMODITY: '#a855f7',
  UNKNOWN: '#64748b',
};

function formatINR(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const value = payload[0].value as number;
  const entry = payload[0].payload;
  return (
    <div className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2 shadow-lg">
      <p className="text-xs font-medium text-[var(--color-text-primary)]">{label}</p>
      <p
        className={`text-sm font-semibold ${value >= 0 ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]'}`}
      >
        P&L: {formatINR(value)}
      </p>
      <p className="text-xs text-[var(--color-text-muted)]">
        Trades: {entry.trades}
      </p>
    </div>
  );
}

export default function SegmentBreakdown({ data }: SegmentBreakdownProps) {
  if (!data.length) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-[var(--color-text-muted)]">
        No segment data available
      </div>
    );
  }

  return (
    <div>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 8, right: 24, left: 8, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(val: number) => formatINR(val)}
          />
          <YAxis
            type="category"
            dataKey="segment"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
            axisLine={false}
            tickLine={false}
            width={80}
          />
          <Tooltip content={<CustomTooltip />} />
          <Bar dataKey="pnl" radius={[0, 4, 4, 0]} maxBarSize={28}>
            {data.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={SEGMENT_COLORS[entry.segment] || SEGMENT_COLORS.UNKNOWN}
                fillOpacity={0.85}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap items-center gap-4 px-2 text-xs text-[var(--color-text-muted)]">
        {data.map((entry) => (
          <span key={entry.segment} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: SEGMENT_COLORS[entry.segment] || SEGMENT_COLORS.UNKNOWN }}
            />
            {entry.segment} ({entry.trades})
          </span>
        ))}
      </div>
    </div>
  );
}
