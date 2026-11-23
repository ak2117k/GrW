import type { ConfigService } from '@nestjs/config';
import type { AiCallRepository } from '../../ai-gateway/audit/ai-call.repository';
import type { ClaudeCliTransport } from '../../ai-gateway/providers/claude-cli.provider';
import type { SentinelCycleService } from '../../trade-sentinel/services/sentinel-cycle.service';
import { NEWS_BRIEF_SCHEMA, NEWS_READ_SCHEMA } from '../domain/news-ai.schemas';
import { cfg } from '../testing/fakes';
import { NewsAiLlmService, NewsAiReplyError } from './news-ai-llm.service';

const create = jest.fn();
const transportOpts: Array<{ judge: string; jobOf: () => string }> = [];

jest.mock('../../ai-gateway/audit/recorded-transport', () => ({
  aiCallsRecordingOn: () => true,
  directRecordedTransport: (opts: { judge: string; jobOf: () => string }) => {
    transportOpts.push(opts);
    return { messages: { create } };
  },
}));

function svc(judge = 'vertex') {
  const config = { get: (k: string) => (k === 'SENTINEL_JUDGE' ? judge : undefined) } as unknown as ConfigService;
  return new NewsAiLlmService(config, {} as ClaudeCliTransport, {} as AiCallRepository, {} as SentinelCycleService, cfg({ ownerUserId: 'o' }));
}

describe('NewsAiLlmService (fake transport, no real AI)', () => {
  beforeEach(() => {
    create.mockReset();
    transportOpts.length = 0;
  });

  it('per-article read: job news.sentiment, Sonnet, effort medium, json_schema output; reply parsed', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"direction":"BULL"}' }] });
    const s = svc();
    await expect(s.readArticle('Title: x')).resolves.toEqual({ direction: 'BULL' });
    const req = create.mock.calls[0][0];
    expect(req.model).toBe('claude-sonnet-5');
    expect(req.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema: NEWS_READ_SCHEMA } });
    expect(req.messages).toEqual([{ role: 'user', content: 'Title: x' }]);
    expect(transportOpts[0].judge).toBe('vertex');
    expect(transportOpts[0].jobOf()).toBe('news.sentiment');
  });

  it('brief: job news.brief, Opus, effort high; one transport per job', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"headline":"h"}' }] });
    const s = svc();
    await s.writeBrief('m');
    await s.writeBrief('m2');
    const req = create.mock.calls[0][0];
    expect(req.model).toBe('claude-opus-5');
    expect(req.output_config.effort).toBe('high');
    expect(req.output_config.format.schema).toBe(NEWS_BRIEF_SCHEMA);
    expect(transportOpts).toHaveLength(1);
    expect(transportOpts[0].jobOf()).toBe('news.brief');
  });

  it('a non-JSON reply throws NewsAiReplyError (the caller records a failed attempt)', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: 'Sure! Here is my analysis' }] });
    const err = await svc().readArticle('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NewsAiReplyError);
    expect((err as Error).message).toMatch(/not JSON/);
  });

  it('a transport error passes through as-is (NOT a reply error, so not an attempt)', async () => {
    create.mockRejectedValue(Object.assign(new Error('529 overloaded'), { status: 529 }));
    const err = await svc().readArticle('x').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NewsAiReplyError);
    expect((err as Error).message).toMatch(/529/);
  });
});
