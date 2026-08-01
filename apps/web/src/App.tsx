import { useEffect, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AppLayout } from '@/components/layout';
import { wsService } from '@/services/websocket';
import { useAuthStore } from '@/stores/auth-store';
import LoginPage from '@/pages/login/LoginPage';
import DashboardPage from '@/pages/dashboard/DashboardPage';
import UserDashboardPage from '@/pages/dashboard/UserDashboardPage';
import PaymentsPage from '@/pages/payments/PaymentsPage';
import ChartsPage from '@/pages/charts/ChartsPage';
import MarketPage from '@/pages/market/MarketPage';
import OptionsPage from '@/pages/options/OptionsPage';
import SignalsPage from '@/pages/signals/SignalsPage';
import RejectionsPage from '@/pages/signals/RejectionsPage';
import ChartinkPage from '@/pages/chartink/ChartinkPage';
import AutoTradePage from '@/pages/auto-trade/AutoTradePage';
import ManualTradePage from '@/pages/manual-trade/ManualTradePage';
import PositionsPage from '@/pages/positions/PositionsPage';
import PortfolioPage from '@/pages/portfolio/PortfolioPage';
import MonitorPage from '@/pages/monitor/MonitorPage';
import NewsPage from '@/pages/news/NewsPage';
import JournalPage from '@/pages/journal/JournalPage';
import AdvisorPage from '@/pages/advisor/AdvisorPage';
import BacktestPage from '@/pages/backtest/BacktestPage';
import StrategyBuilderPage from '@/pages/strategy-builder/StrategyBuilderPage';
import { StrategyReviewPage } from '@/pages/strategy-review/StrategyReviewPage';
import SettingsPage from '@/pages/settings/SettingsPage';
import { WatchPage } from '@/pages/watch/WatchPage';
import { UngatedWatchPage } from '@/pages/ungated-watch/UngatedWatchPage';
import { AdaptiveStopPage } from '@/pages/adaptive-stop/AdaptiveStopPage';
import IntradayPage from '@/pages/intraday/IntradayPage';
import SwingPage from '@/pages/swing/SwingPage';
import BreakoutSwingPage from '@/pages/breakout-swing/BreakoutSwingPage';
import { SellFuturesPage } from '@/pages/sell-futures/SellFuturesPage';
import ReinvestPage from '@/pages/reinvest/ReinvestPage';
import LandingPage from '@/pages/landing/LandingPage';
import SignupPage from '@/pages/signup/SignupPage';
import VerifyEmailPage from '@/pages/verify-email/VerifyEmailPage';
import TelegramSignalsPage from '@/pages/telegram/TelegramSignalsPage';

// Gate the authenticated app. While the stored session is being verified we
// show a minimal loader; once resolved we either render children or bounce to
// /login (remembering where the user was headed via location state).
function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--color-bg-primary)] text-sm text-[var(--color-text-muted)]">
        Loading…
      </div>
    );
  }

  if (status === 'anon') {
    return <Navigate to="/welcome" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}

// Role gate for individual routes. A user whose role does not match (including
// a null/unknown role) is bounced to /intraday — fail-closed: only the literal
// expected role passes. Sits inside RequireAuth, so the user is already authed.
function RequireRole({ role, children }: { role: string; children: ReactNode }) {
  const userRole = useAuthStore((s) => s.user?.role);
  if (userRole !== role) return <Navigate to="/intraday" replace />;
  return <>{children}</>;
}

// Role-aware element switch (used for the index route): renders `admin` for an
// ADMIN, otherwise `user`. Anything that is not the literal 'ADMIN' gets `user`.
function RequireRoleSwitch({ admin, user }: { admin: ReactNode; user: ReactNode }) {
  const role = useAuthStore((s) => s.user?.role);
  return <>{role === 'ADMIN' ? admin : user}</>;
}

// Authenticated users hitting /login get sent home. While loading, render
// nothing decisive (the login form is harmless to show briefly).
function LoginRoute() {
  const status = useAuthStore((s) => s.status);
  if (status === 'authed') return <Navigate to="/" replace />;
  return <LoginPage />;
}

