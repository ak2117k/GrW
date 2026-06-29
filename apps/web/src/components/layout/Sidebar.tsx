import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  LayoutDashboard,
  LineChart,
  Globe,
  Grid3X3,
  Zap,
  Ban,
  Radio,
  Eye,
  Bot,
  Briefcase,
  Newspaper,
  BookOpen,
  Brain,
  FlaskConical,
  Code2,
  ClipboardList,
  Settings,
  ChevronLeft,
  ChevronRight,
  GitCompareArrows,
  Timer,
  TrendingUp,
  TrendingDown,
  Rocket,
  PiggyBank,
  ShieldHalf,
  Send,
} from 'lucide-react';
import type { NavItem } from '@/types';

const navItems: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/manual-trade', label: 'Manual Trade', icon: Send },
  { path: '/charts', label: 'Charts', icon: LineChart },
  { path: '/market', label: 'Market', icon: Globe },
  { path: '/options', label: 'Options', icon: Grid3X3 },
  { path: '/signals', label: 'Signals', icon: Zap },
  { path: '/rejections', label: 'Rejections', icon: Ban },
  { path: '/chartink', label: 'Chartink', icon: Radio },
  { path: '/watch', label: 'Watch', icon: Eye },
  { path: '/ungated-watch', label: 'Ungated Watch', icon: GitCompareArrows, badge: 'EXP' },
  { path: '/adaptive-stop', label: 'Adaptive-Stop', icon: ShieldHalf, badge: 'EXP' },
  { path: '/intraday', label: 'Intraday', icon: Timer },
  { path: '/swing', label: 'Swing', icon: TrendingUp },
  { path: '/breakout-swing', label: 'Breakout Swing', icon: Rocket },
  { path: '/sell-futures', label: 'Sell Futures', icon: TrendingDown, badge: 'EXP' },
  { path: '/reinvest', label: 'Reinvest', icon: PiggyBank },
  { path: '/auto-trade', label: 'Auto-Trade', icon: Bot },
  { path: '/positions', label: 'Positions', icon: Briefcase },
  { path: '/news', label: 'News', icon: Newspaper },
  { path: '/journal', label: 'Journal', icon: BookOpen },
  { path: '/advisor', label: 'AI Advisor', icon: Brain },
  { path: '/backtest', label: 'Backtest', icon: FlaskConical },
  { path: '/strategy-builder', label: 'Strategy Builder', icon: Code2 },
  { path: '/strategy-review', label: 'Strategy Review', icon: ClipboardList },
  { path: '/settings', label: 'Settings', icon: Settings },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);

  return (
    <aside
      className={clsx(
        'fixed left-0 top-0 z-40 flex h-screen flex-col border-r transition-all duration-300',
        'border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]',
        collapsed ? 'w-16' : 'w-56',
      )}
    >
      {/* Logo */}
      <div className="flex h-14 items-center border-b border-[var(--color-border-subtle)] px-4">
        {!collapsed && (
          <span className="text-lg font-bold tracking-tight text-[var(--color-text-primary)]">
            TD<span className="text-[var(--color-accent-blue)]">Auto</span>
          </span>
        )}
        {collapsed && (
          <span className="mx-auto text-lg font-bold text-[var(--color-accent-blue)]">T</span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-1">
          {navItems.map((item) => (
            <li
              key={item.path}
              className="relative"
              onMouseEnter={() => setHoveredItem(item.path)}
              onMouseLeave={() => setHoveredItem(null)}
            >
              <NavLink
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-[var(--color-accent-blue)]/15 text-[var(--color-accent-blue)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text-primary)]',
                    collapsed && 'justify-center px-0',
                  )
                }
              >
                <item.icon size={20} className="shrink-0" />
                {!collapsed && (
                  <span className="flex items-center gap-1.5">
                    {item.label}
                    {item.badge && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 leading-none">
                        {item.badge}
                      </span>
                    )}
                  </span>
                )}
              </NavLink>

              {/* Tooltip when collapsed */}
              {collapsed && hoveredItem === item.path && (
                <div className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 rounded-md bg-[var(--color-bg-tertiary)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-primary)] shadow-lg border border-[var(--color-border-subtle)]">
                  {item.label}
                </div>
              )}
            </li>
          ))}
        </ul>
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={onToggle}
        className="flex h-10 items-center justify-center border-t border-[var(--color-border-subtle)] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
      >
        {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </button>
    </aside>
  );
}
