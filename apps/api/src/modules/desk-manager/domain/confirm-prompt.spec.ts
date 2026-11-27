import type { AlarmRow, ConfirmRequest } from '../../exit-authority/exit-authority.tokens';
import { parseDeskManagerConfig } from '../desk-manager.config';
import { confirmSystemPrompt, confirmUserMessage, parseConfirmReply } from './confirm-prompt';

const alarm = {
  id: 'a1', userId: 'owner', trackerId: 't1', symbol: 'BSE30DEC253900CE', rule: 'HARD_LOSS', urgency: 'urgent', reason: 'net -2100 past the 2000 limit',
  wouldHave: 'EXIT_NOW HARD_LOSS', status: 'OPEN', raisedAt: new Date('2026-11-27T05:00:00Z'), lastRaisedAt: new Date('2026-11-27T05:00:00Z'),
  answeredAt: null, answerVerdictId: null, answer: null, alertedAt: null, alertCount: 0, telegramMessageId: null, snoozedUntil: null, payload: { netPnl: -2100 },
} as AlarmRow;

const req = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  userId: 'owner', trackerId: 't1', symbol: 'BSE30DEC253900CE', agentDecision: 'EXIT', agentReason: '15m close below 3863',
  alarm, brief: 'Plan: hold for 3950 above 3863.', packetSummary: 'ltp 3858, pnl -2100', ...over,
});

describe('parseConfirmReply', () => {
  it('CONFIRM', () => {
    expect(parseConfirmReply('{"decision":"CONFIRM","reason":"stop broken on the 15m close"}')).toEqual({ decision: 'CONFIRM', reason: 'stop broken on the 15m close', briefNote: null });
  });

  it('OVERRIDE_HOLD with the brief note', () => {
    expect(parseConfirmReply('{"decision":"OVERRIDE_HOLD","reason":"1m wick inside the 15m range","briefNote":"exit only on a 15m close below 3850"}')).toEqual({
      decision: 'OVERRIDE_HOLD',
      reason: '1m wick inside the 15m range',
      briefNote: 'exit only on a 15m close below 3850',
    });
  });

  it('prose- or fence-wrapped JSON is parsed (first { … last })', () => {
    expect(parseConfirmReply('Here is my answer:\n{"decision":"CONFIRM","reason":"r"}\nThanks.').decision).toBe('CONFIRM');
    expect(parseConfirmReply('```json\n{"decision":"OVERRIDE_HOLD","reason":"r"}\n```').decision).toBe('OVERRIDE_HOLD');
  });

  it('an unknown decision or junk is ERROR', () => {
    expect(parseConfirmReply('{"decision":"MAYBE","reason":"r"}').decision).toBe('ERROR');
    expect(parseConfirmReply('{"reason":"r"}').decision).toBe('ERROR');
    expect(parseConfirmReply('no idea').decision).toBe('ERROR');
    expect(parseConfirmReply('').decision).toBe('ERROR');
    expect(parseConfirmReply('[1,2]').decision).toBe('ERROR');
    expect(parseConfirmReply(undefined).decision).toBe('ERROR');
  });
});

describe('confirm prompt', () => {
  it('the system prompt names the two answers, the reply shape, the ceilings and the 15m rule', () => {
    const p = confirmSystemPrompt(parseDeskManagerConfig({ HARD_LOSS_CEILING_BY_CLASS: 'INDEX_OPT:4500' }));
    expect(p).toContain('CONFIRM');
    expect(p).toContain('OVERRIDE_HOLD');
    expect(p).toContain('"briefNote"');
    expect(p).toContain('INDEX_OPT ₹4500');
    expect(p).toMatch(/15 minutes is the smallest unit/);
  });

  it('the user message carries the agent call, reason, alarm, brief, packet summary and memory', () => {
    const m = confirmUserMessage(req(), { today: [{ at: 'x', action: 'OPEN', underlying: 'BSE', status: 'DONE', result: null }], scorecard: null, lessons: ['L1'] });
    for (const s of ['15m close below 3863', 'HARD_LOSS', 'net -2100 past the 2000 limit', 'Plan: hold for 3950 above 3863.', 'ltp 3858, pnl -2100', '"lessons":["L1"]', 'decided EXIT']) expect(m).toContain(s);
    expect(m).not.toMatch(/DISAGREED/);
  });

  it('agentDisagrees: the agent disagreed with the supreme\'s own exit request and the answer is final', () => {
    const m = confirmUserMessage(req({ agentDisagrees: true, agentReason: 'still above VWAP' }), null);
    expect(m).toMatch(/DISAGREED with your own request to EXIT/);
    expect(m).toMatch(/your answer is final/);
  });
});
