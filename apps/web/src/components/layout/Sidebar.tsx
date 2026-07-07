import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';
import { visibleNavItems } from './navItems';

interface SidebarProps {
  /** Desktop-only icon-rail collapse. Has no effect below `md`. */
  collapsed: boolean;
  onToggle: () => void;
  /** Mobile drawer open state (<md). Ignored at `md+` where the rail is docked. */
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export default function Sidebar({
  collapsed,
  onToggle,
  mobileOpen,
  onMobileClose,
}: SidebarProps) {
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const role = useAuthStore((s) => s.user?.role);
  const items = visibleNavItems(role);

  return (
    <aside
      className={clsx(
        'fixed left-0 top-0 z-40 flex h-screen flex-col border-r transition-transform duration-300',
        'border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]',
        // Width: full drawer on mobile; on desktop the collapse toggle drives it.
        'w-64',
        collapsed ? 'md:w-16' : 'md:w-56',
        // Slide off-canvas on mobile when closed; always docked at md+.
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
        'md:translate-x-0',
      )}
    >
      {/* Logo row (+ mobile close button) */}
      <div className="flex h-14 items-center justify-between border-b border-[var(--color-border-subtle)] px-4">
        {/* Full wordmark: always on mobile; on desktop hidden when collapsed. */}
        <span
          className={clsx(
            'text-lg font-bold tracking-tight text-[var(--color-text-primary)]',
            collapsed && 'md:hidden',
          )}
        >
          Gr<span className="text-[var(--color-accent-blue)]">W</span>
        </span>
        {/* Icon wordmark: desktop-collapsed only. */}
        <span
          className={clsx(
            'mx-auto text-lg font-bold text-[var(--color-accent-blue)]',
            collapsed ? 'hidden md:inline' : 'hidden',
          )}
        >
          T
        </span>
        {/* Close the drawer on mobile. */}
        <button
          onClick={onMobileClose}
          aria-label="Close menu"
          className="text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)] md:hidden"
        >
          <X size={20} />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li
              key={item.path}
              className="relative"
              onMouseEnter={() => setHoveredItem(item.path)}
              onMouseLeave={() => setHoveredItem(null)}
            >
              <NavLink
                to={item.path}
                end={item.path === '/'}
                onClick={onMobileClose}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-[var(--color-accent-blue)]/15 text-[var(--color-accent-blue)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text-primary)]',
                    // Icon-only centering applies on desktop-collapsed only.
                    collapsed && 'md:justify-center md:px-0',
                  )
                }
              >
                <item.icon size={20} className="shrink-0" />
                {/* Label: always on mobile; on desktop hidden when collapsed. */}
                <span
                  className={clsx(
                    'flex items-center gap-1.5',
                    collapsed && 'md:hidden',
                  )}
                >
                  {item.label}
                  {item.badge && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 leading-none">
                      {item.badge}
                    </span>
                  )}
                </span>
              </NavLink>

              {/* Tooltip when collapsed (desktop hover only). */}
              {collapsed && hoveredItem === item.path && (
                <div className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 hidden -translate-y-1/2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-primary)] shadow-lg md:block">
                  {item.label}
                </div>
              )}
            </li>
          ))}
        </ul>
      </nav>

      {/* Collapse toggle — desktop only (mobile closes via backdrop/nav/X). */}
      <button
        onClick={onToggle}
        className="hidden h-10 items-center justify-center border-t border-[var(--color-border-subtle)] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)] md:flex"
      >
        {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </button>
    </aside>
  );
}
