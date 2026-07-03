/**
 * Razorpay Checkout loader + open helper (TDA-015 §9).
 *
 * Razorpay's `checkout.js` is the ONE allowed exception to the app's
 * self-containment rule — it is loaded lazily from Razorpay's CDN at click
 * time (never bundled), so no card/UPI data ever touches our origin (SAQ-A).
 * The loader is idempotent: it reuses an already-present global / in-flight
 * `<script>` so repeated checkout attempts never inject duplicates.
 */

const CHECKOUT_JS_URL = 'https://checkout.razorpay.com/v1/checkout.js';
const SCRIPT_ID = 'razorpay-checkout-js';

/** Minimal shape of the Razorpay Checkout options we use (subscription flow). */
export interface RazorpayCheckoutOptions {
  key: string;
  subscription_id: string;
  name?: string;
  description?: string;
  handler?: (response: RazorpaySuccessResponse) => void;
  prefill?: { name?: string; email?: string; contact?: string };
  theme?: { color?: string };
  modal?: { ondismiss?: () => void };
}

/** Payload Razorpay hands the success handler after mandate authorization. */
export interface RazorpaySuccessResponse {
  razorpay_payment_id?: string;
  razorpay_subscription_id?: string;
  razorpay_signature?: string;
}

interface RazorpayInstance {
  open(): void;
  on?(event: string, cb: (resp: unknown) => void): void;
}

type RazorpayConstructor = new (options: RazorpayCheckoutOptions) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

let loadPromise: Promise<RazorpayConstructor> | null = null;

/**
 * Inject `checkout.js` once and resolve with the `Razorpay` constructor.
 * If it is already present (global set) we resolve immediately; a concurrent
 * call reuses the same in-flight promise.
 */
export function loadRazorpayCheckout(): Promise<RazorpayConstructor> {
  if (typeof window !== 'undefined' && window.Razorpay) {
    return Promise.resolve(window.Razorpay);
  }
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<RazorpayConstructor>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;

    const onReady = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error('Razorpay checkout loaded but global is unavailable'));
    };

    if (existing) {
      if (window.Razorpay) {
        resolve(window.Razorpay);
      } else {
        existing.addEventListener('load', onReady, { once: true });
        existing.addEventListener(
          'error',
          () => reject(new Error('Failed to load Razorpay checkout')),
          { once: true },
        );
      }
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = CHECKOUT_JS_URL;
    script.async = true;
    script.onload = onReady;
    script.onerror = () => {
      loadPromise = null; // allow a later retry after a transient CDN failure
      reject(new Error('Failed to load Razorpay checkout'));
    };
    document.body.appendChild(script);
  });

  return loadPromise;
}

export interface OpenCheckoutInput {
  /** Razorpay public key id (from the checkout response — never a secret). */
  keyId: string;
  /** Razorpay subscription id to authorize (recurring e-mandate flow). */
  subscriptionId: string;
  /** Prefill the customer email on the Razorpay modal. */
  email?: string;
  /** Fired after the user completes mandate authorization. */
  onSuccess?: (response: RazorpaySuccessResponse) => void;
  /** Fired when the user closes the modal without authorizing. */
  onDismiss?: () => void;
}

/**
 * Load `checkout.js` (if needed) and open the Razorpay modal for a
 * subscription authorization. Access is NOT granted here — it flips only when
 * the signature-verified webhook confirms the first charge (spec §4/§5).
 */
export async function openCheckout(input: OpenCheckoutInput): Promise<void> {
  const Razorpay = await loadRazorpayCheckout();
  const rzp = new Razorpay({
    key: input.keyId,
    subscription_id: input.subscriptionId,
    name: 'GrW',
    description: 'Subscription',
    prefill: input.email ? { email: input.email } : undefined,
    theme: { color: '#2563eb' },
    handler: (response) => input.onSuccess?.(response),
    modal: { ondismiss: () => input.onDismiss?.() },
  });
  rzp.open();
}
