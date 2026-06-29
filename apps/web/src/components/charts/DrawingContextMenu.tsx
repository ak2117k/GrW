import { useEffect, useRef } from 'react';
import { useDrawingStore } from '@/stores/drawing-store';
import type { Drawing, LineStyle, LineWidth } from '@/types/drawings';

const COLOR_SWATCHES = [
  '#06b6d4', '#22c55e', '#eab308', '#f97316', '#ef4444',
  '#a855f7', '#3b82f6', '#94a3b8', '#ffffff',
];

interface DrawingContextMenuProps {
  token: string;
  drawing: Drawing;
  x: number;
  y: number;
  onClose: () => void;
}

export default function DrawingContextMenu({ token, drawing, x, y, onClose }: DrawingContextMenuProps) {
  const updateDrawing = useDrawingStore((s) => s.updateDrawing);
  const deleteDrawing = useDrawingStore((s) => s.deleteDrawing);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left: x, top: y, zIndex: 200 }}
      className="bg-[var(--color-bg-tertiary)] border border-[var(--color-border-subtle)] rounded shadow-lg p-2 text-xs min-w-[180px]"
    >
      <div className="mb-2">
        <div className="text-[10px] uppercase text-[var(--color-text-muted)] mb-1">Color</div>
        <div className="grid grid-cols-9 gap-1">
          {COLOR_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => updateDrawing(token, drawing.id, { color: c })}
              className="w-4 h-4 rounded-sm border border-black/20"
              style={{ background: c }}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
      </div>

      <div className="mb-2">
        <div className="text-[10px] uppercase text-[var(--color-text-muted)] mb-1">Style</div>
        <div className="flex gap-1">
          {(['solid', 'dashed', 'dotted'] as LineStyle[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => updateDrawing(token, drawing.id, { lineStyle: s })}
              className={`px-2 py-1 rounded ${drawing.lineStyle === s ? 'bg-[var(--color-accent-blue)] text-white' : 'hover:bg-[var(--color-bg-secondary)]'}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-2">
        <div className="text-[10px] uppercase text-[var(--color-text-muted)] mb-1">Width</div>
        <div className="flex gap-1">
          {([1, 2, 3] as LineWidth[]).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => updateDrawing(token, drawing.id, { lineWidth: w })}
              className={`px-2 py-1 rounded ${drawing.lineWidth === w ? 'bg-[var(--color-accent-blue)] text-white' : 'hover:bg-[var(--color-bg-secondary)]'}`}
            >
              {w}px
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => { deleteDrawing(token, drawing.id); onClose(); }}
        className="w-full text-left px-2 py-1 rounded text-[var(--color-accent-red)] hover:bg-[var(--color-bg-secondary)]"
      >
        Delete
      </button>
    </div>
  );
}