// Mirror of LoginRoute for the public marketing/auth routes: authenticated
// users hitting /welcome or /signup get sent home; everyone else sees them.
function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  if (status === 'authed') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const hydrate = useAuthStore((s) => s.hydrate);
  const authStatus = useAuthStore((s) => s.status);

  // Verify any stored session once on boot (loads tokens from localStorage,
  // calls /auth/me to populate the user, marks authed/anon accordingly).
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Open the live-data WebSocket when (and only when) we hold a session, and
  // close it on logout. Driven off auth STATUS rather than mount: the gateways
  // reject a handshake without a JWT and socket.io treats that rejection as
  // terminal, so connecting at boot — before hydrate/login has a token — left
  // the tick feed permanently dead. Firing on 'authed' covers both paths into a
  // session (boot with a stored token, and a fresh sign-in). connect() is
  // idempotent, so the per-page connect() calls (AutoTrade, charts, trades)
  // remain harmless no-ops.
  useEffect(() => {
    if (authStatus === 'authed') {
      wsService.connect();
    } else if (authStatus === 'anon') {
      wsService.disconnect();
    }
  }, [authStatus]);

  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      {/* TDA-014: public routes */}
      <Route
        path="/welcome"
        element={
          <RedirectIfAuthed>
            <LandingPage />
          </RedirectIfAuthed>
        }
      />
      <Route
        path="/signup"
        element={
          <RedirectIfAuthed>
            <SignupPage />
          </RedirectIfAuthed>
        }
      />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route
          index
          element={
            <RequireRoleSwitch admin={<DashboardPage />} user={<UserDashboardPage />} />
          }
        />
        <Route path="charts" element={<ChartsPage />} />
        <Route path="market" element={<MarketPage />} />
        <Route path="options" element={<RequireRole role="ADMIN"><OptionsPage /></RequireRole>} />
        <Route path="signals" element={<RequireRole role="ADMIN"><SignalsPage /></RequireRole>} />
        <Route path="rejections" element={<RequireRole role="ADMIN"><RejectionsPage /></RequireRole>} />
        <Route path="chartink" element={<RequireRole role="ADMIN"><ChartinkPage /></RequireRole>} />
        <Route path="telegram" element={<RequireRole role="ADMIN"><TelegramSignalsPage /></RequireRole>} />
        <Route path="watch" element={<RequireRole role="ADMIN"><WatchPage /></RequireRole>} />
        <Route path="ungated-watch" element={<RequireRole role="ADMIN"><UngatedWatchPage /></RequireRole>} />
        <Route path="adaptive-stop" element={<RequireRole role="ADMIN"><AdaptiveStopPage /></RequireRole>} />
        <Route path="intraday" element={<IntradayPage />} />
        <Route path="swing" element={<SwingPage />} />
        <Route path="breakout-swing" element={<RequireRole role="ADMIN"><BreakoutSwingPage /></RequireRole>} />
        <Route path="sell-futures" element={<RequireRole role="ADMIN"><SellFuturesPage /></RequireRole>} />
        <Route path="reinvest" element={<RequireRole role="ADMIN"><ReinvestPage /></RequireRole>} />
        <Route path="auto-trade" element={<RequireRole role="ADMIN"><AutoTradePage /></RequireRole>} />
        <Route path="manual-trade" element={<RequireRole role="ADMIN"><ManualTradePage /></RequireRole>} />
        <Route path="positions" element={<PositionsPage />} />
        <Route path="portfolio" element={<PortfolioPage />} />
        <Route path="monitor" element={<MonitorPage />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="news" element={<RequireRole role="ADMIN"><NewsPage /></RequireRole>} />
        <Route path="journal" element={<RequireRole role="ADMIN"><JournalPage /></RequireRole>} />
        <Route path="advisor" element={<RequireRole role="ADMIN"><AdvisorPage /></RequireRole>} />
        <Route path="backtest" element={<RequireRole role="ADMIN"><BacktestPage /></RequireRole>} />
        <Route path="strategy-builder" element={<RequireRole role="ADMIN"><StrategyBuilderPage /></RequireRole>} />
        <Route path="strategy-review" element={<RequireRole role="ADMIN"><StrategyReviewPage /></RequireRole>} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
