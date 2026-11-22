import * as http from 'node:http';
import { AGENT_PROTOCOL } from '../modules/ai-gateway/agents/agent-protocol';
import { parseAgentRegistry } from '../modules/ai-gateway/agents/agent-registry';
import type { ProviderResult } from '../modules/ai-gateway/providers/provider.types';
import type { TransportRequest } from '../modules/ai-gateway/transport.types';
import { AgentServer } from './agent-server';

const registry = parseAgentRegistry(
  {
    'signal.judge': { agent: 'trading', concurrency: 1, timeoutMs: 60000, model: null, effort: null, maxTokens: null },
    'sentinel.judge': { agent: 'trading', concurrency: 2, timeoutMs: 60000, model: null, effort: null, maxTokens: null },
    'news.impact': { agent: 'reading', concurrency: 2, timeoutMs: 60000, model: null, effort: null, maxTokens: null },
  },
  {},
  () => undefined,
);

const request: TransportRequest = {
  model: 'claude-opus-5',
  max_tokens: 100,
  output_config: { effort: 'low', format: { type: 'json_schema', schema: {} } },
  system: [{ type: 'text', text: 'sys' }],
  messages: [{ role: 'user', content: 'SECRET-PROMPT' }],
};

const okResult: ProviderResult = {
  message: { content: [{ type: 'text', text: '{"a":1}' }], stop_reason: 'end_turn' },
  meta: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: null, cacheReadInputTokens: 0, billed: true },
};

class RateLimitError extends Error {
  readonly status = 429;
  constructor(m: string) {
    super(m);
  }
}

function post(port: number, body: unknown, opts: { timeoutMs?: number } = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('client timeout')));
    req.end(data);
  });
}

function get(port: number, path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
      })
      .on('error', reject);
  });
}

