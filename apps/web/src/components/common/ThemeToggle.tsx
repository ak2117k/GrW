import { Moon, Sun } from 'lucide-react';
import { useThemeStore } from '@/stores/theme-store';
import { cn } from '@/utils/cn';

/**
 * Dark/light theme switch. Flips the persisted theme; the whole token system
 * re-themes off the single <html data-theme> attribute the store toggles.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={!isDark}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Light mode' : 'Dark mode'}
      className={cn(
        'relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border transition-colors',
        'border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-blue)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg-primary)]',
        className,
      )}
    >
      <span
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-full shadow-md transition-transform duration-300 ease-out',
          'bg-[var(--color-bg-primary)]',
          isDark ? 'translate-x-1' : 'translate-x-7',
        )}
      >
        {isDark ? (
          <Moon size={13} className="text-[var(--color-accent-blue)]" />
        ) : (
          <Sun size={13} className="text-[var(--color-accent-yellow)]" />
        )}
      </span>
    </button>
  );
}
