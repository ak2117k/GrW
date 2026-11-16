import { PaperLadderPlanReader, paperLadderFrom } from './paper-ladder.reader';

const req = (over: Record<string, unknown> = {}) => ({ trackerId: 'paper:t1', userId: 'u', symbol: 'GOLD27NOV26135000PE', side: 'LONG' as const, entry: 2645.86, spot: null, levels: [], fallbackStop: null, ...over });

describe('PaperLadderPlanReader (F4: profit protection on paper)', () => {
  it('uses the paper trade\'s own target and stop', async () => {
    const prisma = { trade: { findUnique: jest.fn().mockResolvedValue({ stoploss: 1984, target: 3968.5 }) } };
    const plan = await new PaperLadderPlanReader(prisma as never).planFor(req());
    expect(prisma.trade.findUnique.mock.calls[0][0].where).toEqual({ id: 't1' });
    expect(plan).toMatchObject({ targets: [3968.5], riskStop: 1984, source: 'signal' });
  });

  it('no target: 1.5 R / 2.5 R from the stop; nothing on record and no fallback: null', async () => {
    const r = new PaperLadderPlanReader({ trade: { findUnique: jest.fn().mockResolvedValue({ stoploss: 90, target: null }) } } as never);
    await expect(r.planFor(req({ entry: 100 }))).resolves.toMatchObject({ targets: [115, 125], riskStop: 90 });
    const none = new PaperLadderPlanReader({ trade: { findUnique: jest.fn().mockResolvedValue(null) } } as never);
    await expect(none.planFor(req())).resolves.toBeNull();
  });

  it('PAPER_LADDER=off gives no reader', () => {
    expect(paperLadderFrom({} as never, 'off')).toBeUndefined();
    expect(paperLadderFrom({} as never, undefined)?.mode).toBe('on');
  });
});
