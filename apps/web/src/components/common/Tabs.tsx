import type { ReactNode } from 'react';
import { cn } from '../../utils/cn';

interface Tab {
  key: string;
  label: string;
  icon?: ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onChange: (key: string) => void;
  className?: string;
}

export function Tabs({ tabs, activeTab, onChange, className }: TabsProps) {
  return (
    <div
      className={cn(
        'flex border-b border-gray-700 gap-1',
        className,
      )}
    >
      {tabs.map((tab) => {
        const isActive = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={cn(
              'relative flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors -mb-px',
              isActive
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-gray-400 hover:text-gray-200 border-b-2 border-transparent',
            )}
          >
            {tab.icon && <span className="shrink-0">{tab.icon}</span>}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
