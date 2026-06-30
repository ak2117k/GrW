import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AxiosError } from 'axios';
import { Mail, Lock, User, MailCheck, Loader2 } from 'lucide-react';
import { signup } from '@/services/auth';
import { validateSignup, type SignupErrors } from './validateSignup';

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    if (status === 429)
      return 'Too many attempts. Please wait and try again.';
    const msg = err.response?.data?.message;
    if (typeof msg === 'string') return msg;
    if (Array.isArray(msg) && msg.length) return String(msg[0]);
  }
  return fallback;
}

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [errors, setErrors] = useState<SignupErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedName = displayName.trim();
    const fieldErrors = validateSignup({
      email: email.trim(),
      password,
      confirm,
      displayName: trimmedName || undefined,
    });
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    setSubmitting(true);
    try {
      await signup(email.trim(), password, trimmedName || undefined);
      // Non-enumerating: any success renders the same confirmation regardless
      // of whether the email was already registered.
      setSubmitted(true);
    } catch (err) {
      setError(errorMessage(err, 'Unable to sign up. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-primary)] px-4 py-12">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="mb-8 text-center">
          <Link to="/welcome">
            <span className="text-3xl font-bold tracking-tight text-[var(--color-text-primary)]">
              TD<span className="text-[var(--color-accent-blue)]">Auto</span>
            </span>
          </Link>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            {submitted ? 'Check your email' : 'Create your account'}
          </p>
        </div>

        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-6 shadow-xl">
          {submitted ? (
            <div className="flex flex-col items-center gap-4 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-accent-blue)]/10 text-[var(--color-accent-blue)]">
                <MailCheck size={24} />
              </span>
              <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
                Check your email
              </h2>
              <p className="text-sm text-[var(--color-text-muted)]">
                If that email address can be registered, we&apos;ve sent a
                verification link to it. Open the link to finish setting up your
                account.
              </p>
              <Link
                to="/login"
                className="mt-2 text-sm font-medium text-[var(--color-accent-blue)] transition-colors hover:opacity-90"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              {error && (
                <div className="mb-4 rounded-lg border border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red)]/10 px-3 py-2 text-sm text-[var(--color-accent-red)]">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
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
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] py-2.5 pl-9 pr-3 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent-blue)]"
                    />
                  </div>
                  {errors.email && (
                    <span className="text-xs text-[var(--color-accent-red)]">
                      {errors.email}
                    </span>
                  )}
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
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] py-2.5 pl-9 pr-3 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent-blue)]"
                    />
                  </div>
                  {errors.password && (
                    <span className="text-xs text-[var(--color-accent-red)]">
                      {errors.password}
                    </span>
                  )}
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    Confirm password
                  </span>
                  <div className="relative">
                    <Lock
                      size={16}
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                    />
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder="••••••••"
                      className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] py-2.5 pl-9 pr-3 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent-blue)]"
                    />
                  </div>
                  {errors.confirm && (
                    <span className="text-xs text-[var(--color-accent-red)]">
                      {errors.confirm}
                    </span>
                  )}
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    Display name{' '}
                    <span className="normal-case text-[var(--color-text-muted)]">
                      (optional)
                    </span>
                  </span>
                  <div className="relative">
                    <User
                      size={16}
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                    />
                    <input
                      type="text"
                      autoComplete="name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Your name"
                      className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] py-2.5 pl-9 pr-3 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent-blue)]"
                    />
                  </div>
                  {errors.displayName && (
                    <span className="text-xs text-[var(--color-accent-red)]">
                      {errors.displayName}
                    </span>
                  )}
                </label>

                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-2 flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent-blue)] px-4 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting && <Loader2 size={16} className="animate-spin" />}
                  {submitting ? 'Creating account…' : 'Create account'}
                </button>
              </form>

              <p className="mt-5 text-center text-sm text-[var(--color-text-muted)]">
                Already have an account?{' '}
                <Link
                  to="/login"
                  className="font-medium text-[var(--color-accent-blue)] transition-colors hover:opacity-90"
                >
                  Sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
