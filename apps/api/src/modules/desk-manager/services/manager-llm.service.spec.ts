import * as slot from '../../ai-assist/assist-slot';
import { parseDeskManagerConfig } from '../desk-manager.config';
import type { DeskPacket } from '../domain/desk.types';
import { managerSystemPrompt } from '../domain/manager-prompt';
import { MANAGER_JOB, ManagerLlmService, SUPREME_CONFIRM_JOB } from './manager-llm.service';

const REPLY = { summary: 'quiet', decisions: [{ action: 'NO_ACTION', reason: 'nothing', evidence: ['ltp 1'] }] };
const packet = { at: '2026-11-26T04:30:00.000Z', mode: 'shadow', positions: { status: 'unavailable', reason: 'timed out', source: 'x' } } as unknown as DeskPacket;

type Req = { model: string; output_config: { effort: string; format?: unknown }; system: Array<{ text: string; cache_control?: unknown }>; messages: Array<{ content: string }> };

function make(reply: { text?: string; stop_reason?: string } = {}) {
  const cli = {
    createWithMeta: jest.fn(async () => ({
      message: { stop_reason: reply.stop_reason ?? 'end_turn', content: [{ type: 'text', text: reply.text ?? JSON.stringify(REPLY) }] },
      meta: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, billed: false },
    })),
  };
  const audit = { insert: jest.fn(async () => undefined) };
  const cycle = { runShared: jest.fn((_id: string, work: () => Promise<unknown>) => work()) };
  const env: Record<string, string | undefined> = { SENTINEL_JUDGE: 'cli' };
  const cfg = parseDeskManagerConfig({ DESK_MANAGER: 'shadow', DESK_MANAGER_MODEL: 'claude-opus-test' });
  const svc = new ManagerLlmService({ get: (k: string) => env[k] } as never, cli as never, audit as never, cycle as never, cfg);
  const req = () => (cli.createWithMeta.mock.calls[0] as unknown as [Req])[0];
  return { svc, cli, audit, cycle, req, cfg };
}

describe('ManagerLlmService.decide', () => {
  it('sends job desk.manager, no output schema, effort high, the configured model; static prompt cached, packet last', async () => {
    const { svc, req, audit, cfg } = make();
    const out = await svc.decide('owner-1', packet);
    expect(JSON.parse(out.text)).toEqual(REPLY);
    expect(out.model).toBe('claude-opus-test');
    expect(req().model).toBe('claude-opus-test');
    expect(req().output_config.effort).toBe('high');
    // No grammar-constrained format: Vertex rejects MANAGER_REPLY_SCHEMA as too large; parseManagerReply checks the reply.
    expect(req().output_config.format).toBeUndefined();
    expect(req().system[0]).toMatchObject({ text: managerSystemPrompt(cfg), cache_control: { type: 'ephemeral' } });
    const msg = req().messages[0].content;
    expect(msg.endsWith(JSON.stringify(packet))).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect((audit.insert.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ job: MANAGER_JOB, userId: 'owner-1' });
    expect(MANAGER_JOB).toBe('desk.manager');
  });

  it('routes through runInSharedSlot with job desk.manager and the 120 s bound', async () => {
    const spy = jest.spyOn(slot, 'runInSharedSlot');
    try {
      await make().svc.decide('owner-1', packet);
      expect(spy.mock.calls[0][2]).toMatchObject({ job: 'desk.manager', lane: 'signals', timeoutMs: 120_000 });
    } finally {
      spy.mockRestore();
    }
  });

  it('authority off (isLive false or absent): the system prompt is exactly today\'s; live adds the trade-agents / BRIEF section', async () => {
    const { cli, audit, cycle, cfg } = make();
    const env: Record<string, string | undefined> = { SENTINEL_JUDGE: 'cli' };
    const build = (live: boolean | undefined) =>
      new ManagerLlmService({ get: (k: string) => env[k] } as never, cli as never, audit as never, cycle as never, cfg, live === undefined ? undefined : { isLive: () => live });
    expect(build(undefined).systemPrompt()).toBe(managerSystemPrompt(cfg));
    expect(build(false).systemPrompt()).toBe(managerSystemPrompt(cfg));
    expect(managerSystemPrompt(cfg)).not.toMatch(/BRIEF|hasBrief/);
    const live = build(true).systemPrompt();
    expect(live.startsWith(managerSystemPrompt(cfg))).toBe(true);
    expect(live).toMatch(/every position with hasBrief false, return a BRIEF/i);
    expect(live).toContain('BRIEF: { action "BRIEF", trackerId (from packet.positions), text (20-1500 chars) }');
    expect(live).toMatch(/sent to its trade agent as an instruction/);
    await build(true).decide('owner-1', packet);
    const sentSystem = (cli.createWithMeta.mock.calls.at(-1) as unknown as [Req])[0].system[0].text;
    expect(sentSystem).toBe(live);
  });

  it('send(): the confirm call goes through its own job desk.confirm with the caller\'s bound', async () => {
    const spy = jest.spyOn(slot, 'runInSharedSlot');
    try {
      const { svc, audit } = make({ text: '{"decision":"CONFIRM","reason":"r"}' });
      const text = await svc.send('owner-1', { model: 'm', max_tokens: 800, messages: [{ role: 'user', content: 'x' }] } as never, 30_000);
      expect(text).toBe('{"decision":"CONFIRM","reason":"r"}');
      expect(spy.mock.calls[0][2]).toMatchObject({ job: SUPREME_CONFIRM_JOB, timeoutMs: 30_000, maxWaitMs: 30_000 });
      await new Promise((r) => setImmediate(r));
      expect((audit.insert.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ job: 'desk.confirm', userId: 'owner-1' });
    } finally {
      spy.mockRestore();
    }
  });

  it('a refusal throws', async () => {
    await expect(make({ stop_reason: 'refusal', text: '' }).svc.decide('owner-1', packet)).rejects.toThrow(/declined/);
  });

  it('the prompt carries the class ceilings, the 15m rule, the evidence rule and underlying levels', () => {
    const p = managerSystemPrompt(parseDeskManagerConfig({ HARD_LOSS_CEILING_BY_CLASS: 'INDEX_OPT:4500' }));
    expect(p).toContain('INDEX_OPT ₹4500');
    expect(p).toContain('STOCK_OPT ₹3000');
    expect(p).toMatch(/15 minutes is the smallest unit/);
    expect(p).toMatch(/cites numbers from the packet in evidence/);
    expect(p).toMatch(/Levels are on the UNDERLYING/);
    expect(p).toMatch(/inside the ceiling.*else NO_ACTION/);
    expect(p).toContain('When you decline a proposal, return NO_ACTION with its proposalRef');
  });
});
