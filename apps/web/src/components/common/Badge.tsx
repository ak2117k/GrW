import { cn } from '../../utils/cn';

interface BadgeProps {
  label: string;
  variant?: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
  size?: 'sm' | 'md';
  className?: string;
}

const variantStyles: Record<string, string> = {
  success: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  danger: 'bg-red-500/15 text-red-400 border-red-500/30',
  warning: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  info: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  neutral: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
};

const sizeStyles: Record<string, string> = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2.5 py-0.5 text-xs',
};

export function Badge({
  label,
  variant = 'neutral',
  size = 'md',
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border font-medium leading-none whitespace-nowrap',
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
    >
      {label}
    </span>
  );
}
