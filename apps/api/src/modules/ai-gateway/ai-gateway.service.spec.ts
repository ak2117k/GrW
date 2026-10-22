import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { RateLimitError } from '@anthropic-ai/sdk';
import { AiGatewayService } from './ai-gateway.service';
import { loadRoutes } from './routes/route-config';
import { loadPrices } from './budget/model-prices';
import { BudgetMeter, AiBudgetExceeded } from './budget/budget-meter';
import { PriorityScheduler, AiQueueTimeout } from './scheduler/priority-scheduler';
import type { AiCallRow } from './audit/ai-call.repository';
import type { ProviderAdapter, ProviderName, ProviderResult } from './providers/provider.types';
import type { TransportRequest } from './transport.types';

const ROUTES_JSON = {
  'decision.judge': { provider: 'claude-cli', model: 'claude-sonnet-5', fallback: ['anthropic-api'], maxWaitMs: 20000 },
  'review.overnight': { provider: 'claude-cli', model: 'claude-sonnet-5', fallback: ['anthropic-api'], maxWaitMs: 120000 },
  'review.holdings': { provider: 'claude-cli', model: 'claude-sonnet-5', fallback: ['anthropic-api'], maxWaitMs: 120000 },
  'news.impact': { provider: 'anthropic-api', model: 'claude-haiku-4-5', fallback: [], maxWaitMs: 60000 },
  'picks.next-day': { provider: 'claude-cli', model: 'claude-opus-5', fallback: [], maxWaitMs: 600000 },
  'picks.pre-market': { provider: 'claude-cli', model: 'claude-sonnet-5', fallback: [], maxWaitMs: 300000 },
  'learning.nightly': { provider: 'claude-cli', model: 'claude-opus-5', fallback: [], maxWaitMs: 1800000 },
  'strategy.draft': { provider: 'claude-cli', model: 'unpriced-model', fallback: [], maxWaitMs: 600000 },
};

const PRICES = loadPrices({
  cacheMultipliers: { writeOfInput: 1.25, readOfInput: 0.1 },
  'claude-opus-5': { inputPerMTokInr: 440, outputPerMTokInr: 2200 },
  'claude-sonnet-5': { inputPerMTokInr: 176, outputPerMTokInr: 880 },
  'claude-haiku-4-5': { inputPerMTokInr: 88, outputPerMTokInr: 440 },
});

const request = (over: Partial<TransportRequest> = {}): TransportRequest => ({
  model: 'claude-opus-5',
  max_tokens: 1000,
  output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } },
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: '{"packet":1}' }],
  ...over,
});

