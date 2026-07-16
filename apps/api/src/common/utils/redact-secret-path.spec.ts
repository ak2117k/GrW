import { redactSecretPath, KNOWN_WEBHOOK_ROUTES } from './redact-secret-path';

/**
 * Webhook secrets must never reach the logs — logs ship to a third party and a
 * webhook secret is the entire auth boundary for a @Public() endpoint.
 *
 * The controllers now take their secret from a header, so a well-behaved caller
 * never puts one in the URL. This helper exists for the callers that are NOT
 * well-behaved: a stale heartbeat still POSTing the old
 * `/webhooks/<provider>/<secret>` shape 404s, and a 404 is logged with its URL —
 * which would leak the very secret the migration was meant to protect. It is
 * defence in depth, and it is what makes the cutover safe rather than lucky.
 */
describe('redactSecretPath', () => {
  it('leaves non-webhook paths completely alone', () => {
    // The redaction is scoped: it must not degrade observability everywhere else.
    expect(redactSecretPath('/api/signals/123')).toBe('/api/signals/123');
    expect(redactSecretPath('/api/health')).toBe('/api/health');
  });

  it.each(Array.from(KNOWN_WEBHOOK_ROUTES))(
    'leaves the known static route %s intact',
    (route) => {
      // Every registered webhook route is static and secret-free by design —
      // redacting these would blind the logs for no gain.
      expect(redactSecretPath(route)).toBe(route);
    },
  );

  // THE case this exists for: a stale caller using the retired path-secret URL.
  it('redacts a trailing path secret on a known provider route', () => {
    expect(redactSecretPath('/webhooks/chartink/s3cr3t-value')).toBe(
      '/webhooks/chartink/<redacted>',
    );
  });

  it('keeps the action segment but redacts the secret after it', () => {
    // `backfill` vs `resolve-pending` is the useful half of the path — losing it
    // would make the logs useless for telling the two triggers apart.
    expect(redactSecretPath('/webhooks/ml/backfill/s3cr3t-value')).toBe(
      '/webhooks/ml/backfill/<redacted>',
    );
    expect(redactSecretPath('/webhooks/ml/resolve-pending/s3cr3t-value')).toBe(
      '/webhooks/ml/resolve-pending/<redacted>',
    );
  });

  // Fail closed: an unrecognised shape under /webhooks/ is untrusted input, and
  // we cannot know which segment is the secret. Redact all of it.
  it('redacts the whole tail of an unknown webhook path', () => {
    expect(redactSecretPath('/webhooks/unknown/s3cr3t-value')).toBe('/webhooks/<redacted>');
    expect(redactSecretPath('/webhooks/s3cr3t-value')).toBe('/webhooks/<redacted>');
  });

  it('redacts a secret carried in the query string', () => {
    // A secret in ?secret= is the same leak wearing a different hat.
    expect(redactSecretPath('/webhooks/chartink?secret=s3cr3t-value')).toBe(
      '/webhooks/chartink?<redacted>',
    );
    expect(redactSecretPath('/webhooks/ml/backfill/s3cr3t?x=1')).toBe(
      '/webhooks/ml/backfill/<redacted>',
    );
  });

  it('never lets the secret survive anywhere in the output', () => {
    // The property that actually matters, asserted directly rather than inferred
    // from the exact-string cases above.
    const secret = 'k7Hn3Fp9q2X-correct-horse-battery-staple-32chars';
    const urls = [
      `/webhooks/chartink/${secret}`,
      `/webhooks/ml/backfill/${secret}`,
      `/webhooks/ml/resolve-pending/${secret}`,
      `/webhooks/unknown/${secret}`,
      `/webhooks/chartink?secret=${secret}`,
      `/webhooks/ml/backfill/${secret}?retry=1`,
    ];
    for (const url of urls) {
      expect(redactSecretPath(url)).not.toContain(secret);
    }
  });

  it('is robust to odd input rather than throwing inside a logger', () => {
    // This runs in an exception filter. If it throws, it takes out the error
    // path itself — the worst possible place to be clever.
    expect(redactSecretPath('')).toBe('');
    expect(redactSecretPath('/webhooks/')).toBe('/webhooks/<redacted>');
    expect(redactSecretPath('/webhooks')).toBe('/webhooks');
  });
});
