import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { APIConnectionTimeoutError, RateLimitError } from '@anthropic-ai/sdk';
import type { ProviderAdapter, ProviderResult } from '../providers/provider.types';
import type { TransportRequest } from '../transport.types';
import { agentEvents } from './agent-events';
import { withAgentCallBudget } from './agent-call-budget';
import { AGENT_QUEUE_SHARE, AgentLinkState, AgentProvider, applyProfile, callWindow, errorFromAgentReply, TRADING_LIMITER_WAIT_MS } from './agent-provider';
import { AGENT_PROTOCOL, AgentBusyError, type AgentCallBody } from './agent-protocol';
import { DEFAULT_PROFILE, parseAgentRegistry } from './agent-registry';
import { GlobalLimiter } from './global-limiter';

const REQ: TransportRequest = {
  model: 'claude-opus-5',
  max_tokens: 2000,
  output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } },
  system: [{ type: 'text', text: 'SYS' }],
  messages: [{ role: 'user', content: 'hi', images: [{ mediaType: 'image/png', data: 'AAAA' }] }],
};

const META = { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: null, cacheReadInputTokens: null, billed: true };

const REGISTRY = {
  'sentinel.judge': { agent: 'trading', concurrency: 6, timeoutMs: 2000, model: null, effort: null, maxTokens: null },
  'news.ideas': { agent: 'background', concurrency: 2, timeoutMs: 2000, model: 'claude-sonnet-5', effort: 'low', maxTokens: 4000 },
  'signal.parse': { agent: 'in-process', concurrency: 2, timeoutMs: 2000, model: null, effort: null, maxTokens: null },
  'slow.job': { agent: 'reading', concurrency: 2, timeoutMs: 150, model: null, effort: null, maxTokens: null },
};

type Handler = (body: AgentCallBody, res: http.ServerResponse) => void;

async function server(handler: Handler): Promise<{ url: string; bodies: AgentCallBody[]; close: () => Promise<void> }> {
  const bodies: AgentCallBody[] = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as AgentCallBody;
      bodies.push(body);
      handler(body, res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () =>
      new Promise<void>((r) => {
        srv.closeAllConnections?.();
        srv.close(() => r());
      }),
  };
}

function json(res: http.ServerResponse, v: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(v));
}

function inProcessStub(): ProviderAdapter & { send: jest.Mock } {
  return {
    name: 'anthropic-vertex',
    modelFor: (m: string) => (m === 'claude-opus-5' ? 'claude-opus-5-5' : m),
    send: jest.fn(async (): Promise<ProviderResult> => ({ message: { content: [{ type: 'text', text: 'local' }], stop_reason: 'end_turn' }, meta: { ...META } })),
  };
}

function make(job: string, url: string, over: { links?: AgentLinkState; limiter?: GlobalLimiter } = {}) {
  const inProcess = inProcessStub();
  const env = { AGENT_URL_TRADING: url, AGENT_URL_READING: url, AGENT_URL_BACKGROUND: url };
  const provider = new AgentProvider({
    jobOf: () => job,
    inProcess,
    registry: parseAgentRegistry(REGISTRY, env),
    env,
    limiter: over.limiter ?? new GlobalLimiter({ total: 16, tradingReserve: 6 }),
    links: over.links ?? new AgentLinkState(),
  });
  return { provider, inProcess };
}

