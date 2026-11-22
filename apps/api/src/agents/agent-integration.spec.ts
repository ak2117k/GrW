/**
 * Integration (design 2026-11-22 §5): the real agent HTTP server on a random port with a fake Vertex
 * provider, driven by the API's real AgentProvider inside a real RecordedTransport — asserting the
 * `ai_calls` row (agent, queuedMs) and that the request hash is the same as with agents off.
 */
import { RateLimitError } from '@anthropic-ai/sdk';
import { AgentLinkState, AgentProvider } from '../modules/ai-gateway/agents/agent-provider';
import { AgentBusyError } from '../modules/ai-gateway/agents/agent-protocol';
import { parseAgentRegistry, type AgentGroup } from '../modules/ai-gateway/agents/agent-registry';
import { GlobalLimiter } from '../modules/ai-gateway/agents/global-limiter';
import type { AiCallRow } from '../modules/ai-gateway/audit/ai-call.repository';
import { RecordedTransport } from '../modules/ai-gateway/audit/recorded-transport';
import type { ProviderAdapter, ProviderResult } from '../modules/ai-gateway/providers/provider.types';
import type { TransportRequest } from '../modules/ai-gateway/transport.types';
import { AgentServer } from './agent-server';

const FILE = {
  'sentinel.judge': { agent: 'trading', concurrency: 2, timeoutMs: 5000, model: null, effort: null, maxTokens: null },
  'news.impact': { agent: 'reading', concurrency: 2, timeoutMs: 5000, model: null, effort: null, maxTokens: null },
  'backtest.*': { agent: 'background', concurrency: 1, timeoutMs: 1000, model: null, effort: null, maxTokens: null },
};
const registry = parseAgentRegistry(FILE, {}, () => undefined);

const REQ = (job: string): TransportRequest => ({
  model: 'claude-opus-5',
  max_tokens: 500,
  output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } },
  system: [{ type: 'text', text: `SYS ${job}` }],
  messages: [{ role: 'user', content: 'hello' }],
});

const OK: ProviderResult = {
  message: { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' },
  meta: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: null, cacheReadInputTokens: null, billed: true },
};

const jobOfReq = (req: TransportRequest): string => String((req.system?.[0] as { text: string }).text).slice(4);

function inProcessStub(): ProviderAdapter & { send: jest.Mock } {
  return { name: 'anthropic-vertex', modelFor: (m: string) => m, send: jest.fn(async () => OK) };
}

