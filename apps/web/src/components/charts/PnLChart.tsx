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

interface PnLChartProps {
  data: Array<{ date: string; pnl: number }>;
}

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
  return (
    <div className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2 shadow-lg">
      <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
      <p
        className={`text-sm font-semibold ${value >= 0 ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]'}`}
      >
        {formatINR(value)}
      </p>
    </div>
  );
}

export default function PnLChart({ data }: PnLChartProps) {
  if (!data.length) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-[var(--color-text-muted)]">
        No daily P&L data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
        <XAxis
          dataKey="date"
          tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
          axisLine={{ stroke: 'var(--color-border-subtle)' }}
          tickLine={false}
          tickFormatter={(val: string) => {
            const parts = val.split('-');
            return `${parts[2]}/${parts[1]}`;
          }}
        />
        <YAxis
          tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(val: number) => formatINR(val)}
          width={80}
        />
        <Tooltip content={<CustomTooltip />} />
        <Bar dataKey="pnl" radius={[3, 3, 0, 0]} maxBarSize={32}>
          {data.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={entry.pnl >= 0 ? 'var(--color-accent-green)' : 'var(--color-accent-red)'}
              fillOpacity={0.85}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
