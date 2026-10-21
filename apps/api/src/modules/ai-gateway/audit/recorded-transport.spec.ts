import { Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { withAiCallContext } from './ai-call-context';
import {
  AI_CALL_TEXT_CAP_BYTES,
  aiCallsRecordingOn,
  capUtf8,
  directRecordedTransport,
  RecordedTransport,
  requestRecord,
} from './recorded-transport';
import type { AiCallRow } from './ai-call.repository';
import type { ProviderAdapter, ProviderResult } from '../providers/provider.types';
import type { TransportRequest } from '../transport.types';
import { ClaudeCliProvider, ClaudeCliTransport } from '../providers/claude-cli.provider';
import { AnthropicApiProvider } from '../providers/anthropic-api.provider';

const REQ: TransportRequest = {
  model: 'claude-opus-5',
  max_tokens: 2000,
  output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } },
  system: [{ type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: '{"position":{"symbol":"NIFTY"}}' }],
};

function result(over: Partial<ProviderResult['meta']> = {}, text = '{"verdict":"HOLD"}'): ProviderResult {
  return {
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
    meta: {
      inputTokens: 1200,
      outputTokens: 300,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 900,
      billed: false,
      ...over,
    },
  };
}

function make(opts: { send?: jest.Mock; insert?: jest.Mock; name?: ProviderAdapter['name']; prices?: Map<string, any> } = {}) {
  const send = opts.send ?? jest.fn().mockResolvedValue(result());
  const insert = opts.insert ?? jest.fn().mockResolvedValue(undefined);
  const adapter: ProviderAdapter = { name: opts.name ?? 'claude-cli', send };
  let t = 1000;
  const transport = new RecordedTransport({
    adapter,
    audit: { insert },
    jobOf: () => 'sentinel.judge',
    prices: opts.prices,
    now: () => (t += 250),
  });
  return { transport, send, insert };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('RecordedTransport', () => {
  afterEach(() => jest.restoreAllMocks());

  it('passes the request through untouched and returns the provider message by reference', async () => {
    const r = result();
    const { transport, send } = make({ send: jest.fn().mockResolvedValue(r) });
    const msg = await transport.messages.create(REQ);
    expect(send).toHaveBeenCalledWith(REQ);
    expect(send.mock.calls[0][0]).toBe(REQ);
    expect(msg).toBe(r.message);
  });

  it('writes one ai_calls row per successful call, with context, tokens, text and latency', async () => {
    const { transport, insert } = make();
    await withAiCallContext({ userId: 'u1', positionId: 'trk1' }, () => transport.messages.create(REQ));
    await flush();
    expect(insert).toHaveBeenCalledTimes(1);
    const row: AiCallRow = insert.mock.calls[0][0];
    expect(row).toMatchObject({
      job: 'sentinel.judge',
      provider: 'claude-cli',
      model: 'claude-opus-5',
      effort: 'high',
      userId: 'u1',
      positionId: 'trk1',
      stopReason: 'end_turn',
      inputTokens: 1200,
      outputTokens: 300,
      costInr: 0, // CLI: subscription, never metered
      latencyMs: 250,
      errorClass: null,
      errorMessage: null,
    });
    expect(row.requestHash).toBe(createHash('sha256').update(JSON.stringify(REQ)).digest('hex'));
    expect(row.request).toMatchObject({
      system: [{ type: 'text', text: 'SYSTEM PROMPT' }],
      messages: [{ role: 'user', content: REQ.messages[0].content }],
      max_tokens: 2000,
      output_config: { effort: 'high' },
    });
    expect(row.response).toMatchObject({
      content: [{ type: 'text', text: '{"verdict":"HOLD"}' }],
      stop_reason: 'end_turn',
      truncated: false,
      usage: { cache_creation_input_tokens: 50, cache_read_input_tokens: 900 },
    });
  });

  it('records NULL tokens when the provider did not report them (never invented)', async () => {
    const { transport, insert } = make({
      send: jest.fn().mockResolvedValue(result({ inputTokens: null, outputTokens: null })),
    });
    await transport.messages.create(REQ);
    await flush();
    expect(insert.mock.calls[0][0]).toMatchObject({ inputTokens: null, outputTokens: null, userId: null, positionId: null });
  });

  it('prices billed API calls from the price table', async () => {
    const prices = new Map([
      ['claude-opus-5', { inputPerMTokInr: 1000, outputPerMTokInr: 5000, cacheWritePerMTokInr: 1250, cacheReadPerMTokInr: 100 }],
    ]);
    const { transport, insert } = make({
      name: 'anthropic-api',
      prices,
      send: jest.fn().mockResolvedValue(result({ billed: true })),
    });
    await transport.messages.create(REQ);
    await flush();
    // (1200*1000 + 300*5000 + 50*1250 + 900*100) / 1e6
    expect(insert.mock.calls[0][0].costInr).toBeCloseTo(2.8525, 6);
    expect(insert.mock.calls[0][0].provider).toBe('anthropic-api');
  });

  it('records a failed call and rethrows the ORIGINAL error instance', async () => {
    class RateLimitError extends Error {}
    const boom = new RateLimitError('429 slow down');
    const { transport, insert } = make({ send: jest.fn().mockRejectedValue(boom) });
    await expect(transport.messages.create(REQ)).rejects.toBe(boom);
    await flush();
    expect(insert.mock.calls[0][0]).toMatchObject({
      errorClass: 'RateLimitError',
      errorMessage: '429 slow down',
      response: null,
      stopReason: null,
      inputTokens: null,
    });
  });

  it('a failing or throwing DB write never fails or delays the call', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const rejecting = make({ insert: jest.fn().mockRejectedValue(new Error('db down')) });
    await expect(rejecting.transport.messages.create(REQ)).resolves.toBeDefined();
    const throwing = make({
      insert: jest.fn(() => {
        throw new Error('sync boom');
      }),
    });
    await expect(throwing.transport.messages.create(REQ)).resolves.toBeDefined();
    const hanging = make({ insert: jest.fn(() => new Promise<void>(() => undefined)) });
    await expect(hanging.transport.messages.create(REQ)).resolves.toBeDefined();
    await flush();
    expect(rejecting.transport.auditWriteFailures).toBe(1);
    expect(throwing.transport.auditWriteFailures).toBe(1);
    expect(error).toHaveBeenCalled();
  });

  it('caps the stored request and response at ~60 KB each, user turn first', async () => {
    const bigUser = 'u'.repeat(70 * 1024);
    const bigReply = 'r'.repeat(80 * 1024);
    const { transport, insert } = make({ send: jest.fn().mockResolvedValue(result({}, bigReply)) });
    const req = { ...REQ, messages: [{ role: 'user' as const, content: bigUser }] };
    await transport.messages.create(req);
    await flush();
    const row: AiCallRow = insert.mock.calls[0][0];
    const request = row.request as any;
    expect(Buffer.byteLength(request.messages[0].content)).toBe(AI_CALL_TEXT_CAP_BYTES);
    expect(request.system).toEqual([{ type: 'text', text: '' }]); // no room left; still identified by hash
    expect(request.systemSha256).toBe(createHash('sha256').update('SYSTEM PROMPT').digest('hex'));
    expect(request.truncated).toEqual({ system: true, user: true });
    expect(request.bytes.user).toBe(70 * 1024);
    const response = row.response as any;
    expect(Buffer.byteLength(response.content[0].text)).toBe(AI_CALL_TEXT_CAP_BYTES);
    expect(response.truncated).toBe(true);
    expect(response.bytes).toBe(80 * 1024);
  });

  it('stores the system prompt in full once, then by hash; a failed write does not count', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const insert = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    const { transport } = make({ insert });
    for (let i = 0; i < 3; i++) {
      await transport.messages.create(REQ);
      await flush();
    }
    const stored = insert.mock.calls.map((c) => (c[0] as AiCallRow).request as any);
    expect(stored.map((r) => r.systemStored)).toEqual(['full', 'full', 'by-hash']);
    expect(stored[1].system).toEqual([{ type: 'text', text: 'SYSTEM PROMPT' }]);
    expect(stored[2].system).toEqual([]);
    expect(stored[2].systemSha256).toBe(stored[1].systemSha256);
    const other = { ...REQ, system: [{ type: 'text' as const, text: 'ANOTHER PROMPT' }] };
    await transport.messages.create(other);
    await flush();
    expect((insert.mock.calls[3][0] as AiCallRow).request).toMatchObject({
      systemStored: 'full',
      system: [{ type: 'text', text: 'ANOTHER PROMPT' }],
    });
  });

  it('a request that fits is stored whole', () => {
    expect(requestRecord(REQ)).toMatchObject({ truncated: { system: false, user: false } });
  });
});

