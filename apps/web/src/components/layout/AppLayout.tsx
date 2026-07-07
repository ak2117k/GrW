import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { clsx } from 'clsx';
import Sidebar from './Sidebar';
import Header from './Header';
import { useMarketData } from '@/hooks/useMarketData';

export default function AppLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Initialize WebSocket connection for live market data
  useMarketData();

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-bg-primary)]">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((p) => !p)}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />

      {/* Mobile-only backdrop; tapping it closes the drawer. */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}

      <div
        className={clsx(
          'flex min-w-0 flex-1 flex-col transition-all duration-300',
          // Content margin only applies at md+, where the sidebar is docked.
          // On mobile the sidebar is an overlay, so content stays full-width.
          sidebarCollapsed ? 'md:ml-16' : 'md:ml-56',
        )}
      >
        <Header onMenuClick={() => setMobileNavOpen(true)} />

        <main className="flex-1 overflow-x-hidden overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
