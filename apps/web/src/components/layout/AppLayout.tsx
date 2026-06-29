import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { clsx } from 'clsx';
import Sidebar from './Sidebar';
import Header from './Header';
import { useMarketData } from '@/hooks/useMarketData';

export default function AppLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Initialize WebSocket connection for live market data
  useMarketData();

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-bg-primary)]">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((p) => !p)}
      />

      <div
        className={clsx(
          'flex min-w-0 flex-1 flex-col transition-all duration-300',
          sidebarCollapsed ? 'ml-16' : 'ml-56',
        )}
      >
        <Header />

        <main className="flex-1 overflow-x-hidden overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