describe('capUtf8', () => {
  it('never cuts mid-character', () => {
    const r = capUtf8('₹₹₹', 4); // each ₹ is 3 bytes
    expect(r).toEqual({ text: '₹', bytes: 9, truncated: true });
  });
});

describe('aiCallsRecordingOn / directRecordedTransport', () => {
  it('records unless AI_CALLS_RECORD is off/false/0', () => {
    expect(aiCallsRecordingOn(undefined)).toBe(true);
    expect(aiCallsRecordingOn('on')).toBe(true);
    for (const v of ['off', 'OFF', 'false', '0']) expect(aiCallsRecordingOn(v)).toBe(false);
  });

  const cli = { createWithMeta: jest.fn() } as unknown as ClaudeCliTransport;
  const audit = { insert: jest.fn() };

  it('recording on: wraps the SHARED cli transport, or a fresh Anthropic client', () => {
    const c = directRecordedTransport({ judge: 'cli', cli, apiKey: 'k', record: true, audit, jobOf: () => 'x' });
    expect(c).toBeInstanceOf(RecordedTransport);
    const ca = (c as RecordedTransport).deps.adapter as ClaudeCliProvider;
    expect(ca).toBeInstanceOf(ClaudeCliProvider);
    expect((ca as unknown as { cli: unknown }).cli).toBe(cli);
    const a = directRecordedTransport({ judge: 'api', cli, apiKey: 'k', record: true, audit, jobOf: () => 'x' });
    const aa = (a as RecordedTransport).deps.adapter as AnthropicApiProvider;
    expect(aa).toBeInstanceOf(AnthropicApiProvider);
    expect((aa as unknown as { client: unknown }).client).toBeInstanceOf(Anthropic);
  });

  it('recording off: exactly the unwrapped transport', () => {
    expect(directRecordedTransport({ judge: 'cli', cli, apiKey: 'k', record: false, audit, jobOf: () => 'x' })).toBe(cli);
    expect(directRecordedTransport({ judge: 'api', cli, apiKey: 'k', record: false, audit, jobOf: () => 'x' })).toBeInstanceOf(
      Anthropic,
    );
  });
});
