import { AssistLlmService } from './assist-llm.service';

describe('AssistLlmService — the advisor without token guard rails (2026-11-22)', () => {
  function build(env: Record<string, string>) {
    const config = { get: (k: string) => env[k] };
    const sent: any[] = [];
    const cycle = { runShared: jest.fn() };
    const svc = new AssistLlmService(config as any, {} as any, {} as any, cycle as any);
    const reply = { content: [{ type: 'text', text: '{"answer":"ok","confidence":80,"offTopic":false}' }], stop_reason: 'end_turn' };
    (svc as any).transportFor = () => ({ messages: { create: async (r: any) => (sent.push(r), reply) } });
    return { svc, sent, cycle };
  }

  it('advisor: Opus, high effort, 16k reply ceiling; AI_ADVISOR_MODEL overrides', () => {
    expect(build({}).svc.profileFor('assist.advisor')).toEqual({ model: 'claude-opus-5', effort: 'high', maxTokens: 16_000, unthrottled: true });
    expect(build({ AI_ADVISOR_MODEL: 'claude-sonnet-5' }).svc.profileFor('assist.advisor').model).toBe('claude-sonnet-5');
  });

  it('other assist jobs keep Sonnet / medium / 2k and the shared slot', () => {
    expect(build({}).svc.profileFor('assist.news')).toEqual({ model: 'claude-sonnet-5', effort: 'medium', maxTokens: 2_000, unthrottled: false });
  });

  it('on a metered transport (vertex) the advisor skips the shared slot — no "busy"', async () => {
    const { svc, sent, cycle } = build({ SENTINEL_JUDGE: 'vertex' });
    const out = await svc.complete('assist.advisor', 'sys', 'q');
    expect(out.answer).toBe('ok');
    expect(cycle.runShared).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ model: 'claude-opus-5', max_tokens: 16_000, output_config: { effort: 'high' } });
  });

  it('on the CLI the advisor still waits for the shared slot (one local process)', async () => {
    const { svc, cycle } = build({ SENTINEL_JUDGE: 'cli' });
    cycle.runShared.mockImplementation(async (_id: string, fn: () => Promise<unknown>) => fn());
    await svc.complete('assist.advisor', 'sys', 'q', { maxWaitMs: 1000 });
    expect(cycle.runShared).toHaveBeenCalled();
  });
});
