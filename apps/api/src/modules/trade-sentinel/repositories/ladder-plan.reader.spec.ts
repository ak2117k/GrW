import { Logger } from '@nestjs/common';
import { PrismaLadderPlanReader, instrumentKindOf, manualLadderPlan, premiumStopOf } from './ladder-plan.reader';
import type { LadderPlanRequest } from '../ports/ladder-plans.port';

const REQ: LadderPlanRequest = {
  trackerId: 't1', userId: 'owner', symbol: 'NIFTY04NOV2625000CE', side: 'LONG', entry: 100, spot: 25010, levels: [24950, 25100], fallbackStop: 80,
};

function reader(order: unknown, verdicts: unknown[] = []) {
  const prisma = {
    signalOrder: { findFirst: jest.fn().mockResolvedValue(order) },
    sentinelVerdict: { findMany: jest.fn().mockResolvedValue(verdicts) },
  };
  return { r: new PrismaLadderPlanReader(prisma as never, 'on'), prisma };
}

describe('PrismaLadderPlanReader (target ladder plans)', () => {
  it('a live signal order on the tracker: the plan\'s own targets (ahead of the entry), its SL as the risk stop', async () => {
    const { r, prisma } = reader({ targets: [140, 120, 95], sl: 90, decisionId: 'd1' });
    expect(await r.planFor(REQ)).toMatchObject({ targets: [120, 140], riskStop: 90, source: 'signal' });
    expect(prisma.sentinelVerdict.findMany).not.toHaveBeenCalled();
  });

  it('a manual trade with a proposed premium stop: engine targets at 1.5 R / 2.5 R on it (options: R targets only)', async () => {
    const { r } = reader(null, [{ exitTrigger: null }, { exitTrigger: { v: 1, instrument: 'PREMIUM', op: 'BELOW', price: 90 } }]);
    const p = await r.planFor(REQ);
    expect(p).toMatchObject({ source: 'ai-trigger', riskStop: 90, targets: [115, 125] });
    expect(p?.detail).toMatch(/1\.5 R.*2\.5 R/);
  });

  it('no stop on record: the default (1× daily ATR) stop the cycle passed; none known yet ⇒ null (retried)', async () => {
    expect(await reader(null).r.planFor(REQ)).toMatchObject({ source: 'atr-default', riskStop: 80, targets: [130, 150] });
    expect(await reader(null).r.planFor({ ...REQ, fallbackStop: null })).toBeNull();
  });

  it('a future uses the level ahead (≥ 1 R) before the R multiples', () => {
    const fut = { ...REQ, symbol: 'NIFTY25NOVFUT', entry: 25000, spot: 25000, levels: [25010, 25100] };
    const p = manualLadderPlan(fut, 24950, 'atr-default', 'x');
    // 25010 is 0.2 R away (skipped); 25100 = 2 R; then 2.5 R = 25125.
    expect(p.targets).toEqual([25100, 25125]);
  });

  it('a read failure is a null plan (retried later), never a throw', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const prisma = { signalOrder: { findFirst: jest.fn().mockRejectedValue(new Error('db down')) }, sentinelVerdict: { findMany: jest.fn() } };
    expect(await new PrismaLadderPlanReader(prisma as never).planFor(REQ)).toBeNull();
    jest.restoreAllMocks();
  });

  it('helpers: kind by suffix; only a protective premium stop on the loss side counts', () => {
    expect(instrumentKindOf('NIFTY04NOV2625000PE')).toBe('PE');
    expect(instrumentKindOf('RELIANCE-EQ')).toBe('EQ');
    expect(premiumStopOf({ instrument: 'PREMIUM', op: 'BELOW', price: 90 }, 'LONG', 100)).toBe(90);
    expect(premiumStopOf({ instrument: 'PREMIUM', op: 'BELOW', price: 105 }, 'LONG', 100)).toBeNull();
    expect(premiumStopOf({ instrument: 'UNDERLYING', op: 'BELOW', price: 24900 }, 'LONG', 100)).toBeNull();
    expect(premiumStopOf({ instrument: 'PREMIUM', op: 'ABOVE', price: 110 }, 'SHORT', 100)).toBe(110);
  });
});
