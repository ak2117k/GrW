import type { PrismaService } from '../../../common/prisma/prisma.service';
import { CoreCorpusWriter } from './core-corpus.writer';
import type { CorpusSetup } from './journal.types';

const AT = new Date('2026-10-13T05:00:00.000Z');
const setup: CorpusSetup = {
  intentId: 'ci_1', userId: 'user_A', decidedAt: AT, symbol: 'RELIANCE-EQ', exchange: 'NSE', vehicle: 'CASH_INTRADAY', direction: 'LONG',
  strategyKey: 'adaptive-stop', strategyVersionId: 'csv_adaptive_stop_v1', setupGroupKey: 'alert_1|RELIANCE|2026-10-13',
  evidence: { score: 70, atrSource: 'none' }, ruleScore: 70, decision: { taken: false, reason: 'GATE: not at support' },
};

describe('CoreCorpusWriter (O9, J20)', () => {
  it("upserts one ENTRY_SETUP per intent (source 'core', sourceId = intentId); the first write wins", async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const w = new CoreCorpusWriter({ aiDecisionRecord: { upsert } } as unknown as PrismaService);
    await w.entrySetup(setup);
    expect(upsert).toHaveBeenCalledWith({
      where: { source_sourceId: { source: 'core', sourceId: 'ci_1' } },
      create: {
        userId: 'user_A', source: 'core', sourceId: 'ci_1', kind: 'ENTRY_SETUP', decidedAt: AT, symbol: 'RELIANCE-EQ', exchange: 'NSE',
        direction: 'LONG', vehicle: 'CASH_INTRADAY', strategyKey: 'adaptive-stop', strategyVersionId: 'csv_adaptive_stop_v1',
        setupGroupKey: 'alert_1|RELIANCE|2026-10-13', evidence: { score: 70, atrSource: 'none' }, ruleScore: 70,
        decision: { taken: false, reason: 'GATE: not at support' },
      },
      update: {},
    });
  });

  it('merges an outcome patch into the existing outcome (jsonb ||) and stamps outcomeAt', async () => {
    const $executeRaw = jest.fn().mockResolvedValue(1);
    const w = new CoreCorpusWriter({ $executeRaw } as unknown as PrismaService);
    await w.outcome('ci_1', { priceAfter30m: 501.2 }, AT);
    const [sql, ...values] = $executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(sql.join('?')).toContain('COALESCE("outcome", \'{}\'::jsonb) ||');
    expect(values).toEqual([JSON.stringify({ priceAfter30m: 501.2 }), AT, 'ci_1']);
  });
});

describe('CoreCorpusWriter — skip then open (review fix 2: corpus label)', () => {
  it('a taken setup replaces an earlier skipped one for the same intent (decision.taken becomes true); a skip never overwrites', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const w = new CoreCorpusWriter({ aiDecisionRecord: { upsert } } as unknown as PrismaService);
    const opened: CorpusSetup = { ...setup, decidedAt: new Date(AT.getTime() + 60_000), evidence: { qty: 400 }, decision: { taken: true, reason: 'opened pos_1 for 400' } };
    await w.entrySetup(opened);
    expect(upsert.mock.calls[0][0].update).toEqual({
      decidedAt: opened.decidedAt, setupGroupKey: opened.setupGroupKey, evidence: { qty: 400 }, ruleScore: 70,
      decision: { taken: true, reason: 'opened pos_1 for 400' },
    });
    await w.entrySetup(setup);
    expect(upsert.mock.calls[1][0].update).toEqual({});
  });
});
