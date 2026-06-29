import { cn } from '../../utils/cn';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

const trackSize = {
  sm: 'w-8 h-4',
  md: 'w-10 h-5',
};

const thumbSize = {
  sm: 'h-3 w-3',
  md: 'h-4 w-4',
};

const thumbTranslate = {
  sm: 'translate-x-4',
  md: 'translate-x-5',
};

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  size = 'md',
  className,
}: ToggleProps) {
  return (
    <label
      className={cn(
        'inline-flex items-center gap-2 select-none',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        className,
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200',
          trackSize[size],
          checked ? 'bg-emerald-500' : 'bg-gray-600',
        )}
      >
        <span
          className={cn(
            'inline-block rounded-full bg-white shadow transition-transform duration-200 ml-0.5',
            thumbSize[size],
            checked ? thumbTranslate[size] : 'translate-x-0',
          )}
        />
      </button>
      {label && (
        <span className="text-sm text-gray-300">{label}</span>
      )}
    </label>
  );
}
