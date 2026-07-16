import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { of, lastValueFrom } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

/**
 * Registered globally (`main.ts`), so it logs the URL of every SUCCESSFUL
 * request. While webhook secrets travelled in the path, that meant a plaintext
 * copy of the secret in the logs on every single successful trigger — the
 * quietest possible leak, since nothing about it looks like a failure.
 */
describe('LoggingInterceptor', () => {
  const SECRET = 'k7Hn3Fp9q2X-correct-horse-battery-staple-32chars';

  function makeCtx(url: string, method = 'POST') {
    return {
      switchToHttp: () => ({ getRequest: () => ({ url, method }) }),
    } as unknown as ExecutionContext;
  }

  const next: CallHandler = { handle: () => of('ok') };

  let logged: string[];
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logged = [];
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '));
    });
  });

  afterEach(() => logSpy.mockRestore());

  it('redacts a webhook path secret from the success log', async () => {
    const interceptor = new LoggingInterceptor();

    await lastValueFrom(interceptor.intercept(makeCtx(`/webhooks/chartink/${SECRET}`), next));

    const all = logged.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).toContain('/webhooks/chartink/<redacted>');
  });

  it('logs ordinary URLs unchanged, with timing', async () => {
    // The interceptor's day job — request timing — must survive the redaction.
    const interceptor = new LoggingInterceptor();

    await lastValueFrom(interceptor.intercept(makeCtx('/api/signals/123', 'GET'), next));

    expect(logged.join('\n')).toMatch(/GET \/api\/signals\/123 - \d+ms/);
  });

  it('leaves the new header-authed webhook routes readable', async () => {
    // These carry no secret, so they must log in full — otherwise the migration
    // would trade a leak for a blind spot.
    const interceptor = new LoggingInterceptor();

    await lastValueFrom(interceptor.intercept(makeCtx('/webhooks/ml/backfill'), next));

    expect(logged.join('\n')).toContain('/webhooks/ml/backfill');
    expect(logged.join('\n')).not.toContain('<redacted>');
  });
});
