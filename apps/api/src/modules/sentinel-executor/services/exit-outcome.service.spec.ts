import { Logger } from '@nestjs/common';
import { parseExitDisciplineConfig } from '../../exit-discipline/config';
import { ExitOutcomeService } from './exit-outcome.service';

const NOW = new Date('2026-10-14T12:10:00Z');
const EXEC = { id: 'e1', userId: 'owner', verdictId: 'cm9verdict1', trackerId: 't1', symbol: 'CRUDEOIL17NOV269000CE', exchange: 'MCX', token: '582930',
  side: 'SELL', quantity: 100, status: 'FILLED', reason: null, createdAt: new Date('2026-10-14T11:01:10Z'), fillPrice: 527.1, orderLtp: 527.4, decisionLtp: null };
const PACKET = { position: { symbol: 'CRUDEOIL17NOV269000CE', side: 'LONG', qty: 100, entryPrice: 521.9, ltp: 527.6 }, money: {}, session: { nowUtc: '2026-10-14T11:00:30.000Z' } };
const DUE = { id: 'o1', executionId: 'e1', userId: 'owner', verdictId: 'cm9verdict1', kind: 'EXECUTED', exchange: 'MCX', token: '582930', symbol: 'X',
  positionSide: 'LONG', qty: 100, decisionPrice: 527.1, decisionAt: new Date('2026-10-14T11:00:30Z'), windowEnd: new Date('2026-10-14T12:00:30Z'), attempts: 0 };
const fullBars = () => Array.from({ length: 60 }, (_, i) => ({ ts: Date.parse('2026-10-14T11:01:00Z') + i * 60_000, open: 530, high: 531, low: 529, close: 530, volume: 0 }));

function make(o: { bars?: unknown[]; hubBars?: unknown[]; serves?: boolean; due?: unknown[]; corpusRows?: number; packet?: unknown; noHub?: boolean } = {}) {
  const execRepo = { scoringCandidates: jest.fn(async () => [EXEC] as unknown[]), qualityBackfillCandidates: jest.fn(async () => [] as unknown[]), update: jest.fn(async () => undefined) };
  const outRepo = {
    createPending: jest.fn(async () => undefined), due: jest.fn(async () => o.due ?? []), markDone: jest.fn(async () => undefined),
    markRetry: jest.fn(async () => undefined), markNoData: jest.fn(async () => undefined),
    corpusPending: jest.fn(async () => [] as unknown[]), markCorpus: jest.fn(async () => undefined), forDay: jest.fn(async () => [] as unknown[]),
  };
  const prisma = {
    sentinelVerdict: { findUnique: jest.fn(async () => (o.packet === null ? null : { packet: o.packet ?? PACKET })) },
    $executeRaw: jest.fn(async () => o.corpusRows ?? 1),
  };
  const candles = { read: jest.fn(async () => o.bars ?? []) };
  const hub = { servesCharts: () => o.serves ?? false, candles: jest.fn(async () => ({ candles: o.hubBars ?? [], incomplete: [] })) };
  const clock = { tradingWindow: jest.fn(() => ({ openMin: 540, closeMin: 1410 })) };
  const moduleRef = { get: jest.fn(() => { if (o.noHub) throw new Error('not found'); return hub; }) };
  const svc = new ExitOutcomeService(execRepo as never, outRepo as never, prisma as never, candles as never,
    moduleRef as never, clock as never, parseExitDisciplineConfig({}), ['owner']);
  return { svc, execRepo, outRepo, prisma, candles, hub, clock, moduleRef };
}