describe('agent server + AgentProvider + RecordedTransport', () => {
  const servers: AgentServer[] = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()!.stop(100);
  });

  async function start(group: AgentGroup, send: jest.Mock): Promise<string> {
    const s = new AgentServer({ group, registry, provider: { send }, log: () => undefined });
    servers.push(s);
    const port = await s.listen(0, '127.0.0.1');
    return `http://127.0.0.1:${port}`;
  }

  function transport(urls: Partial<Record<AgentGroup, string>>, inProcess = inProcessStub()) {
    const env: NodeJS.ProcessEnv = {
      AGENT_URL_TRADING: urls.trading ?? 'http://127.0.0.1:1',
      AGENT_URL_READING: urls.reading ?? 'http://127.0.0.1:1',
      AGENT_URL_BACKGROUND: urls.background ?? 'http://127.0.0.1:1',
    };
    const insert = jest.fn<Promise<void>, [AiCallRow]>().mockResolvedValue(undefined);
    const adapter = new AgentProvider({
      jobOf: jobOfReq,
      inProcess,
      registry,
      env,
      limiter: new GlobalLimiter({ total: 16, tradingReserve: 6 }),
      links: new AgentLinkState(),
    });
    const t = new RecordedTransport({ adapter, audit: { insert }, jobOf: jobOfReq });
    return { t, insert, inProcess };
  }

  it('served by the agent: ai_calls.agent = the group, queuedMs recorded, request hash unchanged vs agents off', async () => {
    const send = jest.fn(async (_req: TransportRequest) => OK);
    const url = await start('trading', send);
    const { t, insert, inProcess } = transport({ trading: url });
    const msg = await t.messages.create(REQ('sentinel.judge'));
    expect(msg).toEqual(OK.message);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual(REQ('sentinel.judge'));
    expect(inProcess.send).not.toHaveBeenCalled();
    const row = insert.mock.calls[0][0];
    expect(row).toMatchObject({ job: 'sentinel.judge', agent: 'trading', errorClass: null, provider: 'anthropic-vertex' });
    expect(row.queuedMs).toBeGreaterThanOrEqual(0);

    // Agents off: the bare provider in the same RecordedTransport.
    const offInsert = jest.fn<Promise<void>, [AiCallRow]>().mockResolvedValue(undefined);
    const off = new RecordedTransport({ adapter: inProcessStub(), audit: { insert: offInsert }, jobOf: jobOfReq });
    await off.messages.create(REQ('sentinel.judge'));
    const offRow = offInsert.mock.calls[0][0];
    expect(offRow.requestHash).toBe(row.requestHash);
    expect(offRow.agent ?? null).toBeNull();
    expect(offRow.queuedMs).toBe(0);
  });

  it('a model error passes through as the real SDK class and is recorded against the agent', async () => {
    const send = jest.fn(async () => {
      throw new RateLimitError(429, undefined, 'quota', new Headers());
    });
    const url = await start('reading', send);
    const { t, insert, inProcess } = transport({ reading: url });
    const err = await t.messages.create(REQ('news.impact')).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(429);
    expect(inProcess.send).not.toHaveBeenCalled();
    expect(insert.mock.calls[0][0]).toMatchObject({ agent: 'reading', errorClass: 'RateLimitError' });
  });

  it('a job sent to the wrong agent (routing drift) is served in-process, never lost', async () => {
    const url = await start('reading', jest.fn(async () => OK));
    // sentinel.judge belongs to trading; point the trading URL at the reading agent.
    const { t, insert, inProcess } = transport({ trading: url });
    await t.messages.create(REQ('sentinel.judge'));
    expect(inProcess.send).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0].agent).toBe('in-process');
  });

  it('an agent that is shutting down (503 AgentUnavailable) or gone is served in-process', async () => {
    let release!: () => void;
    const send = jest.fn(() => new Promise<ProviderResult>((r) => (release = () => r(OK))));
    const s = new AgentServer({ group: 'trading', registry, provider: { send }, log: () => undefined });
    const port = await s.listen(0, '127.0.0.1');
    const { t, insert, inProcess } = transport({ trading: `http://127.0.0.1:${port}` });
    const first = t.messages.create(REQ('sentinel.judge'));
    await new Promise((r) => setTimeout(r, 50));
    const stopping = s.stop(2000);
    // While draining, a new call gets 503 AgentUnavailable (or a refused connection) -> in-process.
    await t.messages.create(REQ('sentinel.judge'));
    expect(inProcess.send).toHaveBeenCalledTimes(1);
    release();
    await first;
    await stopping;
    expect(insert.mock.calls.map((c) => c[0].agent).sort()).toEqual(['in-process', 'trading']);
  });

  it('backtest.* jobs share ONE semaphore of the wildcard entry; past the deadline -> AgentBusyError, no fallback', async () => {
    let release!: () => void;
    const send = jest.fn(() => new Promise<ProviderResult>((r) => (release = () => r(OK))));
    const url = await start('background', send);
    const { t, inProcess } = transport({ background: url });
    const first = t.messages.create(REQ('backtest.spec'));
    await new Promise((r) => setTimeout(r, 50));
    const second = await t.messages.create(REQ('backtest.summary')).catch((e) => e);
    expect(second).toBeInstanceOf(AgentBusyError);
    expect(inProcess.send).not.toHaveBeenCalled();
    release();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
  });
});
