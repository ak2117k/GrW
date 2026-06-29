import type { ReactNode } from 'react';
import { cn } from '../../utils/cn';
import { Inbox } from 'lucide-react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-12 px-4 text-center',
        className,
      )}
    >
      <div className="text-gray-600 mb-4">
        {icon ?? <Inbox size={48} />}
      </div>
      <h3 className="text-sm font-medium text-gray-300 mb-1">{title}</h3>
      {description && (
        <p className="text-xs text-gray-500 max-w-xs mb-4">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="px-4 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-500 transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
