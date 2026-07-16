/**
 * Every webhook route registered in this app. All of them are STATIC — the
 * shared secret each one authenticates with travels in a header, never in the
 * URL — so any path under `/webhooks/` that is not exactly one of these carries
 * untrusted input and must not be logged verbatim.
 *
 * Adding a webhook route? Add it here too, or its path will be redacted in the
 * logs. That is the safe direction to fail, which is why the list is a hardcoded
 * allowlist rather than something derived from the router at runtime.
 */
export const KNOWN_WEBHOOK_ROUTES: readonly string[] = [
  '/webhooks/razorpay',
  '/webhooks/chartink',
  '/webhooks/ml/backfill',
  '/webhooks/ml/resolve-pending',
];

const WEBHOOK_PREFIX = '/webhooks/';
const REDACTED = '<redacted>';

/**
 * Scrub anything secret-shaped out of a request path before it is logged.
 *
 * Webhook controllers are `@Public()` and authenticate on a shared secret, so
 * that secret IS the auth boundary. It now travels in a header, which keeps it
 * out of the URL for any well-behaved caller. This guards the rest: a stale
 * heartbeat still POSTing the retired `/webhooks/<provider>/<secret>` shape gets
 * a 404, and a 404 is logged with its URL — leaking the secret the header
 * migration was meant to protect.
 *
 * Scoped deliberately: non-webhook paths are returned untouched so this costs no
 * observability anywhere else. Total, never throws — it runs inside the global
 * exception filter, and throwing there would break the error path itself.
 */
export function redactSecretPath(url: string): string {
  if (typeof url !== 'string' || !url.startsWith(WEBHOOK_PREFIX)) return url;

  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);

  // A known static route is secret-free by design. Its query string is not — no
  // webhook route takes query params, so anything there is unexpected input.
  if (KNOWN_WEBHOOK_ROUTES.includes(path)) {
    return queryStart === -1 ? path : `${path}?${REDACTED}`;
  }

  // Extra segments past a known route: keep the route (the useful half — it
  // distinguishes backfill from resolve-pending) and redact the rest. Longest
  // match wins so `/webhooks/ml/backfill` beats a shorter prefix.
  const matched = KNOWN_WEBHOOK_ROUTES.filter((route) => path.startsWith(`${route}/`)).sort(
    (a, b) => b.length - a.length,
  )[0];
  if (matched) return `${matched}/${REDACTED}`;

  // Unrecognised shape under /webhooks/ — we cannot tell which segment is the
  // secret, so none of it survives.
  return `${WEBHOOK_PREFIX}${REDACTED}`;
}

/**
 * A webhook path appearing ANYWHERE inside a free-text string. Stops at
 * whitespace and the usual quoting/punctuation that ends a URL in prose, so the
 * surrounding message survives intact.
 */
const WEBHOOK_PATH_IN_TEXT = /\/webhooks\/[^\s"'`,)\]}]*/g;

/**
 * Redact webhook secrets embedded in arbitrary text — log messages, exception
 * messages, stack traces.
 *
 * {@link redactSecretPath} only helps when the string IS a path. That is not the
 * only place a path shows up: Nest generates its own message for an unmatched
 * route — `Cannot POST /webhooks/ml/backfill/<secret>` — and that message then
 * travels into the log line, the exception's stack, and the JSON error body. A
 * stale caller using the retired path-secret URL therefore leaked its secret
 * three ways while `request.url` sat redacted right next to it.
 *
 * Total and never throws: this runs inside the global exception filter, where an
 * error would break the error path itself.
 */
export function redactSecretsInText(text: string): string {
  if (typeof text !== 'string' || !text.includes(WEBHOOK_PREFIX)) return text;
  return text.replace(WEBHOOK_PATH_IN_TEXT, (match) => redactSecretPath(match));
}
