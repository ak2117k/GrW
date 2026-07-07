import { useState, useEffect } from 'react';
import { OctagonX, Wifi, WifiOff, LogOut, Menu } from 'lucide-react';
import { clsx } from 'clsx';
import { useMarketStore } from '@/stores/market-store';
import { useAuthStore } from '@/stores/auth-store';
import { ThemeToggle } from '@/components/common';

interface HeaderProps {
  /** Opens the mobile nav drawer (hamburger); only rendered below `md`. */
  onMenuClick: () => void;
}

function useIST() {
  const [time, setTime] = useState('');

  useEffect(() => {
    function tick() {
      const now = new Date();
      setTime(
        now.toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }),
      );
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return time;
}

export default function Header({ onMenuClick }: HeaderProps) {
  const time = useIST();
  const isConnected = useMarketStore((s) => s.isConnected);
  const marketStatus = useMarketStore((s) => s.marketStatus);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const handleLogout = async () => {
    await logout();
    // Full-nav so all in-memory stores/sockets reset cleanly on sign-out.
    window.location.assign('/login');
  };

  const statusColor =
    marketStatus === 'open'
      ? 'bg-[var(--color-accent-green)]'
      : marketStatus === 'pre-market'
        ? 'bg-[var(--color-accent-yellow)]'
        : 'bg-[var(--color-accent-red)]';

  const statusLabel =
    marketStatus === 'open'
      ? 'Market Open'
      : marketStatus === 'pre-market'
        ? 'Pre-Market'
        : 'Market Closed';

  const handleKillSwitch = () => {
    if (window.confirm('KILL SWITCH: Cancel ALL open orders and close ALL positions?')) {
      console.warn('[KILL SWITCH] Activated');
      // Will be connected to API in future
    }
  };

  return (
    <header className="flex h-14 items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-3 md:px-6">
      {/* Left side: hamburger (mobile) + Market status */}
      <div className="flex min-w-0 items-center gap-3 md:gap-6">
        <button
          onClick={onMenuClick}
          aria-label="Open menu"
          className="text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] md:hidden"
        >
          <Menu size={22} />
        </button>

        <div className="flex min-w-0 items-center gap-2">
          <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full animate-pulse-dot', statusColor)} />
          <span className="truncate text-sm font-medium text-[var(--color-text-secondary)]">
            {statusLabel}
          </span>
        </div>

        {/* Live/Disconnected indicator — hidden on the smallest screens. */}
        <div className="hidden items-center gap-1.5 text-[var(--color-text-muted)] sm:flex">
          {isConnected ? <Wifi size={14} /> : <WifiOff size={14} />}
          <span className="text-xs">
            {isConnected ? 'Live' : 'Disconnected'}
          </span>
        </div>
      </div>

      {/* Right side: Theme + Clock + Kill Switch + Logout */}
      <div className="flex shrink-0 items-center gap-2 md:gap-5">
        <ThemeToggle />
        {/* Clock — hidden on the smallest screens to save width. */}
        <div className="hidden flex-col items-end sm:flex">
          <span className="font-mono text-sm font-semibold tracking-wider text-[var(--color-text-primary)]">
            {time}
          </span>
          <span className="text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            IST
          </span>
        </div>

        <button
          onClick={handleKillSwitch}
          className="flex items-center gap-2 rounded-lg bg-[var(--color-accent-red)] px-3 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-red-500/20 transition-all hover:bg-red-600 hover:shadow-red-500/40 active:scale-95 md:px-4"
        >
          <OctagonX size={14} />
          {/* Text label hidden on mobile; the icon still conveys the action. */}
          <span className="hidden sm:inline">Kill Switch</span>
        </button>

        <div className="flex items-center gap-2 border-l border-[var(--color-border-subtle)] pl-2 md:pl-4">
          {user?.email && (
            <span className="hidden text-xs text-[var(--color-text-muted)] lg:inline">
              {user.email}
            </span>
          )}
          <button
            onClick={handleLogout}
            title="Sign out"
            className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-white/5 hover:text-[var(--color-text-primary)]"
          >
            <LogOut size={14} />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </div>
    </header>
  );
}
