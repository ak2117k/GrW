import { cn } from '../../utils/cn';

interface LoadingSkeletonProps {
  variant?: 'card' | 'table-row' | 'chart' | 'text' | 'circle';
  width?: string;
  height?: string;
  count?: number;
  className?: string;
}

function SkeletonItem({
  variant = 'text',
  width,
  height,
  className,
}: Omit<LoadingSkeletonProps, 'count'>) {
  const variantClasses: Record<string, string> = {
    card: 'h-32 w-full rounded-lg',
    'table-row': 'h-10 w-full rounded',
    chart: 'h-48 w-full rounded-lg',
    text: 'h-4 w-full rounded',
    circle: 'h-10 w-10 rounded-full',
  };

  return (
    <div
      className={cn(
        'animate-pulse bg-[#1f2937]',
        variantClasses[variant],
        className,
      )}
      style={{
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      }}
    >
      <div className="h-full w-full rounded-inherit bg-[#374151] opacity-0 animate-pulse" />
    </div>
  );
}

export function LoadingSkeleton({
  variant = 'text',
  width,
  height,
  count = 1,
  className,
}: LoadingSkeletonProps) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonItem
          key={i}
          variant={variant}
          width={width}
          height={height}
          className={className}
        />
      ))}
    </>
  );
}
