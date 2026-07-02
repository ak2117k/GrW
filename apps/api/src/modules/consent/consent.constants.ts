/**
 * TDA-009 versioned-consent constants.
 *
 * The MVP has a single consent kind — a combined disclaimer + risk disclosure.
 * `getCurrent`/`getStatus`/`hasAcceptedCurrent`/`revoke` all default to it.
 */
export const RISK_DISCLOSURE = 'risk-disclosure';

/**
 * Stable error codes surfaced to clients (spec §4.1 / §5 / §7). Kept as string
 * literals so both the service (409/404 bodies) and the guard (403 body) can
 * emit them without a shared enum ceremony.
 */
export const CONSENT_ERRORS = {
  /** No active disclosure document exists for the kind (404 read / 409 accept). */
  NO_ACTIVE_CONSENT: 'NO_ACTIVE_CONSENT',
  /** The accepted `version` is not the currently-active one (409). */
  CONSENT_VERSION_STALE: 'CONSENT_VERSION_STALE',
  /** The document body no longer hashes to its stored/echoed contentHash (409). */
  CONSENT_CONTENT_MISMATCH: 'CONSENT_CONTENT_MISMATCH',
  /** The gate: caller has not accepted the current version (403, from the guard). */
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
} as const;

export type ConsentErrorCode =
  (typeof CONSENT_ERRORS)[keyof typeof CONSENT_ERRORS];
