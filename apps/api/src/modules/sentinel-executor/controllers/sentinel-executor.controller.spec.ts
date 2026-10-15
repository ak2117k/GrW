// apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.spec.ts
import { ForbiddenException } from '@nestjs/common';
import { SentinelExecutorController } from './sentinel-executor.controller';
import { toAiExitExecutionDto } from '../dto/ai-exit-execution.dto';
import { BadRequestException } from '@nestjs/common';

/** The outcome repository: no outcomes unless a test says otherwise. */
const OUT = { byExecutionIds: jest.fn().mockResolvedValue([]), forDay: jest.fn().mockResolvedValue([]) };

const row = {
  id: 'r1', userId: 'owner', verdictId: 'v1', trackerId: 't1', symbol: 'X', exchange: 'MCX', token: '1',
  side: 'SELL', quantity: 100, productType: 'CARRYFORWARD', orderType: 'MARKET', limitPrice: null,
  mode: 'dry-run', status: 'DRY_RUN', reason: 'would SELL', sessionSource: 'user-feed', brokerOrderId: null,
  brokerMessage: null, orderStatus: null, marketOrderId: null, verdictReason: 'thesis broken',
  createdAt: new Date('2026-10-12T10:00:00Z'), updatedAt: new Date('2026-10-12T10:00:01Z'),
};

