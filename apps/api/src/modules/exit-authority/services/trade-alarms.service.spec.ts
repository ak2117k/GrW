import { Logger } from '@nestjs/common';
import type { AlarmRow, AuthorityStatePort, RaiseAlarm, TrackerWakePort } from '../exit-authority.tokens';
import type { TradeAlarmPatch, TradeAlarmRepository } from '../repositories/trade-alarm.repository';
import { REALARM_EVERY_MS } from '../domain/timings';
import { TradeAlarmsService } from './trade-alarms.service';

/** In-memory stand-in for TradeAlarmRepository (only the methods the service uses). */
class FakeRepo {
  rows: AlarmRow[] = [];
  private seq = 0;
  creates = 0;
  async create(input: Omit<AlarmRow, 'id'>): Promise<AlarmRow> {
    this.creates++;
    const row: AlarmRow = { ...input, id: `a${++this.seq}` };
    this.rows.push(row);
    return { ...row };
  }
  async findLatestLive(trackerId: string, rule: string): Promise<AlarmRow | null> {
    const live = this.rows
      .filter((r) => r.trackerId === trackerId && r.rule === rule && ['OPEN', 'SNOOZED', 'ANSWERED'].includes(r.status))
      .sort((a, b) => b.lastRaisedAt.getTime() - a.lastRaisedAt.getTime());
    return live[0] ? { ...live[0] } : null;
  }
  async findOpen(trackerId: string): Promise<AlarmRow[]> {
    return this.rows.filter((r) => r.trackerId === trackerId && ['OPEN', 'SNOOZED'].includes(r.status));
  }
  async findOpenForTrackers(ids: string[]): Promise<AlarmRow[]> {
    return this.rows.filter((r) => ids.includes(r.trackerId) && ['OPEN', 'SNOOZED'].includes(r.status));
  }
  async update(id: string, patch: TradeAlarmPatch): Promise<AlarmRow> {
    const r = this.rows.find((x) => x.id === id);
    if (!r) throw new Error(`no alarm ${id}`);
    Object.assign(r, patch);
    return { ...r };
  }
  async answerIfOpen(id: string, patch: { answeredAt: Date; answerVerdictId: string; answer: string }): Promise<boolean> {
    const r = this.rows.find((x) => x.id === id && ['OPEN', 'SNOOZED'].includes(x.status));
    if (!r) return false;
    Object.assign(r, { status: 'ANSWERED', ...patch });
    return true;
  }
}

