import { cn } from '@/utils/cn';
import { DataTable, type Column } from '@/components/common';
import type { BacktestTradeResult } from '@/stores/backtest-store';

interface BacktestTradeListProps {
  trades: BacktestTradeResult[];
}

function formatINR(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPrice(price: number): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(price);
}

type TradeRow = BacktestTradeResult & Record<string, unknown>;

const columns: Column<TradeRow>[] = [
  {
    key: 'entryTime',
    header: 'Entry Time',
    sortable: true,
    render: (_val, row) => (
      <span className="text-xs tabular-nums">{formatDateTime(row.entryTime as string)}</span>
    ),
  },
  {
    key: 'exitTime',
    header: 'Exit Time',
    sortable: true,
    render: (_val, row) => (
      <span className="text-xs tabular-nums">{formatDateTime(row.exitTime as string)}</span>
    ),
  },
  {
    key: 'side',
    header: 'Side',
    sortable: true,
    width: '70px',
    render: (_val, row) => (
      <span
        className={cn(
          'rounded px-1.5 py-0.5 text-xs font-semibold',
          row.side === 'BUY'
            ? 'bg-[var(--color-accent-green)]/15 text-[var(--color-accent-green)]'
            : 'bg-[var(--color-accent-red)]/15 text-[var(--color-accent-red)]',
        )}
      >
        {row.side as string}
      </span>
    ),
  },
  {
    key: 'entryPrice',
    header: 'Entry',
    sortable: true,
    align: 'right',
    render: (_val, row) => (
      <span className="tabular-nums">{formatPrice(row.entryPrice as number)}</span>
    ),
  },
  {
    key: 'exitPrice',
    header: 'Exit',
    sortable: true,
    align: 'right',
    render: (_val, row) => (
      <span className="tabular-nums">{formatPrice(row.exitPrice as number)}</span>
    ),
  },
  {
    key: 'pnl',
    header: 'P&L',
    sortable: true,
    align: 'right',
    render: (_val, row) => {
      const pnl = row.pnl as number;
      return (
        <span
          className={cn(
            'font-semibold tabular-nums',
            pnl > 0
              ? 'text-[var(--color-accent-green)]'
              : pnl < 0
                ? 'text-[var(--color-accent-red)]'
                : 'text-[var(--color-text-muted)]',
          )}
        >
          {formatINR(pnl)}
        </span>
      );
    },
  },
  {
    key: 'reason',
    header: 'Reason',
    render: (_val, row) => (
      <span className="text-xs text-[var(--color-text-secondary)] max-w-[200px] truncate block">
        {row.reason as string}
      </span>
    ),
  },
];

export default function BacktestTradeList({ trades }: BacktestTradeListProps) {
  if (trades.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-[var(--color-text-muted)]">
        No trades generated in this backtest
      </div>
    );
  }

  // Convert to Record<string, unknown> for DataTable compatibility
  const data = trades.map((t) => ({ ...t })) as unknown as TradeRow[];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold text-[var(--color-text-primary)]">
          Trade List
        </h3>
        <span className="text-xs text-[var(--color-text-muted)]">
          {trades.length} trades
        </span>
      </div>
      <DataTable
        columns={columns}
        data={data}
        sortable
        className="max-h-[400px] overflow-y-auto"
      />
    </div>
  );
}
