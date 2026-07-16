import { ArgumentsHost, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

/**
 * This filter is registered globally (`main.ts`), so it sees EVERY failed
 * request — including failed webhook calls, whose URL may carry a shared secret.
 *
 * That makes it the leakiest spot in the app for a secret, and the reason is
 * subtle: the webhook controllers' own unit tests spy on `Logger` and prove the
 * CONTROLLER never logs its secret. They pass. But those tests construct the
 * controller directly and never build the HTTP pipeline, so a global filter
 * logging `request.url` was invisible to them while leaking on every single 401.
 * These tests cover the layer those ones structurally cannot reach.
 */
describe('HttpExceptionFilter', () => {
  const SECRET = 'k7Hn3Fp9q2X-correct-horse-battery-staple-32chars';

  function makeHost(url: string, method = 'POST') {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url, method }),
      }),
    } as unknown as ArgumentsHost;
    return { host, status, json };
  }

  let logged: string[];
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logged = [];
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(' '));
      });
  });

  afterEach(() => errorSpy.mockRestore());

  it('does not echo the request URL back in the response body', () => {
    // `path: request.url` reflected whatever the caller sent straight back to
    // them. For a failed webhook that means echoing the attempted secret.
    const filter = new HttpExceptionFilter();
    const { host, json } = makeHost(`/webhooks/chartink/${SECRET}`);

    filter.catch(new UnauthorizedException(), host);

    const body = json.mock.calls[0][0];
    expect(body).not.toHaveProperty('path');
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('still returns statusCode, message and timestamp', () => {
    // Removing `path` must not gut the error contract the frontend relies on.
    const filter = new HttpExceptionFilter();
    const { host, json, status } = makeHost('/api/signals/123');

    filter.catch(new NotFoundException('signal not found'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json.mock.calls[0][0]).toEqual({
      statusCode: 404,
      message: 'signal not found',
      timestamp: expect.any(String),
    });
  });

  it('redacts a stale path secret from the logged URL', () => {
    // A retired heartbeat still using the path-secret URL 404s here. Without
    // redaction that 404 log line is a plaintext copy of the secret.
    const filter = new HttpExceptionFilter();
    const { host } = makeHost(`/webhooks/chartink/${SECRET}`);

    filter.catch(new NotFoundException(), host);

    const all = logged.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).toContain('/webhooks/chartink/<redacted>');
  });

  it('redacts a stale ML trigger path secret too', () => {
    const filter = new HttpExceptionFilter();
    const { host } = makeHost(`/webhooks/ml/backfill/${SECRET}`);

    filter.catch(new UnauthorizedException(), host);

    const all = logged.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).toContain('/webhooks/ml/backfill/<redacted>');
  });

  it('logs ordinary URLs unchanged', () => {
    // The redaction is scoped to webhooks; normal request logging is untouched.
    const filter = new HttpExceptionFilter();
    const { host } = makeHost('/api/signals/123');

    filter.catch(new NotFoundException('nope'), host);

    expect(logged.join('\n')).toContain('POST /api/signals/123 404');
  });
});
