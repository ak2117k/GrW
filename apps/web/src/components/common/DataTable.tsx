import { useState, type ReactNode } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { cn } from '../../utils/cn';
import { LoadingSkeleton } from './LoadingSkeleton';
import { EmptyState } from './EmptyState';

export interface Column<T = unknown> {
  key: string;
  header: string;
  render?: (value: unknown, row: T) => ReactNode;
  sortable?: boolean;
  align?: 'left' | 'center' | 'right';
  width?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (row: T) => void;
  sortable?: boolean;
  loading?: boolean;
  emptyMessage?: string;
  className?: string;
}

type SortDir = 'asc' | 'desc';

export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  onRowClick,
  sortable = false,
  loading = false,
  emptyMessage = 'No data available',
  className,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sortedData = (() => {
    if (!sortKey) return data;
    const copy = [...data];
    copy.sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      const aStr = String(aVal);
      const bStr = String(bVal);
      return sortDir === 'asc'
        ? aStr.localeCompare(bStr)
        : bStr.localeCompare(aStr);
    });
    return copy;
  })();

  const alignClass = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
  };

  return (
    <div className={cn('overflow-x-auto rounded-lg border border-gray-700/60', className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-700 bg-gray-800/80">
            {columns.map((col) => {
              const canSort = sortable && col.sortable !== false;
              const isActive = sortKey === col.key;
              return (
                <th
                  key={col.key}
                  className={cn(
                    'px-3 py-2.5 text-xs font-medium uppercase tracking-wide text-gray-400',
                    alignClass[col.align ?? 'left'],
                    canSort && 'cursor-pointer select-none hover:text-gray-200',
                  )}
                  style={col.width ? { width: col.width } : undefined}
                  onClick={canSort ? () => handleSort(col.key) : undefined}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    {canSort && (
                      <span className="inline-flex text-gray-600">
                        {isActive ? (
                          sortDir === 'asc' ? (
                            <ChevronUp size={14} />
                          ) : (
                            <ChevronDown size={14} />
                          )
                        ) : (
                          <ChevronsUpDown size={14} />
                        )}
                      </span>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 5 }, (_, i) => (
              <tr key={i} className="border-b border-gray-700/40">
                {columns.map((col) => (
                  <td key={col.key} className="px-3 py-2.5">
                    <LoadingSkeleton variant="text" height="16px" />
                  </td>
                ))}
              </tr>
            ))
          ) : sortedData.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>
                <EmptyState title={emptyMessage} />
              </td>
            </tr>
          ) : (
            sortedData.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'border-b border-gray-700/40 transition-colors',
                  rowIdx % 2 === 0 ? 'bg-transparent' : 'bg-gray-800/30',
                  onRowClick && 'cursor-pointer hover:bg-gray-700/40',
                )}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      'px-3 py-2.5 text-gray-200',
                      alignClass[col.align ?? 'left'],
                    )}
                  >
                    {col.render
                      ? col.render(row[col.key], row)
                      : (row[col.key] as ReactNode) ?? '-'}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
