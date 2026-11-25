import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../../../common/decorators';
import { parseAiSetupsConfig } from '../ai-setups.config';
import type { SessionSetupRow } from '../repositories/ai-setups.repository';
import { AiSetupsController, toSetupCard } from './ai-setups.controller';

const NOW = new Date('2026-11-25T05:00:00Z'); // 10:30 IST
const OWNER = { userId: 'owner-1', role: 'ADMIN', email: 'o@x' };
const CLAIM = { text: 'DABUR breaking out above 520', subject: 'DABUR', bias: 'BULL', horizon: 'INTRADAY', verdict: 'CONFIRMED', evidence: [], claimType: 'BREAKOUT' };
const PLAN = {
  instrument: { kind: 'OPT', symbol: 'DABUR', strike: 520, optionType: 'CE', expiry: '2026-11-27' },
  side: 'BUY',
  entry: { type: 'LIMIT_PULLBACK', low: 518, high: 520, trigger: null, level: 520 },
  sl: 514,
  targets: [528, 534],
  validUntil: '14:30',
  confidence: 64,
  evidence: [{ fact: 'day high', value: '521.4', source: 'quote' }],
};

const row = (id: string, createdAt: string, o: Partial<SessionSetupRow> = {}): SessionSetupRow => ({
  id,
  readingId: `msg-${id}`,
  underlying: 'DABUR',
  channelId: 'ch1',
  channelTitle: 'Stock Gainers',
  decision: 'SETUP',
  status: 'PENDING',
  reason: 'pullback into the breakout level, R:R 1.6',
  setup: PLAN,
  checks: { stage: 'checks', result: { ok: true }, claim: CLAIM, aiReason: 'x' },
  validUntil: new Date('2026-11-25T09:00:00Z'),
  entryAt: null,
  exitAt: null,
  exitReason: null,
  pnl: null,
  grade: null,
  createdAt: new Date(createdAt),
  ...o,
});

function make(o: { ownerUserId?: string | null; mode?: string; rows?: SessionSetupRow[] } = {}) {
  const repo = {
    setupsForSession: jest.fn(async () => o.rows ?? [row('s2', '2026-11-25T04:40:00Z'), row('s1', '2026-11-25T04:10:00Z')]),
  };
  const ctrl = new AiSetupsController(
    repo,
    parseAiSetupsConfig({ AI_SETUPS: o.mode ?? 'paper' }),
    { ownerUserId: o.ownerUserId === undefined ? 'owner-1' : o.ownerUserId },
    () => NOW,
  );
  return { ctrl, repo };
}

