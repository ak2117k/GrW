import type { AlarmRow, RaiseAlarm } from '../exit-authority.tokens';
import {
  DRILL_REASON_TAG,
  DRILL_RULES,
  drillAlarm,
  drillPath,
  drillSold,
  isDrillAlarm,
  isDrillReason,
  type DrillObservation,
} from '../domain/drill';
import { advisoryVerdict } from '../../trade-sentinel/services/judge-gate';
import { parseDrillArgs, runAuthorityDrill, type DrillDeps } from './authority-drill';

const T0 = new Date('2026-11-30T05:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const TRACKER = { id: 'trk1', userId: 'owner1', symbol: 'CRUDEOIL16DEC268350CE', status: 'OPEN' };

describe('drill domain', () => {
  it('drillAlarm: normal urgency, no deadline, payload.drill, never SUPREME_EXIT', () => {
    const a = drillAlarm({ userId: 'owner1', trackerId: 'trk1', symbol: TRACKER.symbol }, 'HARD_LOSS', T0);
    expect(a).toMatchObject({ rule: 'HARD_LOSS', urgency: 'normal', deadline: null, payload: { drill: true } });
    expect(isDrillAlarm(a)).toBe(true);
    expect(DRILL_RULES).not.toContain('SUPREME_EXIT');
    expect(() => drillAlarm({ userId: 'u', trackerId: 't', symbol: 's' }, 'SUPREME_EXIT', T0)).toThrow(/may not/);
  });
  it('isDrillAlarm only on payload.drill === true', () => {
    expect(isDrillAlarm({ payload: { drill: 'true' } })).toBe(false);
    expect(isDrillAlarm({ payload: undefined })).toBe(false);
    expect(isDrillAlarm(null)).toBe(false);
  });
  it('the reason tag is exactly what the sentinel writes for a drill look (judge-gate advisoryVerdict)', () => {
    const stored = advisoryVerdict('EXIT_NOW', 'the 15m broke', 'authority drill');
    expect(stored.verdict).not.toBe('EXIT_NOW');
    expect(stored.reason.startsWith(DRILL_REASON_TAG)).toBe(true);
    expect(isDrillReason(stored.reason)).toBe(true);
    expect(isDrillReason('[advisory: owner hold (AI_AUTO_EXIT_HOLD)] x')).toBe(false);
    expect(isDrillReason('the 15m broke')).toBe(false);
  });
  it('drillSold: a sale of the drill look (or any drill-tagged verdict) — SKIPPED DRILL is a pass', () => {
    const obs = (status: string): Pick<DrillObservation, 'verdicts' | 'executions'> => ({
      verdicts: [{ id: 'v1', verdict: 'EXIT_ADVISORY', createdAt: at(20_000), triggeredBy: ['alarm'], reason: `${DRILL_REASON_TAG} x` }],
      executions: [{ verdictId: 'v1', status, reason: null }],
    });
    for (const s of ['CLAIMED', 'PLACED', 'FILLED', 'DRY_RUN']) expect(drillSold(obs(s))).toBe(true);
    for (const s of ['SKIPPED', 'FAILED']) expect(drillSold(obs(s))).toBe(false);
    expect(drillSold({ verdicts: [], executions: [] })).toBe(false);
  });
});

function alarmRow(a: RaiseAlarm, over: Partial<AlarmRow> = {}): AlarmRow {
  return {
    ...a, id: 'al-d', status: 'OPEN', raisedAt: T0, lastRaisedAt: T0, answeredAt: null, answerVerdictId: null, answer: null,
    alertedAt: null, alertCount: 0, telegramMessageId: null, snoozedUntil: null, ...over,
  } as AlarmRow;
}

function deps(over: Partial<DrillDeps> = {}, script: Array<Partial<AlarmRow>> = []) {
  let clock = T0.getTime();
  let raised: RaiseAlarm | null = null;
  let poll = 0;
  const lines: string[] = [];
  const verdicts: DrillObservation['verdicts'] = [];
  const executions: DrillObservation['executions'] = [];
  const d: DrillDeps & { raise: jest.Mock } = {
    env: { TRADE_AGENT_AUTHORITY: 'live', AI_AUTO_EXIT_HOLD: 'MAZDOCK29DEC261760PE' },
    tracker: jest.fn(async (id: string) => (id === TRACKER.id ? { ...TRACKER } : null)),
    raise: jest.fn(async (a: RaiseAlarm) => {
      raised = a;
      return alarmRow(a);
    }),
    alarm: jest.fn(async () => (raised ? alarmRow(raised, script[Math.min(poll++, script.length - 1)] ?? {}) : null)),
    verdictsSince: jest.fn(async () => verdicts),
    executions: jest.fn(async () => executions),
    now: () => new Date(clock),
    sleep: jest.fn(async (ms: number) => {
      clock += ms;
    }),
    print: (l: string) => lines.push(l),
    ...over,
  } as DrillDeps & { raise: jest.Mock };
  return { d, lines, verdicts, executions };
}

describe('runAuthorityDrill', () => {
  it('refuses without TRADE_AGENT_AUTHORITY=live, a paper / unknown / closed / held tracker — and raises nothing', async () => {
    const cases: Array<[Partial<DrillDeps>, string]> = [
      [{ env: { TRADE_AGENT_AUTHORITY: 'off' } }, 'trk1'],
      [{}, 'paper:p1'],
      [{}, 'nope'],
      [{ tracker: async () => ({ ...TRACKER, status: 'CLOSED' }) }, 'trk1'],
      [{ tracker: async () => ({ ...TRACKER, symbol: 'MAZDOCK29DEC261760PE' }) }, 'trk1'],
    ];
    for (const [over, trackerId] of cases) {
      const { d, lines } = deps(over);
      expect(await runAuthorityDrill(d, { trackerId, rule: 'FLOOR' })).toBe(2);
      expect(d.raise).not.toHaveBeenCalled();
      expect(lines[0]).toMatch(/^REFUSED/);
    }
  });

  it('a raise refused by the store (a real alarm is live) is reported, exit 2', async () => {
    const { d, lines } = deps({ raise: jest.fn(async () => null) });
    expect(await runAuthorityDrill(d, { trackerId: 'trk1', rule: 'FLOOR' })).toBe(2);
    expect(lines.join('\n')).toMatch(/NOT RAISED/);
  });

  it('raises a drill alarm and prints the path alarm → look → verdict → execution → answer → confirm → closed; exit 0', async () => {
    const { d, lines, verdicts, executions } = deps({}, [
      {},
      { status: 'ANSWERED', answeredAt: at(25_000), answer: 'EXIT_ADVISORY', answerVerdictId: 'v1' },
      { status: 'CLOSED', answeredAt: at(25_000), answer: 'EXIT_ADVISORY', answerVerdictId: 'v1', payload: { drill: true, drillConfirm: 'CONFIRM: agreed' } },
    ]);
    verdicts.push({ id: 'v1', verdict: 'EXIT_ADVISORY', createdAt: at(20_000), triggeredBy: ['alarm'], reason: `${DRILL_REASON_TAG} the 15m broke` });
    executions.push({ verdictId: 'v1', status: 'SKIPPED', reason: 'DRILL' });
    expect(await runAuthorityDrill(d, { trackerId: 'trk1', rule: 'FLOOR', pollMs: 5_000 })).toBe(0);
    const raised = d.raise.mock.calls[0][0] as RaiseAlarm;
    expect(raised).toMatchObject({ trackerId: 'trk1', rule: 'FLOOR', urgency: 'normal', payload: { drill: true } });
    const out = lines.join('\n');
    for (const step of ['alarm', 'look', 'verdict', 'execution', 'answer', 'confirm', 'closed']) expect(out).toMatch(new RegExp(`\\b${step}\\b`));
    expect(out).toMatch(/PASS: path complete/);
    expect(out).toMatch(/Nothing was sold/);
  });

  it('SAFETY FAILURE (exit 1) the moment the drill look shows a sale', async () => {
    const { d, lines, verdicts, executions } = deps();
    verdicts.push({ id: 'v1', verdict: 'EXIT_NOW', createdAt: at(20_000), triggeredBy: ['alarm'], reason: 'x' });
    executions.push({ verdictId: 'v1', status: 'FILLED', reason: null });
    expect(await runAuthorityDrill(d, { trackerId: 'trk1', rule: 'FLOOR' })).toBe(1);
    expect(lines.join('\n')).toMatch(/SAFETY FAILURE/);
  });

  it('a BACKSTOPPED drill alarm is a SAFETY FAILURE', async () => {
    const { d } = deps({}, [{ status: 'BACKSTOPPED' }]);
    expect(await runAuthorityDrill(d, { trackerId: 'trk1', rule: 'HARD_LOSS' })).toBe(1);
  });

  it('no look within the wait: exit 3 (timed out), nothing sold', async () => {
    const { d, lines } = deps();
    expect(await runAuthorityDrill(d, { trackerId: 'trk1', rule: 'FLOOR', waitMs: 30_000, pollMs: 10_000 })).toBe(3);
    expect(lines.join('\n')).toMatch(/TIMED OUT/);
  });
});

describe('parseDrillArgs', () => {
  it('reads --tracker, --rule (default FLOOR), --wait-sec; refuses SUPREME_EXIT and a missing tracker', () => {
    expect(parseDrillArgs(['--tracker', 'trk1'])).toEqual({ trackerId: 'trk1', rule: 'FLOOR' });
    expect(parseDrillArgs(['--tracker', 'trk1', '--rule', 'hard_loss', '--wait-sec', '120'])).toEqual({ trackerId: 'trk1', rule: 'HARD_LOSS', waitMs: 120_000 });
    expect(parseDrillArgs(['--tracker', 'trk1', '--rule', 'SUPREME_EXIT'])).toHaveProperty('error');
    expect(parseDrillArgs([])).toHaveProperty('error');
    expect(parseDrillArgs(['--tracker', '--rule'])).toHaveProperty('error');
  });
});
