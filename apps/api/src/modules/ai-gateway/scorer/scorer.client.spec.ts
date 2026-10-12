import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SCORER_TIMEOUT_MS, ScorerClient, type ScoreRequest } from './scorer.client';

const config = (env: Record<string, string | undefined>) =>
  ({ get: (k: string) => env[k] }) as unknown as ConfigService;

const req = (): ScoreRequest => ({
  featureSet: 'fs1-legacy-checks',
  breakdown: { checks: [{ name: 'trend', passed: true }] },
  context: { decidedAt: '2026-10-12T04:00:00.000Z', direction: 'LONG', strategyKey: 'legacy.gated', vixAtEntry: 13.2 },
});

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const MODEL = { source: 'model', pWin: 0.61, expectedR: 0.2, modelId: 'entry-xgb-1', featureSet: 'fs1-legacy-checks', missing: [] };
const RULE = { source: 'rule', pWin: 0.5, expectedR: null, featureSet: 'fs1-legacy-checks', missing: ['vix'] };

describe('ScorerClient', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const client = (url: string | undefined = 'http://ai-engine:5000') => new ScorerClient(config({ AI_SCORER_URL: url }));

  it('POSTs the request as JSON to ${AI_SCORER_URL}/score and passes a model reply through', async () => {
    fetchMock.mockResolvedValue(jsonResponse(MODEL));
    await expect(client('http://ai-engine:5000/').score(req())).resolves.toEqual(MODEL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://ai-engine:5000/score');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(expect.objectContaining({ 'content-type': 'application/json' }));
    expect(JSON.parse(init.body)).toEqual(req());
    expect(init.signal).toBeDefined();
  });

  it('passes a rule reply through', async () => {
    fetchMock.mockResolvedValue(jsonResponse(RULE));
    await expect(client().score(req())).resolves.toEqual(RULE);
  });

  it('a non-2xx reply → unavailable', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'boom' }, 500));
    await expect(client().score(req())).resolves.toEqual({ source: 'unavailable', reason: 'http 500' });
  });

  it.each([
    ['pWin not a number', { ...MODEL, pWin: 'x' }],
    ['pWin out of range', { ...MODEL, pWin: 1.5 }],
    ['model without modelId', { ...MODEL, modelId: undefined }],
    ['model with null expectedR', { ...MODEL, expectedR: null }],
    ['rule with numeric expectedR', { ...RULE, expectedR: 0.3 }],
    ['missing not an array', { ...RULE, missing: 'vix' }],
    ['unknown source', { ...RULE, source: 'oracle' }],
    ['not an object', 'hello'],
    ['null', null],
  ])('malformed body (%s) → unavailable', async (_label, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));
    const r = await client().score(req());
    expect(r).toEqual({ source: 'unavailable', reason: expect.stringMatching(/^malformed reply/) });
  });

  it('a body that is not JSON → unavailable', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });
    await expect(client().score(req())).resolves.toEqual({ source: 'unavailable', reason: expect.stringMatching(/bad json/) });
  });

  it('a network error → unavailable, never throws', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(client().score(req())).resolves.toEqual({ source: 'unavailable', reason: expect.stringMatching(/fetch failed/) });
  });

  it(`a fetch that never resolves → unavailable after ${SCORER_TIMEOUT_MS} ms (Review Focus 5), and aborts the request`, async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise(() => undefined);
    });
    let settled: unknown;
    const p = client().score(req()).then((r) => (settled = r));
    await jest.advanceTimersByTimeAsync(SCORER_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toEqual({ source: 'unavailable', reason: `timeout after ${SCORER_TIMEOUT_MS} ms` });
    expect(signal?.aborted).toBe(true);
  });

  it('the timeout is 1.5 s', () => {
    expect(SCORER_TIMEOUT_MS).toBe(1500);
  });

  it('a real slow server is cut off within ~1.5 s of wall time', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    );
    const t0 = Date.now();
    const r = await client().score(req());
    const elapsed = Date.now() - t0;
    expect(r.source).toBe('unavailable');
    expect(elapsed).toBeGreaterThanOrEqual(SCORER_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(SCORER_TIMEOUT_MS + 1000);
  });

  it.each([undefined, '', '   '])('AI_SCORER_URL=%p → unavailable without calling fetch, warned once', async (url) => {
    await expect(new ScorerClient(config({ AI_SCORER_URL: url })).score(req())).resolves.toEqual({
      source: 'unavailable',
      reason: 'AI_SCORER_URL not set',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never falls back to AI_ENGINE_URL (that URL belongs to ai-advisor / weekly-report)', async () => {
    const c = new ScorerClient(config({ AI_ENGINE_URL: 'http://ai-engine:5000', AI_SCORER_URL: undefined }));
    await expect(c.score(req())).resolves.toEqual({ source: 'unavailable', reason: 'AI_SCORER_URL not set' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads AI_SCORER_URL, not AI_ENGINE_URL, when both are set', async () => {
    fetchMock.mockResolvedValue(jsonResponse(RULE));
    const c = new ScorerClient(
      config({ AI_ENGINE_URL: 'https://advisor.example.com', AI_SCORER_URL: 'http://ai-engine:5000' }),
    );
    await c.score(req());
    expect(fetchMock.mock.calls[0][0]).toBe('http://ai-engine:5000/score');
  });

  it('warns at most once per minute', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-12T04:00:00Z'));
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const c = client();
    await c.score(req());
    await c.score(req());
    await c.score(req());
    expect(warn).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date('2026-10-12T04:00:59Z'));
    await c.score(req());
    expect(warn).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date('2026-10-12T04:01:00Z'));
    await c.score(req());
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
