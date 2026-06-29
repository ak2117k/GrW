import { useState } from 'react';
import {
  MousePointer2, Minus, Square, TrendingUp, AlignVerticalJustifyCenter,
  Triangle, Type, ArrowUpRight, Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import { useDrawingStore } from '@/stores/drawing-store';
import type { ToolKind } from '@/types/drawings';

interface ToolButton {
  kind: ToolKind | null;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

const TOOLS: ToolButton[] = [
  { kind: null, label: 'Cursor', icon: MousePointer2 },
  { kind: 'hline', label: 'Horizontal line', icon: Minus },
  { kind: 'hzone', label: 'Horizontal zone', icon: AlignVerticalJustifyCenter },
  { kind: 'trend', label: 'Trend line', icon: TrendingUp },
  { kind: 'vline', label: 'Vertical line', icon: AlignVerticalJustifyCenter },
  { kind: 'rect', label: 'Rectangle', icon: Square },
  { kind: 'fib', label: 'Fibonacci retracement', icon: Triangle },
  { kind: 'text', label: 'Text', icon: Type },
  { kind: 'arrow', label: 'Arrow', icon: ArrowUpRight },
];

interface DrawingToolbarProps {
  token: string;
}

export default function DrawingToolbar({ token }: DrawingToolbarProps) {
  const activeTool = useDrawingStore((s) => s.activeTool);
  const setActiveTool = useDrawingStore((s) => s.setActiveTool);
  const clearToken = useDrawingStore((s) => s.clearToken);
  const drawingsCount = useDrawingStore((s) => (s.drawings[token] ?? []).length);
  const [confirmingClear, setConfirmingClear] = useState(false);

  function handleClick(kind: ToolKind | null) {
    setActiveTool(activeTool === kind ? null : kind);
  }

  function handleClear() {
    if (!confirmingClear) {
      setConfirmingClear(true);
      window.setTimeout(() => setConfirmingClear(false), 3000);
      return;
    }
    clearToken(token);
    setConfirmingClear(false);
  }

  return (
    <div
      className="flex flex-col items-center gap-0.5 border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] py-2"
      style={{ width: 40 }}
    >
      {TOOLS.map((t) => {
        const Icon = t.icon;
        const isActive = activeTool === t.kind;
        return (
          <button
            key={t.label}
            type="button"
            title={t.label}
            onClick={() => handleClick(t.kind)}
            className={clsx(
              'w-8 h-8 flex items-center justify-center rounded transition-colors',
              isActive
                ? 'bg-[var(--color-accent-blue)] text-white'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]',
            )}
          >
            <Icon size={16} />
          </button>
        );
      })}
      <div className="flex-1" />
      <button
        type="button"
        title={confirmingClear ? `Click again to clear ${drawingsCount}` : 'Clear all drawings'}
        onClick={handleClear}
        disabled={drawingsCount === 0}
        className={clsx(
          'w-8 h-8 flex items-center justify-center rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed',
          confirmingClear
            ? 'bg-[var(--color-accent-red)] text-white'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]',
        )}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
