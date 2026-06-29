import { cn } from '../../utils/cn';

interface ConnectionStatusProps {
  isConnected: boolean;
  label?: string;
  className?: string;
}

export function ConnectionStatus({
  isConnected,
  label,
  className,
}: ConnectionStatusProps) {
  const defaultLabel = isConnected ? 'Connected' : 'Disconnected';

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-xs', className)}
    >
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          isConnected
            ? 'bg-emerald-400 animate-pulse-dot'
            : 'bg-red-400',
        )}
      />
      <span className={isConnected ? 'text-emerald-400' : 'text-red-400'}>
        {label ?? defaultLabel}
      </span>
    </span>
  );
}