describe('ExitOutcomeService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('creates a PENDING EXECUTED outcome: decision price = fill, side from SELL, qty and decisionAt from the packet', async () => {
    const { svc, outRepo } = make();
    await svc.runOnce(NOW);
    expect(outRepo.createPending).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'e1', userId: 'owner', verdictId: 'cm9verdict1', trackerId: 't1', exchange: 'MCX', token: '582930',
      kind: 'EXECUTED', positionSide: 'LONG', qty: 100, decisionPrice: 527.1,
      decisionAt: new Date('2026-10-14T11:00:30.000Z'), windowEnd: new Date('2026-10-14T12:00:30.000Z'), status: 'PENDING',
    }));
  });

  it('the window ends at the exchange close when that comes first', async () => {
    const { svc, outRepo, clock } = make();
    clock.tradingWindow.mockReturnValue({ openMin: 540, closeMin: 16 * 60 + 40 }); // 16:40 IST
    await svc.runOnce(NOW);
    expect(outRepo.createPending).toHaveBeenCalledWith(expect.objectContaining({ windowEnd: new Date('2026-10-14T11:10:00.000Z') }));
  });

  it('a BUY exit closes a SHORT; a PLACED row older than the window is EXECUTED at the order LTP when no fill is known', async () => {
    const { svc, execRepo, outRepo } = make({ packet: { ...PACKET, position: { ...PACKET.position, side: 'SHORT' } } });
    execRepo.scoringCandidates.mockResolvedValueOnce([{ ...EXEC, side: 'BUY', status: 'PLACED', fillPrice: null }]);
    await svc.runOnce(NOW);
    expect(outRepo.createPending).toHaveBeenCalledWith(expect.objectContaining({ kind: 'EXECUTED', positionSide: 'SHORT', decisionPrice: 527.4 }));
  });

  it('a gated skip is scored at the order LTP; an awaiting skip is AWAITING; dry-run is DRY_RUN', async () => {
    const { svc, execRepo, outRepo } = make();
    execRepo.scoringCandidates.mockResolvedValueOnce([
      { ...EXEC, id: 'g', status: 'SKIPPED', reason: 'GATED_THESIS_INTACT', fillPrice: null },
      { ...EXEC, id: 'a', status: 'SKIPPED', reason: 'AWAITING_CONFIRMATION', fillPrice: null },
      { ...EXEC, id: 'd', status: 'DRY_RUN', reason: 'would SELL', fillPrice: null },
    ]);
    await svc.runOnce(NOW);
    expect(outRepo.createPending).toHaveBeenCalledWith(expect.objectContaining({ executionId: 'g', kind: 'GATED', decisionPrice: 527.4 }));
    expect(outRepo.createPending).toHaveBeenCalledWith(expect.objectContaining({ executionId: 'a', kind: 'AWAITING' }));
    expect(outRepo.createPending).toHaveBeenCalledWith(expect.objectContaining({ executionId: 'd', kind: 'DRY_RUN' }));
  });

  it('a gated row with no plan yet falls back to the packet for side and price; nothing usable ⇒ not created', async () => {
    const { svc, execRepo, outRepo } = make();
    execRepo.scoringCandidates.mockResolvedValueOnce([
      { ...EXEC, id: 'g', status: 'SKIPPED', reason: 'GATED_THESIS_INTACT', side: null, quantity: null, fillPrice: null, orderLtp: null },
    ]);
    await svc.runOnce(NOW);
    expect(outRepo.createPending).toHaveBeenCalledWith(expect.objectContaining({ executionId: 'g', positionSide: 'LONG', qty: 100, decisionPrice: 527.6 }));

    const none = make({ packet: null });
    none.execRepo.scoringCandidates.mockResolvedValueOnce([{ ...EXEC, side: null, fillPrice: null, orderLtp: null }]);
    await none.svc.runOnce(NOW);
    expect(none.outRepo.createPending).not.toHaveBeenCalled();
  });

  it('a price-trigger row is scored from the row (createdAt, quantity), never the packet', async () => {
    const { svc, execRepo, outRepo, prisma } = make();
    execRepo.scoringCandidates.mockResolvedValueOnce([{ ...EXEC, verdictId: 'trg_abc', quantity: 50 }]);
    await svc.runOnce(NOW);
    expect(outRepo.createPending).toHaveBeenCalledWith(expect.objectContaining({ verdictId: 'trg_abc', qty: 50, decisionAt: EXEC.createdAt }));
    expect(prisma.sentinelVerdict.findUnique).not.toHaveBeenCalled();
  });

  it('MANUAL rows are never scored (filtered by the query) and never reach the corpus', async () => {
    const { svc, execRepo } = make();
    await svc.runOnce(NOW);
    expect(execRepo.scoringCandidates).toHaveBeenCalledWith(NOW, new Date(NOW.getTime() - 48 * 3_600_000), 60);
  });

  it('covered DB bars ⇒ DONE from candles_1m, no hub call', async () => {
    const { svc, outRepo, hub, candles } = make({ bars: fullBars(), due: [DUE], serves: true });
    await svc.runOnce(NOW);
    expect(candles.read).toHaveBeenCalledWith('1m', { exchange: 'MCX', token: '582930', symbol: 'X' }, DUE.decisionAt.getTime(), DUE.windowEnd.getTime());
    expect(outRepo.markDone).toHaveBeenCalledWith('o1', expect.objectContaining({ maxAfter: 531, barsUsed: 60 }), 'candles_1m', null, NOW);
    expect(hub.candles).not.toHaveBeenCalled();
  });

  it('uncovered DB bars ⇒ one hub fill; covered there ⇒ DONE hub-fill', async () => {
    const { svc, outRepo, hub } = make({ due: [DUE], serves: true, hubBars: fullBars() });
    await svc.runOnce(NOW);
    expect(hub.candles).toHaveBeenCalledTimes(1);
    expect(hub.candles).toHaveBeenCalledWith({ exchange: 'MCX', token: '582930', symbol: 'X' }, '1m', DUE.decisionAt, DUE.windowEnd);
    expect(outRepo.markDone).toHaveBeenCalledWith('o1', expect.objectContaining({ maxAfter: 531 }), 'hub-fill', null, NOW);
  });

  it('uncovered DB bars ⇒ one hub fill; still uncovered ⇒ retry, never NO_DATA within 24 h', async () => {
    const { svc, outRepo, hub } = make({ due: [DUE], serves: true });
    await svc.runOnce(NOW);
    expect(hub.candles).toHaveBeenCalledTimes(1);
    expect(outRepo.markRetry).toHaveBeenCalledWith('o1', expect.any(String));
    expect(outRepo.markNoData).not.toHaveBeenCalled();
  });

  it('a row that keeps failing to cover backs off the hub fill (bounded historical calls: ~100/day, not 1440)', async () => {
    const calledAt = (attempts: number) => {
      const m = make({ due: [{ ...DUE, attempts }], serves: true });
      return m.svc.runOnce(NOW).then(() => m.hub.candles.mock.calls.length);
    };
    // The first few attempts fill eagerly; then once every 15 passes.
    expect(await calledAt(0)).toBe(1);
    expect(await calledAt(2)).toBe(1);
    expect(await calledAt(3)).toBe(0);
    expect(await calledAt(14)).toBe(0);
    expect(await calledAt(15)).toBe(1);
    expect(await calledAt(29)).toBe(0);
    expect(await calledAt(30)).toBe(1);
    const fills = Array.from({ length: 1440 }, (_, a) => a).filter((a) => a < 3 || a % 15 === 0).length;
    expect(fills).toBeLessThanOrEqual(100);
  });

  it('a backed-off row still reads candles_1m every pass and is retried, not NO_DATA', async () => {
    const { svc, outRepo, hub, candles } = make({ due: [{ ...DUE, attempts: 7 }], serves: true });
    await svc.runOnce(NOW);
    expect(candles.read).toHaveBeenCalledTimes(1);
    expect(hub.candles).not.toHaveBeenCalled();
    expect(outRepo.markRetry).toHaveBeenCalledWith('o1', expect.any(String));
  });

  it('a backed-off row still gets the last-chance partial scoring after 24 h', async () => {
    const late = new Date(DUE.windowEnd.getTime() + 25 * 3_600_000);
    const { svc, outRepo } = make({ due: [{ ...DUE, attempts: 7 }], bars: fullBars().slice(0, 10), serves: true });
    await svc.runOnce(late);
    expect(outRepo.markDone).toHaveBeenCalledWith('o1', expect.anything(), 'candles_1m', 'partial', late);
  });

  it('a hub that does not serve charts (or is absent) is never called', async () => {
    for (const o of [{ serves: false }, { noHub: true }]) {
      const { svc, outRepo, hub } = make({ due: [DUE], ...o });
      await svc.runOnce(NOW);
      expect(hub.candles).not.toHaveBeenCalled();
      expect(outRepo.markRetry).toHaveBeenCalledTimes(1);
    }
  });

  it('after 24 h: partial bars ⇒ DONE (note partial); none ⇒ NO_DATA', async () => {
    const late = new Date(DUE.windowEnd.getTime() + 25 * 3_600_000);
    const partial = make({ due: [DUE], bars: fullBars().slice(0, 10) });
    await partial.svc.runOnce(late);
    expect(partial.outRepo.markDone).toHaveBeenCalledWith('o1', expect.objectContaining({ barsUsed: 10 }), 'candles_1m', 'partial', late);
    const none = make({ due: [DUE] });
    await none.svc.runOnce(late);
    expect(none.outRepo.markNoData).toHaveBeenCalledWith('o1', expect.any(String), late);
  });

  it('one [exit-outcome] line per DONE row', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { svc } = make({ bars: fullBars(), due: [DUE] });
    await svc.runOnce(NOW);
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[exit-outcome]'))).toEqual([
      '[exit-outcome] X EXECUTED missed=₹390 saved=₹0 net=₹290 (candles_1m)',
    ]);
  });

  it('corpus write targets the sentinel record by decision->>verdictId; 0 rows ⇒ retried later', async () => {
    const { svc, outRepo, prisma } = make({ corpusRows: 0 });
    outRepo.corpusPending.mockResolvedValueOnce([{ ...DUE, verdictId: 'cm9verdict1', status: 'DONE', missedPnl: 1490, savedPnl: 410, netAtEnd: 1190 }]);
    await svc.runOnce(NOW);
    const sql = (prisma.$executeRaw.mock.calls[0] as unknown[])[0] as { strings: string[]; values: unknown[] };
    expect(sql.strings.join('?')).toMatch(/"decision"->>'verdictId'/);
    expect(sql.strings.join('?')).toMatch(/"source" = 'sentinel'/);
    expect(sql.values).toEqual(expect.arrayContaining(['cm9verdict1']));
    expect(JSON.parse(sql.values.find((x) => typeof x === 'string' && x.startsWith('{')) as string)).toMatchObject({ kind: 'EXECUTED', missedPnl: 1490 });
    expect(outRepo.markCorpus).not.toHaveBeenCalled();
  });

  it('a corpus row updated ⇒ marked', async () => {
    const { svc, outRepo } = make({ corpusRows: 1 });
    outRepo.corpusPending.mockResolvedValueOnce([{ ...DUE, verdictId: 'cm9verdict1', status: 'DONE', missedPnl: 1, savedPnl: 2, netAtEnd: 3 }]);
    await svc.runOnce(NOW);
    expect(outRepo.markCorpus).toHaveBeenCalledWith('o1', NOW);
  });

  it('a trg_ or man_ outcome is never written to the corpus', async () => {
    const { svc, outRepo, prisma } = make();
    outRepo.corpusPending.mockResolvedValueOnce([{ id: 'o2', verdictId: 'trg_x' }, { id: 'o3', verdictId: 'man_t1_1' }]);
    await svc.runOnce(NOW);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('E5 backfill: AI ⇒ packet ltp/time; slippage and latency computed', async () => {
    const { svc, execRepo } = make();
    execRepo.qualityBackfillCandidates.mockResolvedValueOnce([{ ...EXEC, fillAt: new Date('2026-10-14T11:01:15Z') }]);
    await svc.runOnce(NOW);
    expect(execRepo.update).toHaveBeenCalledWith('e1', {
      decisionLtp: 527.6, decisionAt: new Date('2026-10-14T11:00:30.000Z'), slippage: expect.closeTo(-0.5, 6), latencyMs: 45_000,
    });
  });

  it('E5 backfill: MANUAL / trigger ⇒ order LTP and row time', async () => {
    const { svc, execRepo, prisma } = make();
    execRepo.qualityBackfillCandidates.mockResolvedValueOnce([{ ...EXEC, verdictId: 'man_t1_1', fillAt: new Date('2026-10-14T11:01:15Z') }]);
    await svc.runOnce(NOW);
    expect(execRepo.update).toHaveBeenCalledWith('e1', {
      decisionLtp: 527.4, decisionAt: EXEC.createdAt, slippage: expect.closeTo(-0.3, 6), latencyMs: 5_000,
    });
    expect(prisma.sentinelVerdict.findUnique).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'man_t1_1' } }));
  });

  it('one scorecard line per user per IST day after 00:05 IST', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { svc, outRepo } = make();
    outRepo.forDay.mockResolvedValue([{ kind: 'GATED', missedPnl: 900, savedPnl: 300, netAtEnd: 600 }]);
    const after = new Date('2026-10-14T18:36:00Z'); // 00:06 IST 15-Oct
    await svc.runOnce(after);
    await svc.runOnce(new Date(after.getTime() + 60_000));
    expect(outRepo.forDay).toHaveBeenCalledTimes(1);
    expect(outRepo.forDay).toHaveBeenCalledWith('owner', '2026-10-14');
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[exit-score]'))).toEqual([
      '[exit-score] 2026-10-14 executed=0 missed=₹0 saved=₹0 | gate blocked=1 (gated 1, awaiting 0) helped=₹600 cost=₹0 net=₹600 | dry-run=0',
    ]);
  });

  it('before 00:05 IST the previous day is not scored yet', async () => {
    const { svc, outRepo } = make();
    await svc.runOnce(new Date('2026-10-14T18:32:00Z')); // 00:02 IST
    expect(outRepo.forDay).not.toHaveBeenCalled();
  });

  it('every step is isolated: a failing step is logged and the rest still run; runOnce never throws; single-flight', async () => {
    const { svc, execRepo, outRepo } = make({ bars: fullBars(), due: [DUE] });
    execRepo.scoringCandidates.mockRejectedValueOnce(new Error('db down'));
    execRepo.qualityBackfillCandidates.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.runOnce(NOW)).resolves.toBeUndefined();
    expect(outRepo.markDone).toHaveBeenCalledTimes(1);
    let release!: () => void;
    execRepo.scoringCandidates.mockReturnValueOnce(new Promise((r) => { release = () => r([]); }));
    const first = svc.runOnce(NOW);
    await svc.runOnce(NOW);
    expect(execRepo.scoringCandidates).toHaveBeenCalledTimes(2);
    release();
    await first;
  });
});
