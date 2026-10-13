// apps/api/src/modules/sentinel-executor/domain/manual-exit.spec.ts
import { aiExitOrderTag, hasPriorAiExit, MANUAL_EXIT_TAG_PREFIX, AI_EXIT_TAG_PREFIX } from './exit-order';
import { evaluateGuards, type GuardInput } from './guards';
import { parseAutoExitConfig } from './auto-exit.config';
import { isManualVerdictId, manualVerdictId, MANUAL_VERDICT_PREFIX, MANUAL_REASON_PREFIX } from './manual-exit';

const NOW = new Date('2026-10-12T10:00:00Z');

describe('manual exit ids and tags', () => {
  it('a manual verdict id is man_<trackerId>_<seq>, recognisable, never a real cuid', () => {
    expect(MANUAL_VERDICT_PREFIX).toBe('man_');
    expect(MANUAL_REASON_PREFIX).toBe('MANUAL:');
    expect(manualVerdictId('cmtracker00000000000000001', 3)).toBe('man_cmtracker00000000000000001_3');
    expect(isManualVerdictId('man_cmtracker00000000000000001_3')).toBe(true);
    expect(isManualVerdictId('cm9verdict000000000000001')).toBe(false);
  });

  it('the MANUAL ordertag starts "am", is ≤ 20 alphanumerics and differs per attempt', () => {
    expect(MANUAL_EXIT_TAG_PREFIX).toBe('am');
    const a = aiExitOrderTag(manualVerdictId('cmtracker00000000000000001', 1), 'M', 'MANUAL');
    const b = aiExitOrderTag(manualVerdictId('cmtracker00000000000000001', 2), 'M', 'MANUAL');
    expect(a.startsWith('amM')).toBe(true);
    expect(a).toMatch(/^[A-Za-z0-9]{1,20}$/);
    expect(a).not.toBe(b);
    expect(aiExitOrderTag('cm9verdict000000000000001', 'M').startsWith(AI_EXIT_TAG_PREFIX)).toBe(true);
    expect(aiExitOrderTag('cm9verdict000000000000001', 'L', 'AI').startsWith('axL')).toBe(true);
  });

  it('PRIOR_AI_EXIT_TODAY treats both ax and am tags as a prior exit', () => {
    const row = (ordertag: string, status = 'complete') => ({ ordertag, status, exchange: 'MCX', symboltoken: '445566' });
    expect(hasPriorAiExit([row('amMxyz')], 'MCX', '445566')).toBe(true);
    expect(hasPriorAiExit([row('axMxyz')], 'MCX', '445566')).toBe(true);
    expect(hasPriorAiExit([row('amMxyz', 'rejected')], 'MCX', '445566')).toBe(false);
    expect(hasPriorAiExit([row('ae123')], 'MCX', '445566')).toBe(false);
  });
});

describe('evaluateGuards — MANUAL trigger', () => {
  const input = (over: Partial<GuardInput> = {}): GuardInput => ({
    // Disabled, empty allow-list, cap 0: none of these apply to the owner's own order.
    config: parseAutoExitConfig({ AI_AUTO_EXIT_DAILY_CAP: '0' }),
    now: NOW,
    verdict: { userId: 'owner', createdAt: new Date(NOW.getTime() - 3_600_000) },
    tracker: { userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'MCX' },
    isOpen: () => true,
    countedToday: 99,
    inFlight: false,
    trigger: 'MANUAL',
    ...over,
  });

  it('skips DISABLED / NOT_ALLOWED_USER / STALE_VERDICT / DAILY_CAP', () => {
    expect(evaluateGuards(input())).toEqual({ ok: true });
  });

  it.each<[string, Partial<GuardInput>]>([
    ['TRACKER_MISSING', { tracker: null }],
    ['TRACKER_USER_MISMATCH', { tracker: { userId: 'other', status: 'OPEN', kind: 'POSITION', exchange: 'MCX' } }],
    ['TRACKER_CLOSED', { tracker: { userId: 'owner', status: 'CLOSED', kind: 'POSITION', exchange: 'MCX' } }],
    ['NOT_POSITION', { tracker: { userId: 'owner', status: 'OPEN', kind: 'HOLDING', exchange: 'NFO' } }],
    ['EXCHANGE_NOT_FNO', { tracker: { userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'NSE' } }],
    ['EXCHANGE_CLOSED', { isOpen: () => false }],
    ['EXIT_IN_FLIGHT', { inFlight: true }],
  ])('keeps %s', (reason, over) => {
    expect(evaluateGuards(input(over))).toEqual({ ok: false, reason });
  });

  it('the AI trigger (default) is unchanged: disabled config is still DISABLED', () => {
    expect(evaluateGuards(input({ trigger: undefined }))).toEqual({ ok: false, reason: 'DISABLED' });
  });
});
