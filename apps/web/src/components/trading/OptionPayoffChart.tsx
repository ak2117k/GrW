import { useMemo } from 'react';
import {
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Area,
  ComposedChart,
} from 'recharts';

interface Position {
  strike: number;
  type: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  premium: number;
  qty: number;
}

interface OptionPayoffChartProps {
  positions: Position[];
  spotPrice?: number;
}

function calculatePayoff(
  positions: Position[],
  expiryPrice: number,
): number {
  let totalPayoff = 0;

  for (const pos of positions) {
    let optionPayoff = 0;

    if (pos.type === 'CE') {
      // Call: max(0, expiry - strike) - premium
      optionPayoff = Math.max(0, expiryPrice - pos.strike) - pos.premium;
    } else {
      // Put: max(0, strike - expiry) - premium
      optionPayoff = Math.max(0, pos.strike - expiryPrice) - pos.premium;
    }

    if (pos.side === 'SELL') {
      optionPayoff = -optionPayoff;
    }

    totalPayoff += optionPayoff * pos.qty;
  }

  return totalPayoff;
}

export default function OptionPayoffChart({
  positions,
  spotPrice,
}: OptionPayoffChartProps) {
  const chartData = useMemo(() => {
    if (positions.length === 0) return [];

    // Determine price range: spot +/- 5% or based on strikes
    const strikes = positions.map((p) => p.strike);
    const center = spotPrice ?? strikes.reduce((a, b) => a + b, 0) / strikes.length;
    const range = center * 0.05;
    const min = Math.floor((center - range) / 50) * 50;
    const max = Math.ceil((center + range) / 50) * 50;
    const step = Math.max(Math.round((max - min) / 100), 1);

    const data: Array<{ price: number; payoff: number }> = [];
    for (let price = min; price <= max; price += step) {
      data.push({
        price,
        payoff: Math.round(calculatePayoff(positions, price) * 100) / 100,
      });
    }

    return data;
  }, [positions, spotPrice]);

  if (positions.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
        <p className="text-xs text-[var(--color-text-muted)]">
          Click on CE/PE prices to add positions and see payoff diagram
        </p>
      </div>
    );
  }

  const maxProfit = Math.max(...chartData.map((d) => d.payoff));
  const maxLoss = Math.min(...chartData.map((d) => d.payoff));

  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
          Payoff Diagram
        </h3>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="text-[var(--color-accent-green)]">
            Max Profit: {maxProfit > 999999 ? 'Unlimited' : maxProfit.toLocaleString('en-IN')}
          </span>
          <span className="text-[var(--color-accent-red)]">
            Max Loss: {maxLoss.toLocaleString('en-IN')}
          </span>
        </div>
      </div>

      {/* Position summary */}
      <div className="flex flex-wrap gap-2">
        {positions.map((pos, i) => (
          <span
            key={i}
            className="rounded bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-secondary)]"
          >
            {pos.side} {pos.strike} {pos.type} x{pos.qty} @{pos.premium}
          </span>
        ))}
      </div>

      <ResponsiveContainer width="100%" height={250}>
        <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--color-border-subtle)"
            opacity={0.5}
          />
          <XAxis
            dataKey="price"
            tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
            tickFormatter={(val: number) => val.toLocaleString('en-IN')}
            stroke="var(--color-border-default)"
          />
          <YAxis
            tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
            tickFormatter={(val: number) => val.toLocaleString('en-IN')}
            stroke="var(--color-border-default)"
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-bg-card)',
              border: '1px solid var(--color-border-default)',
              borderRadius: '8px',
              fontSize: '11px',
              color: 'var(--color-text-primary)',
            }}
            labelFormatter={(val: number) => `Underlying: ${val.toLocaleString('en-IN')}`}
            formatter={(val: number) => [
              val.toLocaleString('en-IN'),
              'P&L',
            ]}
          />
          <ReferenceLine
            y={0}
            stroke="var(--color-border-default)"
            strokeDasharray="4 4"
          />
          {spotPrice && (
            <ReferenceLine
              x={spotPrice}
              stroke="var(--color-accent-yellow)"
              strokeDasharray="4 4"
              label={{
                value: 'Spot',
                fill: 'var(--color-accent-yellow)',
                fontSize: 10,
              }}
            />
          )}
          <defs>
            <linearGradient id="payoffGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent-green)" stopOpacity={0.3} />
              <stop offset="50%" stopColor="var(--color-accent-green)" stopOpacity={0} />
              <stop offset="50%" stopColor="var(--color-accent-red)" stopOpacity={0} />
              <stop offset="100%" stopColor="var(--color-accent-red)" stopOpacity={0.3} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="payoff"
            fill="url(#payoffGradient)"
            stroke="none"
          />
          <Line
            type="monotone"
            dataKey="payoff"
            stroke="var(--color-accent-blue)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: 'var(--color-accent-blue)' }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
