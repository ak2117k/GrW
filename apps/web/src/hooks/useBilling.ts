import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import { openCheckout } from '../services/razorpay-checkout';

/**
 * useBilling (TDA-015 §9) — thin wrapper over the `/api/me/billing` surface:
 * per-segment billing status + the checkout/cancel calls. Access itself is
 * still read via `useSubscriptions`; this hook adds the *why* (status, renewal
 * date, dunning grace) and the actions that drive Razorpay checkout.
 *
 * The pure selectors below (request shaping + status→banner mapping) are
 * unit-tested (Vitest, no jsdom) exactly like `useConsent.needsConsent` and
 * `useSubscriptions.shouldShowSubscribeCard`.
 */

export type BillingSegment = 'INTRADAY' | 'SWING';

/** Reuses the `SubscriptionStatus` enum; `NONE` = no row / never subscribed. */
export type BillingSegmentStatus =
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'NONE';

/** Per-segment billing state as surfaced by `GET /api/me/billing`. */
export interface BillingSegmentState {
  segment: BillingSegment;
  status: BillingSegmentStatus;
  /** Paid-through instant (drives the renewal date shown to the user). */
  expiresAt: string | null;
  /** Dunning window end when a renewal payment failed (spec §6). */
  graceUntil: string | null;
}

/** The `checkout` payload returned by `POST /api/me/billing/checkout` (spec §3). */
export interface CheckoutPayload {
  keyId: string;
  subscriptionId: string;
  shortUrl?: string;
}

interface CheckoutResponse {
  providerSubId?: string;
  providerPlanId?: string;
  checkout: CheckoutPayload;
}

// ---- Pure selectors (unit-tested) ----

/** The request the checkout button issues: `POST /me/billing/checkout { segment }`. */
export function buildCheckoutRequest(segment: BillingSegment): {
  url: string;
  body: { segment: BillingSegment };
} {
  return { url: '/me/billing/checkout', body: { segment } };
}

/** The cancel request: `POST /me/billing/cancel { segment }` (at cycle end). */
export function buildCancelRequest(segment: BillingSegment): {
  url: string;
  body: { segment: BillingSegment };
} {
  return { url: '/me/billing/cancel', body: { segment } };
}

/**
 * A failed renewal keeps access until `expiresAt` while Razorpay retries; the
 * UI shows a "payment failed — update your mandate" banner during that window.
 * Grace is active when the row is still `ACTIVE` but a future `graceUntil` is
 * set (spec §6). `now` is injectable for deterministic tests.
 */
export function isInGrace(state: BillingSegmentState, now: number = Date.now()): boolean {
  if (state.status !== 'ACTIVE' || !state.graceUntil) return false;
  const until = new Date(state.graceUntil).getTime();
  return !Number.isNaN(until) && until > now;
}

export type BillingTone = 'success' | 'warning' | 'danger' | 'neutral';

/** A presentational view model for one segment's billing state. */
export interface BillingView {
  segment: BillingSegment;
  /** Badge text, e.g. "Active", "Payment failed", "Expired", "Not subscribed". */
  label: string;
  tone: BillingTone;
  /** Whether the dunning/grace banner should render. */
  showGraceBanner: boolean;
  /** Whether a Cancel (at cycle end) action applies. */
  canCancel: boolean;
  /** Whether a Subscribe action applies. */
  canSubscribe: boolean;
  /** The renewal/expiry instant to display (ISO), or null. */
  renewalAt: string | null;
}

/**
 * status → banner/label mapping. The single place that decides how each
 * `SubscriptionStatus` reads in the billing UI. Kept pure so the mapping is
 * locked by unit tests (spec §9: ACTIVE / grace-dunning / expired states).
 */
export function describeSegmentBilling(
  state: BillingSegmentState,
  now: number = Date.now(),
): BillingView {
  const grace = isInGrace(state, now);
  const base: BillingView = {
    segment: state.segment,
    label: 'Not subscribed',
    tone: 'neutral',
    showGraceBanner: false,
    canCancel: false,
    canSubscribe: true,
    renewalAt: state.expiresAt,
  };

  switch (state.status) {
    case 'ACTIVE':
      return {
        ...base,
        label: grace ? 'Payment failed' : 'Active',
        tone: grace ? 'warning' : 'success',
        showGraceBanner: grace,
        canCancel: true,
        canSubscribe: false,
      };
    case 'PAST_DUE':
      // Set at checkout (authorization pending) — no access yet.
      return {
        ...base,
        label: 'Awaiting payment',
        tone: 'warning',
        canCancel: true,
        canSubscribe: false,
      };
    case 'EXPIRED':
      return { ...base, label: 'Expired', tone: 'danger', canSubscribe: true };
    case 'CANCELLED':
      return { ...base, label: 'Cancelled', tone: 'neutral', canSubscribe: true };
    case 'NONE':
    default:
      return base;
  }
}