describe('AiSetupsController', () => {
  it("returns the day's setups newest first with the mode", async () => {
    const m = make();
    const out = await m.ctrl.list(OWNER, '2026-11-25');
    expect(m.repo.setupsForSession).toHaveBeenCalledWith('2026-11-25');
    expect(out.date).toBe('2026-11-25');
    expect(out.mode).toBe('paper');
    expect(out.setups.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(out.setups[0]).toMatchObject({
      readingId: 'msg-s2',
      channelTitle: 'Stock Gainers',
      decision: 'SETUP',
      status: 'PENDING',
      claim: { text: 'DABUR breaking out above 520', bias: 'BULL', verdict: 'CONFIRMED' },
      failedCheck: null,
      setup: { sl: 514, targets: [528, 534], validUntil: '14:30', confidence: 64 },
    });
    // the packet the AI saw is never sent to the page
    expect(JSON.stringify(out)).not.toContain('packet');
  });

  it('a newer row listed later by the store is still returned first', async () => {
    const m = make({ rows: [row('old', '2026-11-25T04:00:00Z'), row('new', '2026-11-25T04:50:00Z')] });
    const out = await m.ctrl.list(OWNER, '2026-11-25');
    expect(out.setups.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it("defaults to today's IST session and rejects a malformed date", async () => {
    const m = make();
    await m.ctrl.list(OWNER, undefined);
    expect(m.repo.setupsForSession).toHaveBeenCalledWith('2026-11-25');
    // 00:30 IST on the 26th is the next session
    const late = new AiSetupsController(m.repo, parseAiSetupsConfig({ AI_SETUPS: 'paper' }), { ownerUserId: null }, () => new Date('2026-11-25T19:00:00Z'));
    await late.list(OWNER, '');
    expect(m.repo.setupsForSession).toHaveBeenLastCalledWith('2026-11-26');
    await expect(m.ctrl.list(OWNER, '25-11-2026')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('owner only: admin role metadata, and another admin or a non-admin is refused', async () => {
    const reflector = new Reflector();
    expect(reflector.getAllAndOverride(ROLES_KEY, [AiSetupsController.prototype.list, AiSetupsController])).toEqual(['ADMIN']);
    expect(reflector.getAllAndOverride(IS_PUBLIC_KEY, [AiSetupsController.prototype.list, AiSetupsController])).toBeUndefined();
    const m = make();
    await expect(m.ctrl.list({ ...OWNER, userId: 'someone' }, '2026-11-25')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.ctrl.list({ ...OWNER, role: 'USER' }, '2026-11-25')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.ctrl.list(undefined, '2026-11-25')).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.repo.setupsForSession).not.toHaveBeenCalled();
  });

  it('says off when AI_SETUPS is off (the page hides the cards)', async () => {
    const out = await make({ mode: 'off' }).ctrl.list(OWNER, '2026-11-25');
    expect(out.mode).toBe('off');
  });
});

describe('toSetupCard', () => {
  it('a code-check veto: the failed check and its detail', () => {
    const c = toSetupCard(
      row('v', '2026-11-25T04:00:00Z', {
        status: 'NO_TRADE',
        reason: 'code check rr_below_min: reward:risk 0.9 < 1.2',
        checks: { stage: 'checks', result: { ok: false, failed: 'rr_below_min', detail: 'reward:risk 0.9 < 1.2' }, claim: CLAIM },
      }),
    );
    expect(c.failedCheck).toEqual({ name: 'rr_below_min', detail: 'reward:risk 0.9 < 1.2' });
    expect(c.setup).toMatchObject({ sl: 514 });
  });

  it('an AI NO_TRADE has no setup; a SKIPPED row keeps its claim; junk json is null', () => {
    const nt = toSetupCard(row('n', '2026-11-25T04:00:00Z', { decision: 'NO_TRADE', status: 'NO_TRADE', setup: null, reason: 'already ran 2 ATR', checks: { stage: 'ai', result: { ok: true }, claim: CLAIM } }));
    expect(nt).toMatchObject({ setup: null, failedCheck: null, reason: 'already ran 2 ATR' });
    const sk = toSetupCard(row('k', '2026-11-25T04:00:00Z', { decision: 'SKIPPED', status: 'SKIPPED', setup: null, checks: { stage: 'guard', claim: CLAIM } }));
    expect(sk.claim?.text).toBe('DABUR breaking out above 520');
    const junk = toSetupCard(row('j', '2026-11-25T04:00:00Z', { setup: 'nope', checks: 7, grade: [] }));
    expect(junk).toMatchObject({ setup: null, claim: null, failedCheck: null, grade: null });
  });

  it('passes the grade and the paper result through', () => {
    const grade = { status: 'GRADED', kind: 'SETUP', actual: { filled: true, net: -420, pnlGross: -360, fees: 60 }, plan: { status: 'GRADED', rupees: -300, outcome: 'SL' } };
    const c = toSetupCard(row('g', '2026-11-25T04:00:00Z', { status: 'EXITED', pnl: -360, exitReason: 'AI_SETUP_SL', grade }));
    expect(c).toMatchObject({ status: 'EXITED', pnl: -360, exitReason: 'AI_SETUP_SL', grade });
  });
});
