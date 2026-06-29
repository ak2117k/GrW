import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';

interface EquityCurveProps {
  data: Array<{ date: string; equity: number }>;
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

export default function EquityCurve({ data }: EquityCurveProps) {
  if (!data.length) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-[var(--color-text-muted)]">
        No equity data available
      </div>
    );
  }

  const lastValue = data[data.length - 1]?.equity ?? 0;
  const isPositive = lastValue >= 0;
  const strokeColor = isPositive ? 'var(--color-accent-green)' : 'var(--color-accent-red)';
  const fillId = isPositive ? 'equityGradientGreen' : 'equityGradientRed';
  const fillColor = isPositive ? '#00cf84' : '#ef4444';

  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="equityGradientGreen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00cf84" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#00cf84" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="equityGradientRed" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ef4444" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#ef4444" stopOpacity={0.02} />
          </linearGradient>
        </defs>
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
        <Area
          type="monotone"
          dataKey="equity"
          stroke={strokeColor}
          strokeWidth={2}
          fill={`url(#${fillId})`}
          dot={false}
          activeDot={{ r: 4, fill: fillColor, stroke: '#fff', strokeWidth: 1 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
