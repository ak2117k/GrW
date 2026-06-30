import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { verifyEmail } from '@/services/auth';
import { extractVerifyToken } from './extractVerifyToken';

type Status = 'verifying' | 'success' | 'failure';

export default function VerifyEmailPage() {
  const location = useLocation();
  const token = extractVerifyToken(location.search);

  // No token in the URL → nothing to verify; don't call the API.
  const [status, setStatus] = useState<Status>(
    token ? 'verifying' : 'failure',
  );
  const posted = useRef(false);

  useEffect(() => {
    if (!token) return;
    // Guard against React StrictMode's double-invoke so the token posts once.
    if (posted.current) return;
    posted.current = true;

    // The `posted` ref already guarantees a single POST across StrictMode's
    // double-invoke/remount, so update status unconditionally. A per-run
    // cleanup flag would drop the update when run 1's cleanup fires before
    // the POST resolves; React no-ops a stray set on a truly-unmounted tree.
    verifyEmail(token)
      .then(() => setStatus('success'))
      .catch(() => setStatus('failure'));
  }, [token]);

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
            Email verification
          </p>
        </div>

        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-6 shadow-xl">
          {status === 'verifying' && (
            <div className="flex flex-col items-center gap-4 text-center">
              <Loader2
                size={32}
                className="animate-spin text-[var(--color-accent-blue)]"
              />
              <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
                Verifying your email…
              </h2>
              <p className="text-sm text-[var(--color-text-muted)]">
                This will only take a moment.
              </p>
            </div>
          )}

          {status === 'success' && (
            <div className="flex flex-col items-center gap-4 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-accent-blue)]/10 text-[var(--color-accent-blue)]">
                <CheckCircle2 size={28} />
              </span>
              <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
                Email verified
              </h2>
              <p className="text-sm text-[var(--color-text-muted)]">
                Your email is confirmed. You can now sign in to your account.
              </p>
              <Link
                to="/login"
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-accent-blue)] px-4 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
              >
                Sign in
              </Link>
            </div>
          )}

          {status === 'failure' && (
            <div className="flex flex-col items-center gap-4 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-accent-red)]/10 text-[var(--color-accent-red)]">
                <XCircle size={28} />
              </span>
              <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
                {token ? 'Link invalid or expired' : 'Invalid link'}
              </h2>
              <p className="text-sm text-[var(--color-text-muted)]">
                {token
                  ? 'This verification link is invalid or has expired. Please sign up again to receive a new link.'
                  : 'This verification link is missing or malformed. Please sign up again to receive a new link.'}
              </p>
              <Link
                to="/signup"
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-accent-blue)] px-4 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
              >
                Back to sign up
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
