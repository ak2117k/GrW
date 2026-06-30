import toast from 'react-hot-toast';

/**
 * Placeholder card shown to an unsubscribed USER in place of a segment's
 * signals table. The CTA is a stub until checkout lands (TDA-007 follow-up).
 */
export function SubscribeCard({ segment }: { segment: 'Intraday' | 'Swing' }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-8 text-center">
      <h2 className="text-lg font-semibold mb-2">Subscribe to {segment}</h2>
      <p className="text-sm text-[var(--color-text-muted)] mb-4">
        Get {segment} signals and auto-execution for your account.
      </p>
      <button
        className="rounded bg-blue-600 px-4 py-2 text-white"
        onClick={() => toast('Checkout coming soon')}
      >
        Subscribe
      </button>
    </div>
  );
}