/**
 * Normalize a raw `GET /api/me/billing` response into a `{ INTRADAY, SWING }`
 * map. Tolerant of the exact response shape (array of segments OR a keyed
 * object) so a thin backend field mismatch degrades to `NONE`, never a crash.
 */
export function normalizeBillingResponse(raw: unknown): Record<BillingSegment, BillingSegmentState> {
  const empty = (segment: BillingSegment): BillingSegmentState => ({
    segment,
    status: 'NONE',
    expiresAt: null,
    graceUntil: null,
  });
  const out: Record<BillingSegment, BillingSegmentState> = {
    INTRADAY: empty('INTRADAY'),
    SWING: empty('SWING'),
  };
  if (!raw || typeof raw !== 'object') return out;

  const record = raw as Record<string, unknown>;
  // Accept either { segments: {...} | [...] } or a top-level keyed object.
  const container = (record.segments ?? record) as unknown;

  const apply = (segment: BillingSegment, value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    const status = typeof v.status === 'string' ? (v.status as string).toUpperCase() : 'NONE';
    out[segment] = {
      segment,
      status: (['ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED', 'NONE'].includes(status)
        ? status
        : 'NONE') as BillingSegmentStatus,
      expiresAt: typeof v.expiresAt === 'string' ? v.expiresAt : null,
      graceUntil: typeof v.graceUntil === 'string' ? v.graceUntil : null,
    };
  };

  if (Array.isArray(container)) {
    for (const item of container) {
      const seg = (item as Record<string, unknown>)?.segment;
      if (seg === 'INTRADAY' || seg === 'SWING') apply(seg, item);
    }
  } else if (container && typeof container === 'object') {
    const c = container as Record<string, unknown>;
    apply('INTRADAY', c.INTRADAY ?? c.intraday);
    apply('SWING', c.SWING ?? c.swing);
  }
  return out;
}

// ---- Hook ----

export interface UseBilling {
  states: Record<BillingSegment, BillingSegmentState>;
  loading: boolean;
  /** The segment a checkout/cancel action is currently in-flight for. */
  busy: BillingSegment | null;
  refresh: () => Promise<void>;
  startCheckout: (segment: BillingSegment, email?: string) => Promise<void>;
  cancel: (segment: BillingSegment) => Promise<void>;
}

const EMPTY: Record<BillingSegment, BillingSegmentState> = {
  INTRADAY: { segment: 'INTRADAY', status: 'NONE', expiresAt: null, graceUntil: null },
  SWING: { segment: 'SWING', status: 'NONE', expiresAt: null, graceUntil: null },
};

export function useBilling(): UseBilling {
  const [states, setStates] = useState<Record<BillingSegment, BillingSegmentState>>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<BillingSegment | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/me/billing');
      setStates(normalizeBillingResponse(data));
    } catch {
      setStates(EMPTY);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let on = true;
    void (async () => {
      if (on) await refresh();
    })();
    return () => {
      on = false;
    };
  }, [refresh]);

  const startCheckout = useCallback(
    async (segment: BillingSegment, email?: string) => {
      setBusy(segment);
      try {
        const req = buildCheckoutRequest(segment);
        const { data } = await api.post<CheckoutResponse>(req.url, req.body);
        await openCheckout({
          keyId: data.checkout.keyId,
          subscriptionId: data.checkout.subscriptionId,
          email,
          onSuccess: () => {
            // Access flips only when the webhook confirms the charge; re-poll.
            void refresh();
          },
          onDismiss: () => {
            void refresh();
          },
        });
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const cancel = useCallback(
    async (segment: BillingSegment) => {
      setBusy(segment);
      try {
        const req = buildCancelRequest(segment);
        await api.post(req.url, req.body);
        await refresh();
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return { states, loading, busy, refresh, startCheckout, cancel };
}
