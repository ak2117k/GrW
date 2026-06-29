import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';

interface WinRateDonutProps {
  wins: number;
  losses: number;
}

const COLORS = {
  wins: '#00cf84',
  losses: '#ef4444',
};

function CustomLabel({ viewBox, wins, losses }: any) {
  const total = wins + losses;
  const rate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0';
  const { cx, cy } = viewBox;
  return (
    <g>
      <text
        x={cx}
        y={cy - 8}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-[var(--color-text-primary)]"
        style={{ fontSize: 24, fontWeight: 700 }}
      >
        {rate}%
      </text>
      <text
        x={cx}
        y={cy + 16}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-[var(--color-text-muted)]"
        style={{ fontSize: 11 }}
      >
        Win Rate
      </text>
    </g>
  );
}

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const { name, value } = payload[0];
  return (
    <div className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2 shadow-lg">
      <p className="text-sm font-medium text-[var(--color-text-primary)]">
        {name}: {value}
      </p>
    </div>
  );
}

export default function WinRateDonut({ wins, losses }: WinRateDonutProps) {
  const total = wins + losses;
  const data = [
    { name: 'Wins', value: wins },
    { name: 'Losses', value: losses },
  ];

  if (total === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center text-sm text-[var(--color-text-muted)]">
        No trade data available
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center">
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={70}
            outerRadius={100}
            paddingAngle={3}
            dataKey="value"
            strokeWidth={0}
          >
            {data.map((_entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={index === 0 ? COLORS.wins : COLORS.losses}
              />
            ))}
            <CustomLabel wins={wins} losses={losses} />
          </Pie>
          <Tooltip content={<CustomTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-6 text-xs text-[var(--color-text-secondary)]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--color-accent-green)]" />
          Wins: {wins}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--color-accent-red)]" />
          Losses: {losses}
        </span>
      </div>
    </div>
  );
}
