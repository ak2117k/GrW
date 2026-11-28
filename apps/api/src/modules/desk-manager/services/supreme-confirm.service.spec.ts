import { Logger } from '@nestjs/common';
import type { ConfirmRequest } from '../../exit-authority/exit-authority.tokens';
import { parseDeskManagerConfig } from '../desk-manager.config';
import { confirmSystemPrompt } from '../domain/confirm-prompt';
import type { MemoryView } from '../domain/desk.types';
import { CONFIRM_MAX_TOKENS, SUPREME_CONFIRM_RUN_ID, SupremeConfirmService } from './supreme-confirm.service';

const MEMORY: MemoryView = { today: [{ at: '2026-11-27T04:00:00.000Z', action: 'OPEN', underlying: 'BSE', status: 'DONE', result: 'DONE: live BUY_CE' }], scorecard: null, lessons: ['desk-manager: book at target 1 on expiry day'] };

const req = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  userId: 'owner', trackerId: 't1', symbol: 'BSE30DEC253900CE', agentDecision: 'BOOK', agentReason: 'target 1 reached, momentum fading on 15m',
  alarm: null, brief: 'Plan: book half at 3950.', packetSummary: 'ltp 3952, pnl +3750', ...over,
});

type Req = { model: string; max_tokens: number; output_config: { effort: string }; system: Array<{ text: string }>; messages: Array<{ content: string }> };

function make(send: jest.Mock = jest.fn(async () => '{"decision":"CONFIRM","reason":"target hit"}')) {
  const cfg = parseDeskManagerConfig({ DESK_MANAGER: 'live', HUB_OWNER_USER_ID: 'owner', DESK_MANAGER_MODEL: 'claude-opus-test' });
  const state = { memory: jest.fn(async () => MEMORY) };
  const prisma = { deskManagerDecision: { create: jest.fn(async () => ({ id: 'row1' })) } };
  const svc = new SupremeConfirmService({ send } as never, state as never, prisma as never, cfg);
  const sent = () => (send.mock.calls[0] as unknown as [string, Req, number]);
  return { svc, send, state, prisma, cfg, sent };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('SupremeConfirmService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('one request: the manager model, effort medium, ≤ 800 tokens, confirmSystemPrompt, 30 s bound', async () => {
    const h = make();
    const r = await h.svc.confirm(req());
    expect(r).toEqual(expect.objectContaining({ decision: 'CONFIRM', reason: 'target hit', briefNote: null }));
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(h.send).toHaveBeenCalledTimes(1);
    const [userId, request, timeoutMs] = h.sent();
    expect(userId).toBe('owner');
    expect(request.model).toBe('claude-opus-test');
    expect(request.output_config.effort).toBe('medium');
    expect(request.max_tokens).toBe(CONFIRM_MAX_TOKENS);
    expect(request.max_tokens).toBeLessThanOrEqual(800);
    expect(request.system[0].text).toBe(confirmSystemPrompt(h.cfg));
    expect(timeoutMs).toBe(30_000);
  });

  it('the user content has the agent decision, reason, alarm, brief, packetSummary and the desk memory block', async () => {
    const h = make();
    const alarm = { id: 'a1', rule: 'TARGET_LOCK', urgency: 'normal', reason: 'crossed target 1', wouldHave: 'TIGHTEN', raisedAt: new Date('2026-11-27T05:00:00Z'), deadline: null, payload: { level: 3890 } } as never;
    await h.svc.confirm(req({ alarm }));
    const content = h.sent()[1].messages[0].content;
    for (const s of ['decided BOOK', 'target 1 reached, momentum fading on 15m', 'TARGET_LOCK', 'crossed target 1', 'Plan: book half at 3950.', 'ltp 3952, pnl +3750', 'book at target 1 on expiry day']) expect(content).toContain(s);
    expect(h.state.memory).toHaveBeenCalledWith('owner', expect.any(Date));
  });

  it('a transport throw is ERROR with the message in the reason', async () => {
    const h = make(jest.fn(async () => { throw new Error('Vertex 503 overloaded'); }));
    const r = await h.svc.confirm(req());
    expect(r.decision).toBe('ERROR');
    expect(r.reason).toContain('Vertex 503 overloaded');
  });

  it('junk reply is ERROR; OVERRIDE_HOLD carries its brief note', async () => {
    expect((await make(jest.fn(async () => 'sure, go ahead')).svc.confirm(req())).decision).toBe('ERROR');
    const r = await make(jest.fn(async () => '{"decision":"OVERRIDE_HOLD","reason":"trend intact","briefNote":"trail under the 15m low"}')).svc.confirm(req());
    expect(r).toEqual(expect.objectContaining({ decision: 'OVERRIDE_HOLD', reason: 'trend intact', briefNote: 'trail under the 15m low' }));
  });

  it('agentDisagrees: the prompt says the agent disagreed with the supreme\'s own exit request and the answer is final', async () => {
    const h = make();
    await h.svc.confirm(req({ agentDecision: 'EXIT', agentDisagrees: true, agentReason: 'HOLD: 15m still above VWAP' }));
    const content = h.sent()[1].messages[0].content;
    expect(content).toMatch(/DISAGREED with your own request to EXIT/);
    expect(content).toMatch(/your answer is final/);
  });

  it('memory unavailable: still asks (memory null)', async () => {
    const h = make();
    h.state.memory.mockRejectedValueOnce(new Error('db'));
    expect((await h.svc.confirm(req())).decision).toBe('CONFIRM');
    expect(h.sent()[1].messages[0].content).toContain('"memory":null');
  });

  it('each call is audited as a desk_manager_decisions CONFIRM row, runId supreme-confirm', async () => {
    const h = make();
    await h.svc.confirm(req());
    await flush();
    const data = (h.prisma.deskManagerDecision.create.mock.calls[0] as unknown as [{ data: Record<string, any> }])[0].data;
    expect(data).toEqual(expect.objectContaining({ runId: SUPREME_CONFIRM_RUN_ID, action: 'CONFIRM', userId: 'owner', trackerId: 't1', status: 'DONE' }));
    expect(SUPREME_CONFIRM_RUN_ID).toBe('supreme-confirm');
    expect(data.result).toEqual(expect.objectContaining({ decision: 'CONFIRM', reason: 'target hit' }));
    expect(data.payload).toEqual(expect.objectContaining({ agentDecision: 'BOOK', agentDisagrees: false }));
    // An audit failure never changes the answer.
    const f = make();
    f.prisma.deskManagerDecision.create.mockRejectedValueOnce(new Error('db down'));
    expect((await f.svc.confirm(req())).decision).toBe('CONFIRM');
    await flush();
  });

  it('an authority DRILL confirm (alarm payload.drill) writes NO desk_manager_decisions row: never in memory / scorecard / grading', async () => {
    const h = make();
    const alarm = { id: 'a-d', rule: 'FLOOR', urgency: 'normal', reason: 'DRILL FLOOR', wouldHave: 'DRILL', raisedAt: new Date('2026-11-27T05:00:00Z'), deadline: null, payload: { drill: true } } as never;
    expect((await h.svc.confirm(req({ alarm }))).decision).toBe('CONFIRM');
    await flush();
    expect(h.prisma.deskManagerDecision.create).not.toHaveBeenCalled();
  });
});
