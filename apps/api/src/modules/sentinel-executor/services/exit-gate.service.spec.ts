import { parseExitDisciplineConfig } from '../../exit-discipline/config';
import { ExitGateService } from './exit-gate.service';

const V = { id: 'cur', userId: 'owner', trackerId: 't1', symbol: 'CRUDEOIL17NOV269000CE', reason: 'r', createdAt: new Date('2026-10-14T11:01:00Z') };
const NOW = new Date('2026-10-14T11:01:20Z');
const PACKET = {
  position: { symbol: 'CRUDEOIL17NOV269000CE', side: 'LONG', qty: 100, entryPrice: 521.9, ltp: 527.6, expiry: '2026-11-17',
    underlyingLtp: { available: true, value: 9003 } },
  money: { charges: 61, netPnl: 509, greenFloorPrice: 530.5, greenFloorArmed: true, floorBasis: 'noise' },
  thesis: { available: true, value: { invalidation: 8932 } },
  structure: { levelBook: { available: true, value: { vwap: 9000, atr14: 13.5 } } },
  flow: { noiseUnit: { available: true, value: { contract: { n: 4.5, method: 'atr14-1m', bars: 14, at: 'x' }, underlying: null } } },
  session: { nowUtc: '2026-10-14T11:00:30Z' },
};
function make(o: { packet?: unknown; history?: unknown[]; slow?: boolean; throws?: boolean; env?: Record<string, string> } = {}) {
  const repo = {
    verdictPacket: jest.fn(async () => {
      if (o.throws) throw new Error('db down');
      if (o.slow) await new Promise((r) => setTimeout(r, 5_000));
      return o.packet === undefined ? PACKET : o.packet;
    }),
    recentVerdicts: jest.fn(async () => o.history ?? [
      { id: 'h', verdict: 'HOLD', createdAt: new Date('2026-10-14T10:50:00Z'), underlying: 8998, support: 8946, resistance: 9020 },
    ]),
    maxRiskPerTrade: jest.fn(async () => 2000),
    dailyLossLatched: jest.fn(async () => false),
  };
  const clock = { minutesToClose: jest.fn(() => 418) };
  const svc = new ExitGateService(repo as never, clock as never, parseExitDisciplineConfig(o.env ?? {}));
  return { svc, repo, clock };
}

describe('ExitGateService', () => {
  afterEach(() => jest.useRealTimers());

  it('evidence-like verdict ⇒ GATED_THESIS_INTACT with facts from packet + live ltp/product', async () => {
    const { svc, repo } = make();
    const ctx = await svc.load(V as never, NOW);
    const r = svc.decide(ctx, { ltpNow: 527.1, productType: 'CARRYFORWARD', exchange: 'MCX', now: NOW });
    expect(r).toMatchObject({ outcome: 'GATED_THESIS_INTACT', facts: { ltpNow: 527.1, productType: 'CARRYFORWARD', minutesToClose: 418, nContract: 4.5 } });
    expect(repo.recentVerdicts).toHaveBeenCalledWith('t1', 'cur', V.createdAt, new Date(V.createdAt.getTime() - 60 * 60_000));
  });

  it('missing verdict row ⇒ BYPASS FACTS_UNREADABLE (fail-open), never throws', async () => {
    const { svc } = make({ packet: null });
    const r = svc.decide(await svc.load(V as never, NOW), { ltpNow: 527.1, productType: null, exchange: 'MCX', now: NOW });
    expect(r).toMatchObject({ outcome: 'BYPASS', bypassReason: 'FACTS_UNREADABLE' });
  });

  it('DB error ⇒ unreadable', async () => {
    const { svc } = make({ throws: true });
    await expect(svc.load(V as never, NOW)).resolves.toEqual({ kind: 'unreadable', reason: expect.stringContaining('db down') });
  });

  it('load is bounded by GATE_LOAD_TIMEOUT_MS', async () => {
    jest.useFakeTimers();
    const { svc } = make({ slow: true });
    const p = svc.load(V as never, NOW);
    await jest.advanceTimersByTimeAsync(2_001);
    await expect(p).resolves.toEqual({ kind: 'unreadable', reason: expect.stringMatching(/timed out/) });
  });

  it('disabled ⇒ enabled() false and decide returns BYPASS DISABLED without reading anything', () => {
    const { svc, repo } = make({ env: { EXIT_DISCIPLINE_ENABLED: 'false' } });
    expect(svc.enabled()).toBe(false);
    expect(svc.decide({ kind: 'unreadable', reason: 'x' }, { ltpNow: 1, productType: null, exchange: 'MCX', now: NOW }))
      .toMatchObject({ outcome: 'BYPASS', bypassReason: 'DISABLED' });
    expect(repo.verdictPacket).not.toHaveBeenCalled();
  });
});
