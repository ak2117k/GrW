import { useState } from 'react';
import toast from 'react-hot-toast';
import { useBilling, type BillingSegment } from '../../hooks/useBilling';
import { useAuthStore } from '../../stores/auth-store';

const SEGMENT_KEY: Record<'Intraday' | 'Swing', BillingSegment> = {
  Intraday: 'INTRADAY',
  Swing: 'SWING',
};

/**
 * Card shown to an unsubscribed USER in place of a segment's signals table
 * (TDA-007 gate). TDA-015 replaces the "Checkout coming soon" stub with a real
 * Razorpay subscription checkout: POST /api/me/billing/checkout → open the
 * Razorpay modal. Access flips only when the webhook confirms the first charge,
 * so on success we show "activating…" and let the page re-poll subscriptions.
 */
export function SubscribeCard({ segment }: { segment: 'Intraday' | 'Swing' }) {
  const { startCheckout, busy } = useBilling();
  const email = useAuthStore((s) => s.user?.email);
  const [activating, setActivating] = useState(false);
  const key = SEGMENT_KEY[segment];
  const isBusy = busy === key;

  const onSubscribe = async () => {
    try {
      await startCheckout(key, email ?? undefined);
      // The modal has been handed off; the webhook grants access shortly.
      setActivating(true);
      toast('Activating your subscription — this can take a moment after payment.');
    } catch {
      toast.error('Could not start checkout. Please try again.');
    }
  };

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-8 text-center">
      <h2 className="text-lg font-semibold mb-2">Subscribe to {segment}</h2>
      <p className="text-sm text-[var(--color-text-muted)] mb-4">
        Get {segment} signals and auto-execution for your account.
      </p>
      <button
        className="rounded bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onSubscribe}
        disabled={isBusy || activating}
      >
        {isBusy ? 'Opening checkout…' : activating ? 'Activating…' : 'Subscribe'}
      </button>
      {activating && (
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          Once your payment is confirmed, your {segment} access turns on
          automatically — you can refresh this page in a minute.
        </p>
      )}
    </div>
  );
}