describe('AgentProvider', () => {
  afterEach(() => agentEvents.removeAllListeners());

  it('POSTs the request to the job agent and returns its message with servedBy + queuedMs', async () => {
    const s = await server((b, res) =>
      json(res, { protocol: AGENT_PROTOCOL, ok: true, message: { content: [{ type: 'text', text: 'remote' }], stop_reason: 'end_turn' }, meta: META, queuedMs: 42, agent: 'trading' }),
    );
    try {
      const { provider, inProcess } = make('sentinel.judge', s.url);
      const r = await provider.send(REQ);
      expect(r.message.content[0].text).toBe('remote');
      expect(r.meta).toMatchObject({ ...META, servedBy: 'trading' });
      expect(r.meta.queuedMs).toBeGreaterThanOrEqual(42);
      expect(inProcess.send).not.toHaveBeenCalled();
      expect(s.bodies[0].protocol).toBe(AGENT_PROTOCOL);
      expect(s.bodies[0].job).toBe('sentinel.judge');
      expect(s.bodies[0].request).toEqual(REQ); // no overrides: untouched, images included
      expect(s.bodies[0].deadlineMs).toBeGreaterThan(0);
      expect(s.bodies[0].deadlineMs).toBeLessThanOrEqual(2000);
      expect(provider.name).toBe('anthropic-vertex');
      expect(provider.modelFor('claude-opus-5')).toBe('claude-opus-5-5');
      expect(provider.effectiveRequest(REQ)).toBe(REQ);
    } finally {
      await s.close();
    }
  });

  it('applies non-null profile overrides (model / effort / max_tokens)', async () => {
    const s = await server((b, res) =>
      json(res, { protocol: 1, ok: true, message: { content: [], stop_reason: 'end_turn' }, meta: META, queuedMs: 0, agent: 'background' }),
    );
    try {
      const { provider } = make('news.ideas', s.url);
      await provider.send(REQ);
      expect(s.bodies[0].request.model).toBe('claude-sonnet-5');
      expect(s.bodies[0].request.max_tokens).toBe(4000);
      expect(s.bodies[0].request.output_config).toEqual({ ...REQ.output_config, effort: 'low' });
      expect(provider.effectiveRequest(REQ).model).toBe('claude-sonnet-5');
      expect(REQ.model).toBe('claude-opus-5'); // caller's object untouched
    } finally {
      await s.close();
    }
  });

  it('in-process jobs go straight to the in-process provider', async () => {
    const { provider, inProcess } = make('signal.parse', 'http://127.0.0.1:1');
    const r = await provider.send(REQ);
    expect(r.message.content[0].text).toBe('local');
    expect(r.meta.servedBy).toBe('in-process');
    expect(inProcess.send).toHaveBeenCalledWith(REQ);
  });

  it('unreachable agent -> in-process fallback, fallback event, group marked down (no second connect)', async () => {
    const s = await server(() => undefined);
    const url = s.url;
    await s.close(); // nothing listens on this port now: connection refused
    const links = new AgentLinkState();
    const { provider, inProcess } = make('sentinel.judge', url, { links });
    const fallback = jest.fn();
    agentEvents.on('fallback', fallback);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const r = await provider.send(REQ);
      expect(r.meta.servedBy).toBe('in-process');
      expect(inProcess.send).toHaveBeenCalledTimes(1);
      expect(fallback).toHaveBeenCalledWith(expect.objectContaining({ group: 'trading', job: 'sentinel.judge' }));
      expect(links.isDown('trading', Date.now())).toBe(true);
      await provider.send(REQ);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(inProcess.send).toHaveBeenCalledTimes(2);
      expect(fallback).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'agent marked down' }));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('protocol mismatch and non-JSON replies -> fallback', async () => {
    const s = await server((b, res) => json(res, { protocol: 2, ok: true, message: {}, meta: {}, queuedMs: 0, agent: 'trading' }));
    const t = await server((b, res) => {
      res.writeHead(502);
      res.end('<html>bad gateway</html>');
    });
    try {
      const a = make('sentinel.judge', s.url);
      expect((await a.provider.send(REQ)).meta.servedBy).toBe('in-process');
      const b = make('sentinel.judge', t.url);
      expect((await b.provider.send(REQ)).meta.servedBy).toBe('in-process');
    } finally {
      await s.close();
      await t.close();
    }
  });

  it('a connection reset mid-call (agent crash) -> fallback', async () => {
    const s = await server((b, res) => res.socket?.destroy());
    try {
      const { provider, inProcess } = make('sentinel.judge', s.url);
      expect((await provider.send(REQ)).meta.servedBy).toBe('in-process');
      expect(inProcess.send).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });

  it('AgentBusyError -> thrown, NO fallback, busy event', async () => {
    const s = await server((b, res) => json(res, { protocol: 1, ok: false, error: { class: 'AgentBusyError', message: 'busy' } }, 503));
    try {
      const { provider, inProcess } = make('sentinel.judge', s.url);
      const busy = jest.fn();
      agentEvents.on('busy', busy);
      const err = await provider.send(REQ).catch((e) => e);
      expect(err).toBeInstanceOf(AgentBusyError);
      expect(err.name).toBe('AgentBusyError');
      expect(err.servedBy).toBe('trading');
      expect(inProcess.send).not.toHaveBeenCalled();
      expect(busy).toHaveBeenCalledWith({ group: 'trading', job: 'sentinel.judge' });
    } finally {
      await s.close();
    }
  });

  it('other agent errors pass through with their class and status (SDK classes rebuilt as SDK classes)', async () => {
    let reply: unknown;
    const s = await server((b, res) => json(res, reply, 500));
    try {
      const { provider, inProcess } = make('sentinel.judge', s.url);
      reply = { protocol: 1, ok: false, error: { class: 'RateLimitError', message: 'slow down', status: 429 } };
      const rl = await provider.send(REQ).catch((e) => e);
      expect(rl).toBeInstanceOf(RateLimitError);
      expect(rl.status).toBe(429);
      reply = { protocol: 1, ok: false, error: { class: 'SyntaxError', message: 'bad json' } };
      const se = await provider.send(REQ).catch((e) => e);
      expect(se.constructor.name).toBe('SyntaxError');
      expect(se.name).toBe('SyntaxError');
      expect(se.message).toBe('bad json');
      reply = { protocol: 1, ok: false, error: { class: 'GoogleAuthError', message: 'no key', status: 401 } };
      const ge = await provider.send(REQ).catch((e) => e);
      expect(ge.constructor.name).toBe('GoogleAuthError');
      expect(ge.status).toBe(401);
      expect(inProcess.send).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  it('a 429 from the agent squeezes the non-trading share', async () => {
    const s = await server((b, res) => json(res, { protocol: 1, ok: false, error: { class: 'RateLimitError', message: 'q', status: 429 } }));
    const limiter = new GlobalLimiter({ total: 16, tradingReserve: 6 });
    const quota = jest.fn();
    agentEvents.on('quota', quota);
    try {
      const { provider } = make('news.ideas', s.url, { limiter });
      await expect(provider.send(REQ)).rejects.toBeInstanceOf(RateLimitError);
      expect(limiter.nonTradingLimit()).toBe(5);
      expect(quota).toHaveBeenCalledWith({ job: 'news.ideas' });
      expect(limiter.stats().inFlight).toBe(0);
    } finally {
      await s.close();
    }
  });

  it('timeout -> the SDK timeout error, no fallback', async () => {
    const s = await server(() => undefined); // never answers
    try {
      const { provider, inProcess } = make('slow.job', s.url);
      const err = await provider.send(REQ).catch((e) => e);
      expect(err).toBeInstanceOf(APIConnectionTimeoutError);
      expect(inProcess.send).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  it('global limiter full -> AgentBusyError before any network call', async () => {
    const limiter = new GlobalLimiter({ total: 1, tradingReserve: 0 });
    await limiter.acquire('other', true, 0);
    const { provider, inProcess } = make('slow.job', 'http://127.0.0.1:1', { limiter });
    await expect(provider.send(REQ)).rejects.toBeInstanceOf(AgentBusyError);
    expect(inProcess.send).not.toHaveBeenCalled();
  });
});

describe('AgentProvider: the agent refusing a call it never ran -> in-process (integration with agent-server)', () => {
  for (const [cls, status] of [
    ['WrongAgent', 200],
    ['ProtocolMismatch', 200],
    ['AgentUnavailable', 503],
    ['BadRequest', 400],
    ['NotFound', 404],
    ['AgentInternalError', 500],
  ] as const) {
    it(`${cls} (HTTP ${status}) -> fallback, fallback event`, async () => {
      const s = await server((b, res) => json(res, { protocol: 1, ok: false, error: { class: cls, message: 'no' } }, status));
      const fallback = jest.fn();
      agentEvents.on('fallback', fallback);
      try {
        const { provider, inProcess } = make('sentinel.judge', s.url);
        expect((await provider.send(REQ)).meta.servedBy).toBe('in-process');
        expect(inProcess.send).toHaveBeenCalledTimes(1);
        expect(fallback).toHaveBeenCalledWith(expect.objectContaining({ group: 'trading', job: 'sentinel.judge' }));
      } finally {
        agentEvents.off('fallback', fallback);
        await s.close();
      }
    });
  }

  it('the start deadline sent to the agent is the queue budget (25 % of the timeout), inside the API abort', async () => {
    const s = await server((b, res) => json(res, { protocol: 1, ok: true, message: { content: [], stop_reason: 'end_turn' }, meta: META, queuedMs: 0, agent: 'trading' }));
    try {
      const { provider } = make('sentinel.judge', s.url);
      await provider.send(REQ);
      expect(s.bodies[0].deadlineMs).toBeLessThanOrEqual(500); // timeoutMs 2000 x AGENT_QUEUE_SHARE
      expect(s.bodies[0].deadlineMs).toBeGreaterThan(300);
    } finally {
      await s.close();
    }
  });
});

describe('applyProfile / errorFromAgentReply', () => {
  it('no overrides -> the same object', () => {
    expect(applyProfile(REQ, DEFAULT_PROFILE)).toBe(REQ);
    expect(applyProfile(REQ, { ...DEFAULT_PROFILE, model: 'claude-opus-5', effort: 'high', maxTokens: 2000 })).toBe(REQ);
  });

  it('unknown/odd class names are made safe', () => {
    expect(errorFromAgentReply({ class: 'not a name!', message: 'x' }, 'j').constructor.name).toBe('Error');
    expect(errorFromAgentReply({ class: 'APIConnectionTimeoutError', message: 'Request timed out.' }, 'j')).toBeInstanceOf(
      APIConnectionTimeoutError,
    );
  });
});

describe('AgentProvider: review fixes (stalled agents, queue budget, caller budget)', () => {
  afterEach(() => agentEvents.removeAllListeners());

  it('a stalled agent (accepts the connection, never answers) is cut off when health marks it dead -> in-process', async () => {
    const s = await server(() => undefined); // never replies
    try {
      const links = new AgentLinkState();
      const { provider, inProcess } = make('sentinel.judge', s.url, { links });
      const t0 = Date.now();
      const p = provider.send(REQ);
      await new Promise((r) => setTimeout(r, 100));
      links.markDead('trading', Date.now());
      const r = await p;
      expect(r.meta.servedBy).toBe('in-process');
      expect(inProcess.send).toHaveBeenCalledTimes(1);
      expect(Date.now() - t0).toBeLessThan(1000); // not the 2000 ms profile timeout
      // ...and while it is marked, the next call never touches the agent.
      await provider.send(REQ);
      expect(s.bodies).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it('a call that waited out its queue budget in the limiter is AgentBusyError, never sent with a sliver of time', async () => {
    const s = await server((b, res) => json(res, { protocol: 1, ok: true, message: { content: [], stop_reason: 'end_turn' }, meta: META, queuedMs: 0, agent: 'background' }));
    const limiter = new GlobalLimiter({ total: 1, tradingReserve: 0 });
    const hold = await limiter.acquire('other', false, 0);
    const timer = setTimeout(hold, 1500); // frees up with 500 ms of the 2000 ms timeout left
    try {
      const { provider } = make('news.ideas', s.url, { limiter });
      const t0 = Date.now();
      await expect(provider.send(REQ)).rejects.toBeInstanceOf(AgentBusyError);
      expect(Date.now() - t0).toBeLessThan(1200); // queue budget = 25 % of 2000 ms
      expect(s.bodies).toHaveLength(0);
    } finally {
      clearTimeout(timer);
      hold();
      await s.close();
    }
  });

  it('limiter wait = the queue budget; trading jobs wait at most TRADING_LIMITER_WAIT_MS', async () => {
    const acquire = jest.fn(async () => () => undefined);
    const limiter = { acquire, noteQuota: jest.fn() } as unknown as GlobalLimiter;
    const env = { AGENT_URL_TRADING: 'http://127.0.0.1:1', AGENT_URL_BACKGROUND: 'http://127.0.0.1:1' };
    const reg = parseAgentRegistry(
      {
        'sentinel.judge': { agent: 'in-process', concurrency: 6, timeoutMs: 300000, model: null, effort: null, maxTokens: null },
        'news.ideas': { agent: 'in-process', concurrency: 2, timeoutMs: 240000, model: null, effort: null, maxTokens: null },
      },
      env,
    );
    for (const job of ['sentinel.judge', 'news.ideas']) {
      const provider = new AgentProvider({ jobOf: () => job, inProcess: inProcessStub(), registry: reg, env, limiter, links: new AgentLinkState() });
      await provider.send(REQ);
    }
    expect(acquire.mock.calls[0]).toEqual(['sentinel.judge', true, TRADING_LIMITER_WAIT_MS]);
    expect(acquire.mock.calls[1]).toEqual(['news.ideas', false, 240000 * AGENT_QUEUE_SHARE]);
  });

  it("the caller's budget tightens the start deadline and the abort", async () => {
    const s = await server(() => undefined); // never replies: the abort decides
    try {
      const { provider, inProcess } = make('news.ideas', s.url);
      const t0 = Date.now();
      const p = withAgentCallBudget({ startBy: t0 + 100, abortAt: t0 + 600 }, () => provider.send(REQ));
      await expect(p).rejects.toBeInstanceOf(APIConnectionTimeoutError);
      const took = Date.now() - t0;
      expect(took).toBeGreaterThanOrEqual(550);
      expect(took).toBeLessThan(1500); // not the 2000 ms profile timeout
      expect(s.bodies[0].deadlineMs).toBeLessThanOrEqual(100);
      expect(inProcess.send).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  it("a caller whose start-by already passed gets AgentBusyError without a network call", async () => {
    const s = await server((b, res) => json(res, { protocol: 1, ok: true, message: { content: [], stop_reason: 'end_turn' }, meta: META, queuedMs: 0, agent: 'background' }));
    try {
      const { provider } = make('news.ideas', s.url);
      await expect(withAgentCallBudget({ startBy: Date.now() - 1 }, () => provider.send(REQ))).rejects.toBeInstanceOf(AgentBusyError);
      expect(s.bodies).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it('callWindow: 25 % queue share, min run budget, caller budget only tightens', () => {
    expect(callWindow(0, 300000)).toEqual({ deadlineAt: 300000, startBy: 75000 });
    expect(callWindow(0, 300000, { startBy: 45000, abortAt: 120000 })).toEqual({ deadlineAt: 120000, startBy: 45000 });
    expect(callWindow(0, 300000, { startBy: 999999, abortAt: 999999 })).toEqual({ deadlineAt: 300000, startBy: 75000 });
    // abortAt tight: the call must start with AGENT_MIN_RUN_MS left (or half its window, if smaller).
    expect(callWindow(0, 300000, { abortAt: 20000 })).toEqual({ deadlineAt: 20000, startBy: 15000 });
    expect(callWindow(0, 300000, { abortAt: 8000 })).toEqual({ deadlineAt: 8000, startBy: 4000 });
  });
});
