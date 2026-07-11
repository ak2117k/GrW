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
  GitCompareArrows,
  Timer,
  TrendingUp,
  TrendingDown,
  Rocket,
  PiggyBank,
  ShieldHalf,
  Send,
  CreditCard,
  PieChart,
} from 'lucide-react';
import type { NavItem } from '@/types';

export const navItems: NavItem[] = [
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
  { path: '/portfolio', label: 'Portfolio', icon: PieChart },
  { path: '/payments', label: 'Payments', icon: CreditCard },
  { path: '/news', label: 'News', icon: Newspaper },
  { path: '/journal', label: 'Journal', icon: BookOpen },
  { path: '/advisor', label: 'AI Advisor', icon: Brain },
  { path: '/backtest', label: 'Backtest', icon: FlaskConical },
  { path: '/strategy-builder', label: 'Strategy Builder', icon: Code2 },
  { path: '/strategy-review', label: 'Strategy Review', icon: ClipboardList },
  { path: '/settings', label: 'Settings', icon: Settings },
];

// TDA-007 collapses the USER-visible app to four product sections. This Set is
// the single source of truth for what a non-ADMIN sees; everything else is
// ADMIN-only. Treat null/unknown roles as USER (fail closed) so a missing or
// malformed role never leaks the full nav.
const USER_VISIBLE = new Set(['/', '/intraday', '/swing', '/positions', '/portfolio', '/payments', '/market', '/charts', '/settings']);

export function visibleNavItems(role: string | null | undefined): NavItem[] {
  if (role === 'ADMIN') return navItems;
  return navItems.filter((i) => USER_VISIBLE.has(i.path));
}
