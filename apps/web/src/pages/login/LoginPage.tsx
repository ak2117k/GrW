import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Lock, Mail, ShieldCheck, Loader2 } from 'lucide-react';
import { login, loginMfa, getMe, isMfaChallenge } from '@/services/auth';
import { classifyLoginError } from './loginError';
import { useAuthStore } from '@/stores/auth-store';

interface LocationState {
  from?: { pathname?: string };
}

/**
 * After this many ms of a pending request, hint that the (free-tier) server may
 * be cold-starting — so a multi-second wait reads as "waking up", not "hung".
 */
const WAKING_HINT_DELAY_MS = 5000;

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const setTokens = useAuthStore((s) => s.setTokens);
  const setUser = useAuthStore((s) => s.setUser);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as LocationState | null)?.from?.pathname || '/';

  // While a request is in flight past WAKING_HINT_DELAY_MS, surface the
  // cold-start hint so a long wait doesn't look like a frozen form.
  useEffect(() => {
    if (!submitting) {
      setWaking(false);
      return;
    }
    const t = setTimeout(() => setWaking(true), WAKING_HINT_DELAY_MS);
    return () => clearTimeout(t);
  }, [submitting]);

  async function finishLogin(accessToken: string, refreshToken: string) {
    setTokens({ accessToken, refreshToken });
    try {
      const user = await getMe(accessToken);
      setUser(user);
    } catch {
      // Profile fetch failed but tokens are valid — proceed; hydrate/guards
      // will reconcile. Mark authed via setUser fallback is not possible, so
      // we still navigate; the next protected call refreshes state.
    }
    navigate(from, { replace: true });
  }

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await login(email.trim(), password);
      if (isMfaChallenge(result)) {
        setMfaToken(result.mfaToken);
      } else {
        await finishLogin(result.accessToken, result.refreshToken);
      }
    } catch (err) {
      setError(classifyLoginError(err, 'Unable to sign in. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMfaSubmit(e: FormEvent) {
    e.preventDefault();
    if (!mfaToken) return;
    setError(null);
    setSubmitting(true);
    try {
      const pair = await loginMfa(mfaToken, code.trim());
      await finishLogin(pair.accessToken, pair.refreshToken);
    } catch (err) {
      setError(classifyLoginError(err, 'Invalid code. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-primary)] px-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="mb-8 text-center">
          <span className="text-3xl font-bold tracking-tight text-[var(--color-text-primary)]">
            Gr<span className="text-[var(--color-accent-blue)]">W</span>
          </span>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            {mfaToken ? 'Two-factor authentication' : 'Sign in to your account'}
          </p>
        </div>

        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-6 shadow-xl">
          {error && (
            <div className="mb-4 rounded-lg border border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red)]/10 px-3 py-2 text-sm text-[var(--color-accent-red)]">
              {error}
            </div>
          )}

          {waking && submitting && !error && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-[var(--color-accent-blue)]/40 bg-[var(--color-accent-blue)]/10 px-3 py-2 text-sm text-[var(--color-text-muted)]">
              <Loader2 size={14} className="animate-spin shrink-0" />
              <span>Waking up the server — this can take up to a minute…</span>
            </div>
          )}

          {!mfaToken ? (
            <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  Email
                </span>
                <div className="relative">
                  <Mail
                    size={16}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                  />
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] py-2.5 pl-9 pr-3 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent-blue)]"
                  />
                </div>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  Password
                </span>
                <div className="relative">
                  <Lock
                    size={16}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                  />
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] py-2.5 pl-9 pr-3 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent-blue)]"
                  />
                </div>
              </label>

              <button
                type="submit"
                disabled={submitting}
                className="mt-2 flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent-blue)] px-4 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting && <Loader2 size={16} className="animate-spin" />}
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleMfaSubmit} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  Authentication code
                </span>
                <div className="relative">
                  <ShieldCheck
                    size={16}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="123456"
                    className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] py-2.5 pl-9 pr-3 text-sm tracking-[0.3em] text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent-blue)]"
                  />
                </div>
              </label>

              <button
                type="submit"
                disabled={submitting}
                className="mt-2 flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent-blue)] px-4 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting && <Loader2 size={16} className="animate-spin" />}
                {submitting ? 'Verifying…' : 'Verify'}
              </button>

              <button
                type="button"
                onClick={() => {
                  setMfaToken(null);
                  setCode('');
                  setError(null);
                }}
                className="text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
              >
                ← Back to sign in
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