const body = (job: string, deadlineMs = 5000) => ({ protocol: AGENT_PROTOCOL, job, request, deadlineMs });
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AgentServer (end-to-end on port 0)', () => {
  let server: AgentServer;
  let port: number;
  let send: jest.Mock<Promise<ProviderResult>, [TransportRequest, { signal?: AbortSignal }?]>;
  let lines: string[];

  beforeEach(async () => {
    lines = [];
    send = jest.fn(async (_req: TransportRequest) => okResult);
    server = new AgentServer({ group: 'trading', registry, provider: { send }, log: (l) => lines.push(l) });
    port = await server.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await server.stop(1000);
  });

  it('serves a call: ok:true with message, meta, queuedMs and agent; request passed through as-is', async () => {
    const r = await post(port, body('signal.judge'));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ protocol: AGENT_PROTOCOL, ok: true, message: okResult.message, meta: okResult.meta, queuedMs: expect.any(Number), agent: 'trading' });
    expect(send).toHaveBeenCalledWith(request, { signal: expect.any(AbortSignal) });
    expect(lines.some((l) => /job=signal\.judge ms=\d+ queued=\d+ ok/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toContain('SECRET-PROMPT');
  });

  it('passes the provider error class, message and status through', async () => {
    send.mockRejectedValueOnce(new RateLimitError('quota exceeded'));
    const r = await post(port, body('signal.judge'));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ protocol: AGENT_PROTOCOL, ok: false, error: { class: 'RateLimitError', message: 'quota exceeded', status: 429 } });
    expect(lines.some((l) => l.includes('err=RateLimitError status=429'))).toBe(true);
  });

  it('a plain Error without status keeps class Error and omits status', async () => {
    send.mockRejectedValueOnce(new Error('boom'));
    const r = await post(port, body('signal.judge'));
    expect(r.json.error).toEqual({ class: 'Error', message: 'boom' });
  });

  it('answers AgentBusyError when the call cannot start before its deadline', async () => {
    let finish!: () => void;
    send.mockImplementationOnce(() => new Promise((res) => (finish = () => res(okResult))));
    const first = post(port, body('signal.judge')); // limit 1 → holds the slot
    await tick(30);
    const busy = await post(port, body('signal.judge', 50));
    expect(busy.json).toMatchObject({ protocol: AGENT_PROTOCOL, ok: false, error: { class: 'AgentBusyError' } });
    finish();
    expect((await first).json.ok).toBe(true);
    const h = await get(port, '/health');
    expect(h.json.agents['signal.judge']).toMatchObject({ okLast5m: 1, errLast5m: 1, inFlight: 0, queued: 0 });
  });

  it('a queued call starts when the slot frees and reports queuedMs', async () => {
    let finish!: () => void;
    send.mockImplementationOnce(() => new Promise((res) => (finish = () => res(okResult))));
    const first = post(port, body('signal.judge'));
    await tick(30);
    const second = post(port, body('signal.judge', 5000));
    await tick(60);
    finish();
    const r2 = await second;
    expect(r2.json.ok).toBe(true);
    expect(r2.json.queuedMs).toBeGreaterThanOrEqual(40);
    await first;
  });

  it('rejects a job of another group with WrongAgent, without calling the provider', async () => {
    const r = await post(port, body('news.impact'));
    expect(r.json).toMatchObject({ ok: false, error: { class: 'WrongAgent' } });
    const unknown = await post(port, body('brand.new.job')); // unknown → background, not trading
    expect(unknown.json).toMatchObject({ ok: false, error: { class: 'WrongAgent' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a protocol mismatch with ProtocolMismatch, without calling the provider', async () => {
    const r = await post(port, { ...body('signal.judge'), protocol: 2 });
    expect(r.json).toMatchObject({ protocol: AGENT_PROTOCOL, ok: false, error: { class: 'ProtocolMismatch' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies with 400 BadRequest', async () => {
    expect((await post(port, 'not json')).status).toBe(400);
    const r = await post(port, { protocol: AGENT_PROTOCOL, job: 'signal.judge', deadlineMs: 100 });
    expect(r.status).toBe(400);
    expect(r.json.error.class).toBe('BadRequest');
  });

  it('GET /health has the AgentHealth shape for this group', async () => {
    const r = await get(port, '/health');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ group: 'trading', protocol: AGENT_PROTOCOL, rssMb: expect.any(Number) });
    expect(Object.keys(r.json.agents).sort()).toEqual(['sentinel.judge', 'signal.judge']);
    expect(r.json.agents['sentinel.judge']).toEqual({ inFlight: 0, limit: 2, queued: 0, okLast5m: 0, errLast5m: 0 });
    expect(r.json.rssMb).toBeGreaterThan(0);
  });

  it('discards and counts a result that arrives after the client disconnected', async () => {
    let finish!: () => void;
    send.mockImplementationOnce(() => new Promise((res) => (finish = () => res(okResult))));
    await expect(post(port, body('signal.judge'), { timeoutMs: 40 })).rejects.toThrow('client timeout');
    await tick(20);
    finish();
    await tick(20);
    expect(server.lateDiscarded).toBe(1);
    expect((await get(port, '/health')).json.lateDiscarded).toBe(1);
    expect(lines.some((l) => l.includes('DISCARDED'))).toBe(true);
  });

  it('stop() refuses new calls but lets the in-flight one finish', async () => {
    let finish!: () => void;
    send.mockImplementationOnce(() => new Promise((res) => (finish = () => res(okResult))));
    const inflight = post(port, body('signal.judge'));
    await tick(30);
    const stopped = server.stop(2000);
    setTimeout(() => finish(), 30);
    expect((await inflight).json.ok).toBe(true);
    expect(await stopped).toBe(true);
  });
});

describe('AgentServer: an abandoned call is cancelled on Vertex (review fix)', () => {
  it('passes a signal to the provider that aborts when the API disconnects, freeing the job slot', async () => {
    let seen: AbortSignal | undefined;
    const send = jest.fn(
      (_req: TransportRequest, opts?: { signal?: AbortSignal }) =>
        new Promise<ProviderResult>((_res, rej) => {
          seen = opts?.signal;
          opts?.signal?.addEventListener('abort', () => rej(new Error('Request was aborted.')));
        }),
    );
    const server = new AgentServer({ group: 'trading', registry, provider: { send }, log: () => undefined });
    const port = await server.listen(0, '127.0.0.1');
    try {
      await expect(post(port, body('signal.judge'), { timeoutMs: 150 })).rejects.toThrow('client timeout');
      for (let i = 0; i < 50 && !seen?.aborted; i++) await tick(10);
      expect(seen?.aborted).toBe(true);
      // signal.judge has concurrency 1: the slot is free again for the next call.
      await tick(20);
      expect(server.health().agents['signal.judge'].inFlight).toBe(0);
    } finally {
      await server.stop(1000);
    }
  });
});
