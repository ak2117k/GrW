import { OVERNIGHT_VERDICT_SCHEMA, VERDICT_SCHEMA } from '../../trade-sentinel/services/sentinel-agent.service';
import { THESIS_SCHEMA } from '../../trade-sentinel/services/thesis.service';
import type { AiGateway } from '../ai-gateway.service';
import type { TransportRequest } from '../transport.types';
import { SentinelGatewayTransport, jobFor } from './sentinel-gateway.transport';

const req = (schema: unknown): TransportRequest => ({
  model: 'claude-opus-5',
  max_tokens: 16000,
  output_config: { effort: 'high', format: { type: 'json_schema', schema: schema as Record<string, unknown> } },
  system: [{ type: 'text', text: 'sys' }],
  messages: [{ role: 'user', content: 'p' }],
});

describe('jobFor', () => {
  it('maps the three sentinel schema constants by identity', () => {
    expect(jobFor(req(VERDICT_SCHEMA))).toBe('sentinel.judge');
    expect(jobFor(req(OVERNIGHT_VERDICT_SCHEMA))).toBe('sentinel.overnight');
    expect(jobFor(req(THESIS_SCHEMA))).toBe('sentinel.thesis');
  });

  it('a deep-equal copy of a known schema is NOT recognised (identity, not shape)', () => {
    expect(jobFor(req(JSON.parse(JSON.stringify(VERDICT_SCHEMA))))).toBe('sentinel.unknown');
  });

  it('a foreign or missing schema maps to sentinel.unknown', () => {
    expect(jobFor(req({ type: 'object' }))).toBe('sentinel.unknown');
    expect(jobFor({ ...req({}), output_config: undefined } as unknown as TransportRequest)).toBe('sentinel.unknown');
  });
});

describe('SentinelGatewayTransport', () => {
  it('passes the same params reference to the gateway with the inferred job and returns its message', async () => {
    const message = { content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' };
    const call = jest.fn().mockResolvedValue(message);
    const gateway: AiGateway = { call };
    const t = new SentinelGatewayTransport(gateway);
    const params = req(THESIS_SCHEMA);
    await expect(t.messages.create(params)).resolves.toBe(message);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]).toHaveLength(2);
    expect(call.mock.calls[0][0]).toBe('sentinel.thesis');
    expect(call.mock.calls[0][1]).toBe(params);
  });

  it('propagates the gateway rejection as the same instance', async () => {
    const err = new Error('x');
    const t = new SentinelGatewayTransport({ call: jest.fn().mockRejectedValue(err) });
    await expect(t.messages.create(req(VERDICT_SCHEMA))).rejects.toBe(err);
  });
});
