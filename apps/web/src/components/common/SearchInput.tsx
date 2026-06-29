import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../../utils/cn';

interface SearchInputProps {
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  debounceMs?: number;
  className?: string;
}

export function SearchInput({
  placeholder = 'Search...',
  value,
  onChange,
  onClear,
  debounceMs = 300,
  className,
}: SearchInputProps) {
  const [internal, setInternal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync external value changes
  useEffect(() => {
    setInternal(value);
  }, [value]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setInternal(next);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onChange(next), debounceMs);
  }

  function handleClear() {
    setInternal('');
    clearTimeout(timerRef.current);
    onChange('');
    onClear?.();
  }

  // Cleanup timer on unmount
  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div className={cn('relative', className)}>
      <Search
        size={16}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"
      />
      <input
        type="text"
        value={internal}
        onChange={handleChange}
        placeholder={placeholder}
        className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 pl-9 pr-8 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
      />
      {internal && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