const T0 = new Date('2026-11-27T05:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

const floor = (over: Partial<RaiseAlarm> = {}): RaiseAlarm => ({
  userId: 'u1',
  trackerId: 'trk1',
  symbol: 'NIFTY25DEC26000CE',
  rule: 'FLOOR',
  urgency: 'normal',
  reason: 'green-to-red floor broken',
  wouldHave: 'EXIT_NOW FLOOR_HARD_EXIT GREEN_TO_RED',
  severityN: 0.4,
  payload: { netPnl: -350 },
  ...over,
});

function setup(opts: { live?: boolean; wake?: boolean; state?: boolean } = {}) {
  const repo = new FakeRepo();
  const wake: TrackerWakePort & { wakeTracker: jest.Mock } = { wakeTracker: jest.fn() };
  const state: AuthorityStatePort = { isLive: () => opts.live ?? true };
  const svc = new TradeAlarmsService(
    repo as unknown as TradeAlarmRepository,
    opts.wake === false ? undefined : wake,
    opts.state === false ? undefined : state,
  );
  return { repo, wake, svc };
}

describe('TradeAlarmsService', () => {
  it('raise creates an OPEN row and wakes the tracker once', async () => {
    const { repo, wake, svc } = setup();
    const row = await svc.raise(floor(), T0);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('OPEN');
    expect(row!.raisedAt).toEqual(T0);
    expect(row!.lastRaisedAt).toEqual(T0);
    expect(row!.alertCount).toBe(0);
    expect(repo.rows).toHaveLength(1);
    expect(wake.wakeTracker).toHaveBeenCalledTimes(1);
    expect(wake.wakeTracker).toHaveBeenCalledWith('u1', 'trk1', 'alarm FLOOR');
  });

  it('dedupes a second raise for the same (tracker, rule) within 30 s that is not worse', async () => {
    const { repo, wake, svc } = setup();
    await svc.raise(floor(), T0);
    const again = await svc.raise(floor({ severityN: 1.0 }), at(30_000));
    expect(again).toBeNull();
    expect(repo.creates).toBe(1);
    expect(repo.rows[0].lastRaisedAt).toEqual(T0);
    expect(wake.wakeTracker).toHaveBeenCalledTimes(1);
  });

  it('two raises started together for the same tracker+rule → one create, one wake, the other null', async () => {
    const { repo, wake, svc } = setup();
    const [r1, r2] = await Promise.all([svc.raise(floor(), T0), svc.raise(floor(), T0)]);
    expect(repo.creates).toBe(1);
    expect(repo.rows).toHaveLength(1);
    expect(wake.wakeTracker).toHaveBeenCalledTimes(1);
    expect([r1, r2].filter((r) => r === null)).toHaveLength(1);
  });

  it('a failed raise does not block the next raise for the same key', async () => {
    const { repo, svc } = setup();
    const create = jest.spyOn(repo, 'create').mockRejectedValueOnce(new Error('db down'));
    await expect(svc.raise(floor(), T0)).rejects.toThrow('db down');
    expect(await svc.raise(floor(), at(1_000))).not.toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('a P2002 (another process holds the live alarm) on create returns null without a wake', async () => {
    const { repo, wake, svc } = setup();
    jest.spyOn(repo, 'create').mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    expect(await svc.raise(floor(), T0)).toBeNull();
    expect(wake.wakeTracker).not.toHaveBeenCalled();
  });

  it('a different rule on the same tracker is its own alarm', async () => {
    const { repo, svc } = setup();
    await svc.raise(floor(), T0);
    const hl = await svc.raise(floor({ rule: 'HARD_LOSS', urgency: 'urgent' }), at(1_000));
    expect(hl).not.toBeNull();
    expect(repo.rows).toHaveLength(2);
  });

  it('a worse raise updates lastRaisedAt and severityN on the open row and wakes again', async () => {
    const { repo, wake, svc } = setup();
    await svc.raise(floor(), T0);
    const worse = await svc.raise(floor({ severityN: 1.6, reason: 'deeper', payload: { netPnl: -900 } }), at(30_000));
    expect(worse).not.toBeNull();
    expect(repo.creates).toBe(1);
    expect(worse!.id).toBe(repo.rows[0].id);
    expect(worse!.lastRaisedAt).toEqual(at(30_000));
    expect(worse!.raisedAt).toEqual(T0);
    expect(worse!.severityN).toBe(1.6);
    expect(worse!.reason).toBe('deeper');
    expect(worse!.payload).toEqual({ netPnl: -900 });
    expect(wake.wakeTracker).toHaveBeenCalledTimes(2);
  });

  it('dedupes against a recently ANSWERED alarm (held) and opens a fresh one after REALARM_EVERY_MS', async () => {
    const { repo, wake, svc } = setup();
    const first = await svc.raise(floor(), T0);
    await svc.answer(first!.id, 'v1', 'HOLD', at(20_000));
    expect(await svc.raise(floor(), at(60_000))).toBeNull();
    // The interval runs from the agent's answer (20 s), not from the raise: nothing yet at REALARM_EVERY_MS.
    expect(await svc.raise(floor(), at(REALARM_EVERY_MS))).toBeNull();
    const fresh = await svc.raise(floor(), at(20_000 + REALARM_EVERY_MS));
    expect(fresh).not.toBeNull();
    expect(fresh!.id).not.toBe(first!.id);
    expect(fresh!.status).toBe('OPEN');
    expect(repo.rows[0].status).toBe('ANSWERED');
    expect(wake.wakeTracker).toHaveBeenCalledTimes(2);
  });

  it('raise for a paper tracker returns null and writes nothing', async () => {
    const { repo, wake, svc } = setup();
    expect(await svc.raise(floor({ trackerId: 'paper:trade1' }), T0)).toBeNull();
    expect(repo.rows).toHaveLength(0);
    expect(wake.wakeTracker).not.toHaveBeenCalled();
  });

  it('off: raise returns null and writes nothing when the authority is not live', async () => {
    const { repo, wake, svc } = setup({ live: false });
    expect(await svc.raise(floor(), T0)).toBeNull();
    expect(repo.rows).toHaveLength(0);
    expect(wake.wakeTracker).not.toHaveBeenCalled();
  });

  it('off: with no AUTHORITY_STATE bound, raise is inert', async () => {
    const { repo, svc } = setup({ state: false });
    expect(await svc.raise(floor(), T0)).toBeNull();
    expect(repo.rows).toHaveLength(0);
  });

  it('with no TRACKER_WAKE bound, raise still persists and logs one WARN', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { repo, svc } = setup({ wake: false });
      await svc.raise(floor(), T0);
      await svc.raise(floor({ rule: 'LADDER' }), at(1_000));
      expect(repo.rows).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a wake that throws does not lose the alarm', async () => {
    const { repo, wake, svc } = setup();
    wake.wakeTracker.mockImplementation(() => {
      throw new Error('boom');
    });
    const row = await svc.raise(floor(), T0);
    expect(row).not.toBeNull();
    expect(repo.rows).toHaveLength(1);
  });

  it('truncates the reason to 500 chars', async () => {
    const { svc } = setup();
    const row = await svc.raise(floor({ reason: 'x'.repeat(800) }), T0);
    expect(row!.reason).toHaveLength(500);
  });

  it('answer sets ANSWERED, answeredAt and answerVerdictId', async () => {
    const { repo, svc } = setup();
    const row = await svc.raise(floor(), T0);
    await svc.answer(row!.id, 'verdict-9', 'HOLD: VWAP holds', at(15_000));
    expect(repo.rows[0]).toMatchObject({
      status: 'ANSWERED',
      answeredAt: at(15_000),
      answerVerdictId: 'verdict-9',
      answer: 'HOLD: VWAP holds',
    });
  });

  it.each(['BACKSTOPPED', 'CLOSED'] as const)('a late answer never resurrects a %s alarm', async (status) => {
    const { repo, svc } = setup();
    const row = await svc.raise(floor(), T0);
    repo.rows[0].status = status;
    await svc.answer(row!.id, 'verdict-9', 'HOLD', at(30_000));
    expect(repo.rows[0]).toMatchObject({ status, answeredAt: null, answerVerdictId: null, answer: null });
  });

  it('a second answer does not overwrite the first', async () => {
    const { repo, svc } = setup();
    const row = await svc.raise(floor(), T0);
    await svc.answer(row!.id, 'v1', 'EXIT_NOW (supreme asked)', at(10_000));
    await svc.answer(row!.id, 'v2', 'HOLD', at(20_000));
    expect(repo.rows[0]).toMatchObject({ answerVerdictId: 'v1', answer: 'EXIT_NOW (supreme asked)', answeredAt: at(10_000) });
  });

  describe('a deadline is never lost (CARRY)', () => {
    const deadline = at(30 * 60_000);
    const carryDeadline = floor({ rule: 'CARRY', urgency: 'deadline', deadline, severityN: null, reason: 'EXPIRY_DAY' });
    const routerCarry = floor({ rule: 'CARRY', urgency: 'urgent', severityN: null, reason: 'judge EXIT: premium decaying' });

    it("a refresh without a deadline (the router's urgent CARRY) keeps the open alarm's deadline and deadline urgency", async () => {
      const { repo, svc } = setup();
      await svc.raise(carryDeadline, T0);
      const r = await svc.raise(routerCarry, at(REALARM_EVERY_MS));
      expect(r).not.toBeNull();
      expect(repo.rows).toHaveLength(1);
      expect(repo.rows[0]).toMatchObject({ deadline, urgency: 'deadline', reason: 'judge EXIT: premium decaying' });
    });

    it('a fresh alarm after an answered deadline alarm inherits its deadline', async () => {
      const { svc } = setup();
      const first = await svc.raise(carryDeadline, T0);
      await svc.answer(first!.id, 'v1', 'HOLD', at(10_000));
      const fresh = await svc.raise(routerCarry, at(10_000 + REALARM_EVERY_MS));
      expect(fresh).toMatchObject({ deadline, urgency: 'deadline' });
    });

    it('a raise that carries its own deadline still sets it', async () => {
      const { repo, svc } = setup();
      await svc.raise(carryDeadline, T0);
      const later = at(40 * 60_000);
      await svc.raise({ ...carryDeadline, deadline: later }, at(REALARM_EVERY_MS));
      expect(repo.rows[0].deadline).toEqual(later);
    });
  });

  it('openFor / openForTrackers return OPEN and SNOOZED rows only', async () => {
    const { repo, svc } = setup();
    const a = await svc.raise(floor(), T0);
    await svc.raise(floor({ trackerId: 'trk2' }), T0);
    await svc.raise(floor({ trackerId: 'trk3' }), T0);
    await svc.answer(a!.id, 'v1', 'HOLD', at(1));
    repo.rows[2].status = 'SNOOZED';
    expect(await svc.openFor('trk1')).toHaveLength(0);
    expect((await svc.openForTrackers(['trk1', 'trk2', 'trk3'])).map((r) => r.trackerId).sort()).toEqual(['trk2', 'trk3']);
    expect(await svc.openForTrackers([])).toEqual([]);
  });
});

/** AUTHORITY DRILL (supreme fixes W5): a drill never touches a real alarm, and a real raise never waits on a drill. */
describe('TradeAlarmsService — authority drill', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());
  const drill = (over: Partial<RaiseAlarm> = {}) => floor({ payload: { drill: true }, reason: 'DRILL FLOOR', severityN: null, ...over });

  it('a drill with nothing live is created (payload.drill kept) and wakes the agent', async () => {
    const { repo, wake, svc } = setup();
    const row = await svc.raise(drill(), T0);
    expect(row).toMatchObject({ status: 'OPEN', payload: { drill: true } });
    expect(repo.creates).toBe(1);
    expect(wake.wakeTracker).toHaveBeenCalledTimes(1);
  });

  it('a drill when a REAL alarm of that rule is live: refused (null) — the real alarm is never refreshed or flagged drill', async () => {
    for (const status of ['OPEN', 'SNOOZED', 'ANSWERED'] as const) {
      const { repo, wake, svc } = setup();
      const real = await svc.raise(floor(), T0);
      repo.rows[0].status = status;
      wake.wakeTracker.mockClear();
      expect(await svc.raise(drill(), at(REALARM_EVERY_MS + 1))).toBeNull();
      expect(repo.rows).toHaveLength(1);
      expect(repo.rows[0]).toMatchObject({ id: real!.id, payload: { netPnl: -350 }, reason: 'green-to-red floor broken' });
      expect(wake.wakeTracker).not.toHaveBeenCalled();
    }
  });

  it('a REAL raise while a drill alarm of that rule is live (even inside the re-raise window): the drill is CLOSED and a fresh real alarm created', async () => {
    const { repo, wake, svc } = setup();
    const d = await svc.raise(drill(), T0);
    wake.wakeTracker.mockClear();
    const real = await svc.raise(floor(), at(1_000));
    expect(real).not.toBeNull();
    expect(real!.id).not.toBe(d!.id);
    expect(real!.payload).toEqual({ netPnl: -350 });
    expect(repo.rows.find((r) => r.id === d!.id)!.status).toBe('CLOSED');
    expect(wake.wakeTracker).toHaveBeenCalledTimes(1);
  });

  it('a second drill while the first is live is deduped like any raise', async () => {
    const { repo, svc } = setup();
    await svc.raise(drill(), T0);
    expect(await svc.raise(drill(), at(1_000))).toBeNull();
    expect(repo.rows).toHaveLength(1);
  });
});