describe('SentinelExecutorController', () => {
  const repo = { listForUser: jest.fn().mockResolvedValue([row]) };
  const ctl = new SentinelExecutorController(repo as never, {} as never, {} as never, OUT as never);
  afterEach(() => { delete process.env.AI_AUTO_EXIT_USER_IDS; repo.listForUser.mockClear(); });

  it('allow-listed user sees only their own rows, mapped to the DTO', async () => {
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    const out = await ctl.list({ userId: 'owner', role: 'USER', email: 'o@x' });
    expect(repo.listForUser).toHaveBeenCalledWith('owner', 20);
    expect(out[0]).toEqual(expect.objectContaining({ id: 'r1', status: 'DRY_RUN', createdAt: '2026-10-12T10:00:00.000Z' }));
    expect(out[0]).not.toHaveProperty('userId');
    expect(out[0]).not.toHaveProperty('token');
  });

  it('an admin not on the allow-list is allowed, still scoped to self', async () => {
    await ctl.list({ userId: 'admin1', role: 'ADMIN', email: 'a@x' });
    expect(repo.listForUser).toHaveBeenCalledWith('admin1', 20);
  });

  it('anyone else is 403 and nothing is read', async () => {
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    await expect(ctl.list({ userId: 'u2', role: 'USER', email: 'u@x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.list(undefined as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.listForUser).not.toHaveBeenCalled();
  });

  it('limit is clamped to 1..100', async () => {
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    await ctl.list({ userId: 'owner', role: 'USER', email: 'o@x' }, '1000');
    expect(repo.listForUser).toHaveBeenLastCalledWith('owner', 100);
    await ctl.list({ userId: 'owner', role: 'USER', email: 'o@x' }, 'abc');
    expect(repo.listForUser).toHaveBeenLastCalledWith('owner', 20);
    await ctl.list({ userId: 'owner', role: 'USER', email: 'o@x' }, '-5');
    expect(repo.listForUser).toHaveBeenLastCalledWith('owner', 20);
  });
});

describe('SentinelExecutorController — manual exit', () => {
  it('rows carry a trigger: AI for a sentinel verdict, MANUAL for the owner button', async () => {
    const repo = { listForUser: jest.fn().mockResolvedValue([row, { ...row, id: 'r2', verdictId: 'man_t1_1', verdictReason: 'MANUAL: owner exit' }]) };
    const ctl = new SentinelExecutorController(repo as never, {} as never, {} as never, OUT as never);
    const out = await ctl.list({ userId: 'admin1', role: 'ADMIN', email: 'a@x' });
    expect(out.map((r) => r.trigger)).toEqual(['AI', 'MANUAL']);
  });

  it('POST exit/:trackerId passes the JWT caller (never a body) and returns the row as a DTO without waiting for the broker', async () => {
    let finish: (v: unknown) => void = () => undefined;
    const done = new Promise((r) => { finish = r; });
    const manual = { request: jest.fn().mockResolvedValue({ row: { ...row, status: 'CLAIMED', verdictId: 'man_t1_1' }, started: true, done }) };
    const ctl = new SentinelExecutorController({} as never, {} as never, manual as never, OUT as never);
    const user = { userId: 'owner', role: 'ADMIN', email: 'o@x' };
    const out = await ctl.exit(user, 't1');
    expect(manual.request).toHaveBeenCalledWith(user, 't1');
    expect(out).toEqual(expect.objectContaining({ status: 'CLAIMED', trigger: 'MANUAL', verdictId: 'man_t1_1' }));
    finish({ status: 'FILLED' });
  });

  it('a rejected background run is logged, never an unhandled rejection', async () => {
    const manual = { request: jest.fn().mockResolvedValue({ row: { ...row, verdictId: 'man_t1_1' }, started: true, done: Promise.reject(new Error('db down')) }) };
    const ctl = new SentinelExecutorController({} as never, {} as never, manual as never, OUT as never);
    await expect(ctl.exit({ userId: 'owner', role: 'ADMIN', email: 'o@x' }, 't1')).resolves.toBeDefined();
    await new Promise((r) => setImmediate(r));
  });
});

describe('SentinelExecutorController — GET triggers (price triggers)', () => {
  const row = { id: 'trg1', userId: 'owner', trackerId: 't1', verdictId: 'v1', symbol: 'S', instrument: 'UNDERLYING', op: 'BELOW',
    price: 8930, watchExchange: 'MCX', watchToken: '472789', watchSymbol: 'CRUDEOIL19NOV26FUT', refPrice: 8951, status: 'ARMED',
    reason: null, armedAt: new Date('2026-10-13T17:03:00Z'), endedAt: null, firedAt: null, firedPrice: null, firedTickAt: null,
    createdAt: new Date('2026-10-13T17:03:00Z'), updatedAt: new Date('2026-10-13T17:03:00Z') };
  afterEach(() => { delete process.env.AI_AUTO_EXIT_USER_IDS; });

  it('the caller’s own rows only, as DTOs, limit clamped to 100', async () => {
    const listForUser = jest.fn().mockResolvedValue([row]);
    const c = new SentinelExecutorController({} as never, { listForUser } as never, {} as never, OUT as never);
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    const out = await c.triggers({ userId: 'owner', role: 'USER' } as never, '500');
    expect(listForUser).toHaveBeenCalledWith('owner', 100);
    expect(out[0]).toEqual(expect.objectContaining({ id: 'trg1', status: 'ARMED', watchSymbol: 'CRUDEOIL19NOV26FUT', armedAt: '2026-10-13T17:03:00.000Z' }));
    expect(out[0]).not.toHaveProperty('userId');
    expect(out[0]).not.toHaveProperty('watchToken');
  });

  it('403 for a non-admin outside the allow-list, before any query', async () => {
    const listForUser = jest.fn();
    const c = new SentinelExecutorController({} as never, { listForUser } as never, {} as never, OUT as never);
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    await expect(c.triggers({ userId: 'x', role: 'USER' } as never)).rejects.toThrow('not enabled');
    await expect(c.triggers(undefined as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(listForUser).not.toHaveBeenCalled();
  });
});

describe('AiExitExecutionDto.triggerId', () => {
  it('triggerId is the trigger row id for trg_ executions, null otherwise', () => {
    const base = { verdictId: 'trg_trg1', createdAt: new Date(0), updatedAt: new Date(0) } as never;
    expect(toAiExitExecutionDto({ ...(base as object), verdictId: 'trg_trg1' } as never)).toMatchObject({ trigger: 'PRICE_TRIGGER', triggerId: 'trg1' });
    expect(toAiExitExecutionDto({ ...(base as object), verdictId: 'cm9v' } as never)).toMatchObject({ trigger: 'AI', triggerId: null });
    expect(toAiExitExecutionDto({ ...(base as object), verdictId: 'man_t1_1' } as never)).toMatchObject({ trigger: 'MANUAL', triggerId: null });
  });

});

describe('SentinelExecutorController — exit discipline (gate, quality, outcome, scorecard)', () => {
  const GATE = {
    v: 1, outcome: 'GATED_THESIS_INTACT', justification: null, clauses: [], persistence: null, cfg: {}, evaluatedAt: '2026-10-14T11:01:00.000Z',
    facts: { exposure: 'BULLISH', positionSide: 'LONG', ltpNow: 527.1, underlying: 9003, invalidation: 8932, holdRef: null, vwap: 9000,
      nContract: 4.5, nUnderlying: 3.1, floor: { price: 530.5, armed: true, basis: 'noise' }, netPnlNow: 459, maxLossPerTrade: 2000,
      minutesToClose: 419, productType: 'CARRYFORWARD', isExpiryDay: false, dailyLossLatched: false },
  };
  const exec = { ...row, id: 'e1', status: 'FILLED', mode: 'live', gate: GATE, decisionLtp: 527.6, decisionAt: new Date('2026-10-14T11:00:30Z'),
    orderLtp: 527.4, orderSentAt: new Date('2026-10-14T11:01:01Z'), fillPrice: 527.1, fillQty: 100, fillAt: new Date('2026-10-14T11:01:05Z'),
    slippage: -0.5, latencyMs: 35_000 };
  const outcome = { executionId: 'e1', kind: 'EXECUTED', status: 'DONE', missedPnl: 1490, savedPnl: 410, netAtEnd: 1190, windowEnd: new Date('2026-10-14T12:00:30Z') };
  beforeEach(() => { OUT.byExecutionIds.mockClear(); OUT.forDay.mockClear(); });
  afterEach(() => { delete process.env.AI_AUTO_EXIT_USER_IDS; });

  it('executions carry the gate summary, fill quality (cost per unit) and the outcome joined by executionId, in ONE outcome query', async () => {
    const repo = { listForUser: jest.fn().mockResolvedValue([exec, { ...row, id: 'e2' }]) };
    OUT.byExecutionIds.mockResolvedValueOnce([outcome]);
    const ctl = new SentinelExecutorController(repo as never, {} as never, {} as never, OUT as never);
    const out = await ctl.list({ userId: 'admin1', role: 'ADMIN', email: 'a@x' });
    expect(OUT.byExecutionIds).toHaveBeenCalledTimes(1);
    expect(OUT.byExecutionIds).toHaveBeenCalledWith(['e1', 'e2']);
    expect(out[0].gate).toEqual({ outcome: 'GATED_THESIS_INTACT', justification: null, summary: expect.stringMatching(/^GATED_THESIS_INTACT: u 9003, inv 8932/) });
    expect(out[0].quality).toEqual({ decisionLtp: 527.6, orderLtp: 527.4, fillPrice: 527.1, fillAt: '2026-10-14T11:01:05.000Z', slippage: -0.5, costPerUnit: 0.5, latencyMs: 35_000 });
    expect(out[0].outcome).toEqual({ kind: 'EXECUTED', status: 'DONE', missedPnl: 1490, savedPnl: 410, netAtEnd: 1190, windowEnd: '2026-10-14T12:00:30.000Z' });
    expect(out[1]).toEqual(expect.objectContaining({ gate: null, quality: null, outcome: null }));
  });

  it('a BUY (short cover) costs when it fills ABOVE the decision; a garbage gate JSON is null, never a throw', () => {
    const d = toAiExitExecutionDto({ ...exec, side: 'BUY', fillPrice: 528, decisionLtp: 527.6, gate: { junk: true } } as never);
    expect(d.quality!.costPerUnit).toBeCloseTo(0.4, 6);
    expect(d.gate).toBeNull();
  });

  it('GET scorecard: the caller own DONE outcomes of the day (default yesterday IST); 400 for a bad day; 403 when not allowed', async () => {
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    OUT.forDay.mockResolvedValueOnce([{ kind: 'GATED', missedPnl: 900, savedPnl: 300, netAtEnd: 600 }]);
    const ctl = new SentinelExecutorController({} as never, {} as never, {} as never, OUT as never);
    const user = { userId: 'owner', role: 'USER', email: 'o@x' };
    await expect(ctl.scorecard(user, '2026-10-14')).resolves.toEqual({
      day: '2026-10-14', executed: { n: 0, missed: 0, saved: 0 }, dryRun: { n: 0, missed: 0, saved: 0 },
      gate: { blocked: 1, gated: 1, awaiting: 0, helped: 600, cost: 0, net: 600 },
    });
    expect(OUT.forDay).toHaveBeenCalledWith('owner', '2026-10-14');
    await ctl.scorecard(user, undefined, new Date('2026-10-14T19:00:00Z')); // 00:30 IST 15-Oct
    expect(OUT.forDay).toHaveBeenLastCalledWith('owner', '2026-10-14');
    for (const bad of ['2026-13-01', '14-10-2026', 'x', '2026-02-30']) {
      await expect(ctl.scorecard(user, bad)).rejects.toBeInstanceOf(BadRequestException);
    }
    OUT.forDay.mockClear();
    await expect(ctl.scorecard({ userId: 'u2', role: 'USER', email: 'u@x' }, '2026-10-14')).rejects.toBeInstanceOf(ForbiddenException);
    expect(OUT.forDay).not.toHaveBeenCalled();
  });
});
