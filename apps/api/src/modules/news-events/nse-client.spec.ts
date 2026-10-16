import { NseClient, type NseFetch } from './nse-client';

type Reply = { status: number; body: string; setCookie?: string[] };
function fetchScript(replies: Reply[]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl: NseFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const r = replies.shift();
    if (!r) throw new Error('no scripted reply');
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body,
      headers: { get: () => null, getSetCookie: () => r.setCookie ?? [] },
    };
  };
  return { impl, calls };
}

describe('NseClient', () => {
  let now = 0;
  const make = (replies: Reply[], log: string[] = []) => {
    const f = fetchScript(replies);
    const c = new NseClient({ fetchImpl: f.impl, now: () => now, sleep: async () => undefined, log: (l) => log.push(l), retryDelayMs: 0 });
    return { c, calls: f.calls };
  };
  beforeEach(() => (now = Date.UTC(2026, 9, 16, 4, 0)));

  it('one request, JSON parsed, browser UA', async () => {
    const { c, calls } = make([{ status: 200, body: '[{"a":1}]' }]);
    await expect(c.getJson('ann', 'https://www.nseindia.com/api/x')).resolves.toEqual([{ a: 1 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['User-Agent']).toMatch(/Mozilla/);
  });

  it('one retry, then a 60 s backoff during which the endpoint is not asked', async () => {
    const { c, calls } = make([{ status: 500, body: '' }, { status: 500, body: '' }]);
    await expect(c.getJson('ann', 'https://www.nseindia.com/api/x')).rejects.toThrow(/ann: HTTP 500/);
    expect(calls).toHaveLength(2);
    await expect(c.getJson('ann', 'https://www.nseindia.com/api/x')).rejects.toThrow(/in backoff/);
    expect(calls).toHaveLength(2);
    expect(c.backoffState().ann.until).toBe(new Date(now + 60_000).toISOString());
  });

  it('backoff doubles and caps at 30 min', async () => {
    const { c } = make(Array.from({ length: 40 }, () => ({ status: 503, body: '' })));
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      await c.getText('ev', 'https://www.nseindia.com/api/e').catch(() => undefined);
      const until = Date.parse(c.backoffState().ev.until);
      waits.push((until - now) / 60_000);
      now = until;
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 30, 30]);
  });

  it('a 200 HTML block page is a failure (counted, backed off), not data', async () => {
    const { c } = make([{ status: 200, body: '<html>Access Denied</html>' }]);
    await expect(c.getJson('ann', 'https://www.nseindia.com/api/x')).rejects.toThrow(/not JSON/);
    expect(c.backoffState().ann.failures).toBe(1);
  });

  it('401/403 on nseindia.com: homepage warm-up, cookie sent on the retry, never logged', async () => {
    const log: string[] = [];
    const { c, calls } = make(
      [{ status: 403, body: '' }, { status: 200, body: '<html/>', setCookie: ['nsit=SECRET1; Path=/', 'bm_sv=SECRET2; Path=/'] }, { status: 200, body: '[]' }],
      log,
    );
    await expect(c.getJson('ann', 'https://www.nseindia.com/api/x')).resolves.toEqual([]);
    expect(calls.map((x) => x.url)).toEqual(['https://www.nseindia.com/api/x', 'https://www.nseindia.com/', 'https://www.nseindia.com/api/x']);
    expect(calls[2].headers.Cookie).toBe('nsit=SECRET1; bm_sv=SECRET2');
    expect(log.join('\n')).not.toMatch(/SECRET/);
    expect(log).toContain('[nse-client] warm-up: 2 cookie(s) held in memory');
  });

  it('never warms up for, or sends the cookie to, a non-NSE host', async () => {
    const { c, calls } = make([{ status: 403, body: '' }, { status: 403, body: '' }]);
    await expect(c.getText('yahoo', 'https://query1.finance.yahoo.com/x')).rejects.toThrow(/HTTP 403/);
    expect(calls.map((x) => x.url)).toEqual(['https://query1.finance.yahoo.com/x', 'https://query1.finance.yahoo.com/x']);
    expect(calls[1].headers.Cookie).toBeUndefined();
  });

  it('serialises calls: never two requests in flight', async () => {
    let inFlight = 0;
    let max = 0;
    const impl: NseFetch = async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return { ok: true, status: 200, text: async () => '[]', headers: { get: () => null } };
    };
    const c = new NseClient({ fetchImpl: impl, sleep: async () => undefined });
    await Promise.all([c.getJson('a', 'https://www.nseindia.com/1'), c.getJson('b', 'https://www.nseindia.com/2'), c.getJson('c', 'https://www.nseindia.com/3')]);
    expect(max).toBe(1);
  });
});