const okResult = (
  tokens: [number | null, number | null] = [100, 20],
  billed = false,
  cache: [number | null, number | null] = [null, null],
): ProviderResult => ({
  message: { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' },
  meta: {
    inputTokens: tokens[0],
    outputTokens: tokens[1],
    cacheCreationInputTokens: cache[0],
    cacheReadInputTokens: cache[1],
    billed,
  },
});

function adapter(name: ProviderName, send: jest.Mock): ProviderAdapter {
  return { name, send };
}

function build(opts: {
  sentinelJudge?: string;
  cli?: jest.Mock;
  api?: jest.Mock;
  insert?: jest.Mock;
  capInr?: number;
} = {}) {
  const insert = opts.insert ?? jest.fn().mockResolvedValue(undefined);
  const cli = opts.cli ?? jest.fn().mockResolvedValue(okResult([12, 3], false));
  const api = opts.api ?? jest.fn().mockResolvedValue(okResult([100, 20], true));
  const meter = new BudgetMeter({
    capInr: opts.capInr ?? 100,
    reserveShare: 0.25,
    spentToday: async () => 0,
    now: () => new Date('2026-10-12T06:00:00Z'),
  });
  const gateway = new AiGatewayService({
    routes: loadRoutes(ROUTES_JSON, opts.sentinelJudge ? { SENTINEL_JUDGE: opts.sentinelJudge } : {}),
    prices: PRICES,
    meter,
    scheduler: new PriorityScheduler({}),
    adapters: { 'claude-cli': adapter('claude-cli', cli), 'anthropic-api': adapter('anthropic-api', api) },
    audit: { insert },
  });
  const rows = () => insert.mock.calls.map((c) => c[0] as AiCallRow);
  return { gateway, insert, cli, api, rows, meter };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('AiGatewayService', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sentinel route (model null): the adapter receives the identical request object and its message is returned by reference', async () => {
    const result = okResult([12, 3]);
    const cli = jest.fn().mockResolvedValue(result);
    const { gateway } = build({ sentinelJudge: 'cli', cli });
    const req = request();
    const msg = await gateway.call('sentinel.judge', req);
    expect(cli).toHaveBeenCalledTimes(1);
    expect(cli.mock.calls[0]).toHaveLength(1);
    expect(cli.mock.calls[0][0]).toBe(req);
    expect(msg).toBe(result.message);
  });

  it('writes exactly one audit row per attempt with the expected fields (CLI → cost 0)', async () => {
    const { gateway, rows } = build({ sentinelJudge: 'cli' });
    const req = request();
    await gateway.call('sentinel.judge', req, { userId: 'u1', positionId: 'p1' });
    await flush();
    expect(rows()).toHaveLength(1);
    const row = rows()[0];
    expect(row).toEqual(
      expect.objectContaining({
        job: 'sentinel.judge',
        provider: 'claude-cli',
        model: 'claude-opus-5',
        effort: 'high',
        priority: 0,
        userId: 'u1',
        positionId: 'p1',
        setupId: null,
        decisionRecordId: null,
        requestHash: createHash('sha256').update(JSON.stringify(req)).digest('hex'),
        request: req,
        response: { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' },
        errorClass: null,
        errorMessage: null,
        stopReason: 'end_turn',
        inputTokens: 12,
        outputTokens: 3,
        costInr: 0,
        queuedMs: 0,
        fallbackFrom: null,
      }),
    );
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('records the WHOLE prompt as inputTokens: uncached + cache write + cache read', async () => {
    const { gateway, rows } = build({ sentinelJudge: 'cli', cli: jest.fn().mockResolvedValue(okResult([2, 300], false, [40, 9000])) });
    await gateway.call('sentinel.judge', request());
    await flush();
    expect(rows()[0]).toEqual(expect.objectContaining({ inputTokens: 9042, outputTokens: 300 }));
  });

  it('CLI usage missing → tokens null, cost 0', async () => {
    const { gateway, rows } = build({ sentinelJudge: 'cli', cli: jest.fn().mockResolvedValue(okResult([null, null])) });
    await gateway.call('sentinel.judge', request());
    await flush();
    expect(rows()[0]).toEqual(expect.objectContaining({ inputTokens: null, outputTokens: null, costInr: 0 }));
  });

  it('API call is priced from reported usage', async () => {
    const { gateway, rows } = build({ api: jest.fn().mockResolvedValue(okResult([1_000_000, 1_000], true)) });
    await gateway.call('sentinel.judge', request());
    await flush();
    expect(rows()[0].provider).toBe('anthropic-api');
    expect(rows()[0].costInr).toBeCloseTo(440 + 2.2, 6);
  });

  it('API call cost includes prompt-cache writes (1.25x input) and reads (0.1x input)', async () => {
    const { gateway, rows, meter } = build({
      api: jest.fn().mockResolvedValue(okResult([1_000, 1_000], true, [1_000_000, 1_000_000])),
    });
    await gateway.call('sentinel.judge', request());
    await flush();
    // 1k input @440 + 1k output @2200 + 1M cache write @550 + 1M cache read @44
    const expected = 0.44 + 2.2 + 550 + 44;
    expect(rows()[0].costInr).toBeCloseTo(expected, 6);
    expect(meter.snapshot().committedInr).toBeCloseTo(expected, 6);
  });

  it('missing cache counts contribute 0 to cost, never an estimate', async () => {
    const { gateway, rows } = build({
      api: jest.fn().mockResolvedValue(okResult([1_000_000, 1_000], true, [null, null])),
    });
    await gateway.call('sentinel.judge', request());
    await flush();
    expect(rows()[0].costInr).toBeCloseTo(440 + 2.2, 6);
  });

  it('a rejecting audit insert does not change the result; it is counted and logged once', async () => {
    const result = okResult();
    const { gateway } = build({
      sentinelJudge: 'cli',
      cli: jest.fn().mockResolvedValue(result),
      insert: jest.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(gateway.call('sentinel.judge', request())).resolves.toBe(result.message);
    await flush();
    expect(gateway.stats().auditWriteFailures).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/^ai-gateway: audit write failed \(sentinel\.judge\): db down/);
  });

  it('a synchronously throwing audit insert does not change the result either', async () => {
    const result = okResult();
    const { gateway } = build({
      sentinelJudge: 'cli',
      cli: jest.fn().mockResolvedValue(result),
      insert: jest.fn(() => {
        throw new Error('sync boom');
      }),
    });
    await expect(gateway.call('sentinel.judge', request())).resolves.toBe(result.message);
    await flush();
    expect(gateway.stats().auditWriteFailures).toBe(1);
  });

  it('a never-settling audit insert with a 100 KB request does not block the caller (Review Focus 1)', async () => {
    const result = okResult();
    const insert = jest.fn(() => new Promise<void>(() => undefined));
    const { gateway, rows } = build({ sentinelJudge: 'cli', cli: jest.fn().mockResolvedValue(result), insert });
    const big = request({ messages: [{ role: 'user', content: 'x'.repeat(100 * 1024) }] });
    await expect(gateway.call('sentinel.judge', big)).resolves.toBe(result.message);
    expect(insert).toHaveBeenCalledTimes(1);
    // stored in full
    expect((rows()[0].request as TransportRequest).messages[0].content).toHaveLength(100 * 1024);
  });

  it('adapter error with no fallback: the same instance is rethrown and audited with its class', async () => {
    const err = new RateLimitError(429, { error: { message: 'slow down' } }, 'rate limited', new Headers());
    const { gateway, rows } = build({ api: jest.fn().mockRejectedValue(err) });
    await expect(gateway.call('sentinel.judge', request())).rejects.toBe(err);
    await flush();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toEqual(
      expect.objectContaining({
        errorClass: 'RateLimitError',
        errorMessage: err.message,
        response: null,
        stopReason: null,
        inputTokens: null,
        outputTokens: null,
        costInr: 0,
      }),
    );
  });

  it('error messages are truncated to 2000 chars in the audit row', async () => {
    const { gateway, rows } = build({ api: jest.fn().mockRejectedValue(new Error('e'.repeat(5000))) });
    await expect(gateway.call('sentinel.judge', request())).rejects.toThrow();
    await flush();
    expect(rows()[0].errorMessage).toHaveLength(2000);
  });

  it('fallback chain: claude-cli fails, anthropic-api answers; the second row records fallbackFrom', async () => {
    const result = okResult([10, 10], true);
    const cliErr = new Error('cli down');
    const { gateway, rows, cli, api } = build({
      cli: jest.fn().mockRejectedValue(cliErr),
      api: jest.fn().mockResolvedValue(result),
    });
    const req = request({ model: 'whatever' });
    await expect(gateway.call('decision.judge', req)).resolves.toBe(result.message);
    await flush();
    expect(cli.mock.calls[0][0].model).toBe('claude-sonnet-5');
    expect(api.mock.calls[0][0].model).toBe('claude-sonnet-5');
    expect(req.model).toBe('whatever'); // the caller's object is never mutated
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toEqual(expect.objectContaining({ provider: 'claude-cli', errorClass: 'Error', fallbackFrom: null, priority: 1 }));
    expect(rows()[1]).toEqual(expect.objectContaining({ provider: 'anthropic-api', errorClass: null, fallbackFrom: 'claude-cli' }));
  });

  it('fallback chain exhausted: the LAST error instance is rethrown', async () => {
    const apiErr = new Error('api down');
    const { gateway } = build({
      cli: jest.fn().mockRejectedValue(new Error('cli down')),
      api: jest.fn().mockRejectedValue(apiErr),
    });
    await expect(gateway.call('decision.judge', request())).rejects.toBe(apiErr);
  });

  it('unknown price on an API provider → AiBudgetExceeded, adapter never called, audit row written', async () => {
    const { gateway, api, rows } = build();
    await expect(gateway.call('sentinel.judge', request({ model: 'mystery-model' }))).rejects.toBeInstanceOf(AiBudgetExceeded);
    await flush();
    expect(api).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toEqual(
      expect.objectContaining({
        errorClass: 'AiBudgetExceeded',
        errorMessage: 'unknown price for mystery-model',
        model: 'mystery-model',
      }),
    );
    expect(gateway.stats().budgetRefusals).toBe(1);
  });

  it('CLI calls are not budgeted (an unpriced model is fine on claude-cli)', async () => {
    const { gateway, cli } = build({ capInr: 0 });
    await expect(gateway.call('strategy.draft', request())).resolves.toBeDefined();
    expect(cli).toHaveBeenCalledTimes(1);
  });

  it('budget refusal on the API is audited and rethrown', async () => {
    const { gateway, api, rows } = build({ capInr: 0.0001 });
    await expect(gateway.call('news.impact', request())).rejects.toBeInstanceOf(AiBudgetExceeded);
    await flush();
    expect(api).not.toHaveBeenCalled();
    expect(rows()[0].errorClass).toBe('AiBudgetExceeded');
  });

  it('two concurrent API calls whose worst cases each fit but jointly exceed the cap → exactly one reaches the adapter (Review Focus 2)', async () => {
    const req = request({ max_tokens: 20_000 }); // opus: 20k * 2200/1e6 = ₹44 + input
    const api = jest.fn().mockResolvedValue(okResult([10, 10], true));
    const { gateway } = build({ api, capInr: 60 });
    const results = await Promise.allSettled([
      gateway.call('sentinel.judge', req),
      gateway.call('sentinel.judge', req),
    ]);
    expect(api).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AiBudgetExceeded);
  });

  it('a settled call frees its worst-case reservation down to the actual cost', async () => {
    const req = request({ max_tokens: 20_000 });
    const { gateway, api } = build({ capInr: 60, api: jest.fn().mockResolvedValue(okResult([10, 10], true)) });
    await gateway.call('sentinel.judge', req);
    await gateway.call('sentinel.judge', req);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('a failed spend load fails the API call closed with AiBudgetExceeded', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const api = jest.fn();
    const gateway = new AiGatewayService({
      routes: loadRoutes(ROUTES_JSON, {}),
      prices: PRICES,
      meter: new BudgetMeter({ capInr: 100, reserveShare: 0.25, spentToday: () => Promise.reject(new Error('db')), now: () => new Date() }),
      scheduler: new PriorityScheduler({}),
      adapters: { 'anthropic-api': adapter('anthropic-api', api) },
      audit: { insert },
    });
    await expect(gateway.call('sentinel.judge', request())).rejects.toBeInstanceOf(AiBudgetExceeded);
    expect(api).not.toHaveBeenCalled();
  });

  it('counts queue timeouts', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    let release!: () => void;
    const cli = jest.fn(() => new Promise<ProviderResult>((res) => (release = () => res(okResult()))));
    const gateway = new AiGatewayService({
      routes: { ...loadRoutes(ROUTES_JSON, { SENTINEL_JUDGE: 'cli' }), 'news.impact': { provider: 'claude-cli', model: 'claude-haiku-4-5', fallback: [], maxWaitMs: 5 } },
      prices: PRICES,
      meter: new BudgetMeter({ capInr: 100, reserveShare: 0.25, spentToday: async () => 0, now: () => new Date() }),
      scheduler: new PriorityScheduler({ 'claude-cli': 1 }),
      adapters: { 'claude-cli': adapter('claude-cli', cli) },
      audit: { insert },
    });
    const first = gateway.call('sentinel.judge', request());
    await expect(gateway.call('news.impact', request())).rejects.toBeInstanceOf(AiQueueTimeout);
    expect(gateway.stats().queueTimeouts).toBe(1);
    release();
    await first;
  });
});
