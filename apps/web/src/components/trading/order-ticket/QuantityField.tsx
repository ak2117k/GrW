import { cn } from '@/utils/cn';
import { Minus, Plus } from 'lucide-react';

export interface QuantityFieldProps {
  value: number;
  onChange: (n: number) => void;
  presets?: number[];
  min?: number;
}

export default function QuantityField({
  value,
  onChange,
  presets = [25, 50, 100, 500],
  min = 1,
}: QuantityFieldProps) {
  const clamp = (n: number) => Math.max(min, Math.floor(n) || min);
  const set = (n: number) => onChange(clamp(n));

  return (
    <div className="space-y-2">
      <div className="flex items-stretch rounded-md border border-gray-700 bg-gray-800 overflow-hidden focus-within:border-blue-500">
        <button
          type="button"
          aria-label="Decrease quantity"
          onClick={() => set(value - 1)}
          disabled={value <= min}
          className={cn(
            'px-3 text-gray-300 transition-colors hover:bg-gray-700',
            value <= min && 'opacity-40 cursor-not-allowed hover:bg-transparent',
          )}
        >
          <Minus size={14} />
        </button>
        <input
          type="number"
          min={min}
          value={value}
          aria-label="Quantity"
          onChange={(e) => set(parseInt(e.target.value, 10))}
          className="w-full border-x border-gray-700 bg-transparent py-2 px-3 text-center text-sm text-gray-100 outline-none"
        />
        <button
          type="button"
          aria-label="Increase quantity"
          onClick={() => set(value + 1)}
          className="px-3 text-gray-300 transition-colors hover:bg-gray-700"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => set(p)}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
              value === p
                ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600',
            )}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
