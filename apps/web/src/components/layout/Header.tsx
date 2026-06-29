import { useState, useEffect } from 'react';
import { OctagonX, Wifi, WifiOff, LogOut } from 'lucide-react';
import { clsx } from 'clsx';
import { useMarketStore } from '@/stores/market-store';
import { useAuthStore } from '@/stores/auth-store';

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

export default function Header() {
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
    <header className="flex h-14 items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-6">
      {/* Left side: Market status */}
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span className={clsx('h-2.5 w-2.5 rounded-full animate-pulse-dot', statusColor)} />
          <span className="text-sm font-medium text-[var(--color-text-secondary)]">
            {statusLabel}
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
          {isConnected ? <Wifi size={14} /> : <WifiOff size={14} />}
          <span className="text-xs">
            {isConnected ? 'Live' : 'Disconnected'}
          </span>
        </div>
      </div>

      {/* Right side: Clock + Kill Switch */}
      <div className="flex items-center gap-5">
        <div className="flex flex-col items-end">
          <span className="font-mono text-sm font-semibold tracking-wider text-[var(--color-text-primary)]">
            {time}
          </span>
          <span className="text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            IST
          </span>
        </div>

        <button
          onClick={handleKillSwitch}
          className="flex items-center gap-2 rounded-lg bg-[var(--color-accent-red)] px-4 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-red-500/20 transition-all hover:bg-red-600 hover:shadow-red-500/40 active:scale-95"
        >
          <OctagonX size={14} />
          Kill Switch
        </button>

        <div className="flex items-center gap-2 border-l border-[var(--color-border-subtle)] pl-4">
          {user?.email && (
            <span className="hidden text-xs text-[var(--color-text-muted)] sm:inline">
              {user.email}
            </span>
          )}
          <button
            onClick={handleLogout}
            title="Sign out"
            className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-white/5 hover:text-[var(--color-text-primary)]"
          >
            <LogOut size={14} />
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
