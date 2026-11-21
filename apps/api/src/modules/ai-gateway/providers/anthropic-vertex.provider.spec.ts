import { judgeTransportFrom, vertexModelId, vertexModelMapFrom } from '../../trade-sentinel/services/llm-transport';
import { RecordedTransport } from '../audit/recorded-transport';
import type { AiCallRow } from '../audit/ai-call.repository';
import { loadRoutes, readAiConfig } from '../routes/route-config';
import type { TransportRequest } from '../transport.types';
import type { AnthropicApiReply, AnthropicMessagesClient } from './anthropic-api.provider';
import { AnthropicVertexProvider, createVertexClient, vertexSettingsFrom } from './anthropic-vertex.provider';

const reply: AnthropicApiReply = {
  content: [{ type: 'text', text: '{}' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
} as AnthropicApiReply;

function req(model: string, extra: Partial<TransportRequest> = {}): TransportRequest {
  return {
    model,
    max_tokens: 100,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: {} } },
    system: [{ type: 'text', text: 'sys' }],
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  } as TransportRequest;
}

function fakeClient(): AnthropicMessagesClient & { sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  return { sent, messages: { create: async (p: TransportRequest) => (sent.push(p), reply) } };
}

describe('SENTINEL_JUDGE=vertex', () => {
  it('parses vertex (any case) and keeps the api default', () => {
    expect(judgeTransportFrom(' Vertex ')).toBe('vertex');
    expect(judgeTransportFrom(undefined)).toBe('api');
  });

  it('maps each tier to its current release; Haiku to Sonnet 5.5 until enabled on the project', () => {
    expect(vertexModelId('claude-opus-5')).toBe('claude-opus-5-5');
    expect(vertexModelId('claude-sonnet-5')).toBe('claude-sonnet-5-5');
    expect(vertexModelId('claude-haiku-5-5')).toBe('claude-sonnet-5-5');
    expect(vertexModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(vertexModelId('anthropic.claude-opus-5')).toBe('claude-opus-5-5');
    expect(vertexModelId('claude-fable-5-2')).toBe('claude-fable-5-2');
  });

  it('VERTEX_MODEL_MAP overrides the table (e.g. restore Haiku once enabled)', () => {
    const map = vertexModelMapFrom(' claude-haiku-5-5 = claude-haiku-5-5 , junk, =x');
    expect(map).toEqual({ 'claude-haiku-5-5': 'claude-haiku-5-5' });
    expect(vertexModelId('claude-haiku-5-5', map)).toBe('claude-haiku-5-5');
    expect(new AnthropicVertexProvider(fakeClient(), map).modelFor('claude-haiku-5-5')).toBe('claude-haiku-5-5');
  });

  it('reads project and region from env, region defaulting to global', () => {
    expect(vertexSettingsFrom({ VERTEX_AI_PROJECT_ID: ' p1 ' } as NodeJS.ProcessEnv)).toEqual({ projectId: 'p1', region: 'global' });
    expect(vertexSettingsFrom({ VERTEX_AI_LOCATION: 'us-east5' } as NodeJS.ProcessEnv)).toEqual({ projectId: undefined, region: 'us-east5' });
  });

  it('builds the SDK client only on the first request (no credential lookup at boot)', async () => {
    const build = jest.fn(() => fakeClient());
    const client = createVertexClient({ projectId: 'p', region: 'global' }, build);
    expect(build).not.toHaveBeenCalled();
    await client.messages.create(req('claude-opus-5'));
    await client.messages.create(req('claude-opus-5'));
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('sends the mapped model, strips CLI hints, and reports billed usage', async () => {
    const client = fakeClient();
    const provider = new AnthropicVertexProvider(client);
    const out = await provider.send(req('claude-opus-5', { cli: { effort: 'medium' } } as Partial<TransportRequest>));
    expect(provider.name).toBe('anthropic-vertex');
    expect(client.sent[0].model).toBe('claude-opus-5-5');
    expect('cli' in client.sent[0]).toBe(false);
    expect(client.sent[0].output_config.effort).toBe('medium');
    expect(out.meta).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, billed: true });
  });

  it('records the served model and provider in ai_calls', async () => {
    const rows: AiCallRow[] = [];
    const t = new RecordedTransport({
      adapter: new AnthropicVertexProvider(fakeClient()),
      audit: { insert: async (r) => void rows.push(r) },
      jobOf: () => 'signal.judge',
      prices: new Map([['claude-opus-5-5', { inputPerMTokInr: 352, outputPerMTokInr: 1760, cacheWritePerMTokInr: 440, cacheReadPerMTokInr: 35.2 }]]),
    });
    await t.messages.create(req('claude-opus-5'));
    await new Promise((r) => setImmediate(r));
    expect(rows[0]).toMatchObject({ provider: 'anthropic-vertex', model: 'claude-opus-5-5' });
    expect(rows[0].costInr).toBeGreaterThan(0);
  });

  it('routes sentinel jobs through the gateway to anthropic-vertex', () => {
    const routes = loadRoutes(readAiConfig('ai-routes.json'), { SENTINEL_JUDGE: 'vertex' } as NodeJS.ProcessEnv);
    expect(Object.values(routes).some((r) => r.provider === 'anthropic-vertex')).toBe(true);
  });
});
