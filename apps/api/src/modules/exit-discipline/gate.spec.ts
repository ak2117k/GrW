import { parseExitDisciplineConfig } from './config';
import { evaluateExitGate, type GateFacts } from './gate';

const CFG = parseExitDisciplineConfig({});
/** The 2026-10-14 16:31 evidence case: long CRUDEOIL 9000 CE, underlying rising, thesis intact. */
const BASE: GateFacts = {
  exposure: 'BULLISH', positionSide: 'LONG', ltpNow: 527.1, underlying: 9003, invalidation: 8932,
  holdRef: { id: 'vh', underlying: 8998, support: 8946, resistance: 9020, at: '2026-10-14T10:50:00.000Z' },
  vwap: 9000, nContract: 4.5, nUnderlying: 3.1,
  floor: { price: 530.5, armed: true, basis: 'noise' },
  netPnlNow: 420, maxLossPerTrade: 2000, minutesToClose: 419, productType: 'CARRYFORWARD',
  isExpiryDay: false, dailyLossLatched: false,
};
const clause = (r: ReturnType<typeof evaluateExitGate>, id: string) => r.clauses.find((c) => c.id === id)!;

describe('evaluateExitGate', () => {
  it('evidence case: floor breached by premium noise, underlying above VWAP and up since the HOLD ⇒ NOT justified', () => {
    const r = evaluateExitGate(BASE, CFG);
    expect(r).toMatchObject({ justified: false, justification: null, hardRisk: false });
    expect(r.clauses.map((c) => c.id)).toEqual([
      'THESIS_INVALIDATION', 'THESIS_LEVEL', 'HARD_MAX_LOSS', 'HARD_SESSION_CLOSE', 'HARD_EXPIRY',
      'HARD_DAILY_LOSS', 'FLOOR_BREACH_UNDERLYING_MOVE', 'FLOOR_BREACH_VWAP',
    ]);
    expect(clause(r, 'FLOOR_BREACH_UNDERLYING_MOVE')).toMatchObject({ pass: false, measured: expect.objectContaining({ floorBreached: true, adverseMove: -5 }) });
    expect(clause(r, 'FLOOR_BREACH_VWAP')).toMatchObject({ pass: false, measured: expect.objectContaining({ vwap: 9000, underlying: 9003 }) });
  });

  it.each([
    // [label, patch, justification, hardRisk, clearMargin, passing clause]
    ['below invalidation by a clear margin', { underlying: 8930 }, 'THESIS_BROKEN', false, true, 'THESIS_INVALIDATION'],
    ['below invalidation by a hair', { underlying: 8931.5 }, 'THESIS_BROKEN', false, false, 'THESIS_INVALIDATION'],
    ['below the support the trade was HELD against', { underlying: 8940 }, 'THESIS_BROKEN', false, false, 'THESIS_LEVEL'],
    ['net loss at the per-trade max', { netPnlNow: -2000 }, 'HARD_RISK', true, false, 'HARD_MAX_LOSS'],
    ['intraday product 9 min before close', { productType: 'INTRADAY', minutesToClose: 9 }, 'HARD_RISK', true, false, 'HARD_SESSION_CLOSE'],
    ['expiry day 25 min before close', { isExpiryDay: true, minutesToClose: 25 }, 'HARD_RISK', true, false, 'HARD_EXPIRY'],
    ['daily loss latched', { dailyLossLatched: true }, 'HARD_RISK', true, false, 'HARD_DAILY_LOSS'],
    ['floor breached + underlying 3.5 against since HOLD', { holdRef: { ...BASE.holdRef!, underlying: 9006.5 } }, 'CONFIRMED_FLOOR_BREACH', false, false, 'FLOOR_BREACH_UNDERLYING_MOVE'],
    ['floor breached + underlying below VWAP', { underlying: 8999, vwap: 9000 }, 'CONFIRMED_FLOOR_BREACH', false, false, 'FLOOR_BREACH_VWAP'],
  ] as const)('%s', (_l, patch, justification, hardRisk, clear, passing) => {
    const r = evaluateExitGate({ ...BASE, ...(patch as Partial<GateFacts>) }, CFG);
    expect(r).toMatchObject({ justified: true, justification, hardRisk, thesisClearMargin: clear });
    expect(clause(r, passing).pass).toBe(true);
  });

  it('hard risk outranks a broken thesis in the justification', () => {
    expect(evaluateExitGate({ ...BASE, underlying: 8900, dailyLossLatched: true }, CFG).justification).toBe('HARD_RISK');
  });

  it('carry-forward 9 min before close is NOT hard risk (E3)', () => {
    expect(clause(evaluateExitGate({ ...BASE, minutesToClose: 9 }, CFG), 'HARD_SESSION_CLOSE').pass).toBe(false);
  });

  it('an unarmed floor never confirms a breach, even below VWAP', () => {
    const r = evaluateExitGate({ ...BASE, underlying: 8990, floor: { price: 529.65, armed: false, basis: 'noise' } }, CFG);
    expect(clause(r, 'FLOOR_BREACH_VWAP').pass).toBe(false);
    expect(r.justified).toBe(false);
  });

  it('unknown N_underlying: the move clause is unmeasurable (null) but VWAP still decides', () => {
    const r = evaluateExitGate({ ...BASE, nUnderlying: null, underlying: 8999 }, CFG);
    expect(clause(r, 'FLOOR_BREACH_UNDERLYING_MOVE').pass).toBeNull();
    expect(r.justification).toBe('CONFIRMED_FLOOR_BREACH');
  });

  it('a premium-scale invalidation is never used (scale sanity)', () => {
    const r = evaluateExitGate({ ...BASE, invalidation: 500 }, CFG);
    expect(clause(r, 'THESIS_INVALIDATION')).toMatchObject({ pass: null, note: expect.stringMatching(/scale/) });
  });

  it('unknown exposure or underlying: thesis and underlying clauses null, hard risk still works', () => {
    const r = evaluateExitGate({ ...BASE, exposure: null, underlying: null, dailyLossLatched: true }, CFG);
    expect(clause(r, 'THESIS_INVALIDATION').pass).toBeNull();
    expect(clause(r, 'THESIS_LEVEL').pass).toBeNull();
    expect(clause(r, 'FLOOR_BREACH_VWAP').pass).toBeNull();
    expect(r.justification).toBe('HARD_RISK');
  });

  describe('BEARISH exposure (long PE / short CE / short FUT)', () => {
    const PUT: GateFacts = {
      ...BASE, exposure: 'BEARISH', invalidation: 9050, underlying: 9010, vwap: 9020,
      holdRef: { id: 'vh', underlying: 9012, support: 8980, resistance: 9040, at: '2026-10-14T10:50:00.000Z' },
    };
    it('intact: underlying under the invalidation, under the held resistance, below VWAP', () => {
      expect(evaluateExitGate(PUT, CFG).justified).toBe(false);
    });
    it('broken: underlying ABOVE the invalidation', () => {
      expect(evaluateExitGate({ ...PUT, underlying: 9060 }, CFG)).toMatchObject({ justification: 'THESIS_BROKEN', thesisClearMargin: true });
    });
    it('broken: underlying above the HELD resistance', () => {
      expect(clause(evaluateExitGate({ ...PUT, underlying: 9045 }, CFG), 'THESIS_LEVEL').pass).toBe(true);
    });
    it('floor breach confirmed by the underlying rising above VWAP', () => {
      expect(evaluateExitGate({ ...PUT, underlying: 9025 }, CFG).justification).toBe('CONFIRMED_FLOOR_BREACH');
    });
  });

  it('SHORT position: the floor is breached when ltpNow is ABOVE it', () => {
    const SHORT_FUT: GateFacts = {
      ...BASE, exposure: 'BEARISH', positionSide: 'SHORT', ltpNow: 98.5, underlying: 98.5, invalidation: 104,
      holdRef: { id: 'vh', underlying: 97, support: 95, resistance: 102, at: '2026-10-14T10:50:00.000Z' },
      vwap: 98, nUnderlying: 1, floor: { price: 98, armed: true, basis: 'noise' },
    };
    const r = evaluateExitGate(SHORT_FUT, CFG);
    expect(clause(r, 'FLOOR_BREACH_UNDERLYING_MOVE')).toMatchObject({ pass: true, measured: expect.objectContaining({ adverseMove: 1.5 }) });
    expect(r.justification).toBe('CONFIRMED_FLOOR_BREACH');
  });

  describe('FLOOR_HARD_EXIT: an anchored packet (money.anchors) — prod 2026-10-29 long CRUDEOILM 9350 PE', () => {
    // Crude ground up from the 9531 best point; the floor armed with crude at 9547; the last HOLD was a minute ago at 9551.
    const PE: GateFacts = {
      ...BASE, exposure: 'BEARISH', ltpNow: 375, underlying: 9553, invalidation: 9650, vwap: 9590, nUnderlying: 12.5,
      holdRef: { id: 'vh', underlying: 9551, support: 9500, resistance: 9620, at: '2026-10-29T15:42:00.000Z' },
      floor: { price: 376.8, armed: true, basis: 'noise' }, netPnlNow: 115,
      anchors: { bestUnderlying: 9531, armUnderlying: 9547, packetLtp: 375.2, packetNetPnl: 119, freshNetPnl: 115 },
    };

    it('appends the two hard-floor clauses; a pre-anchor packet keeps exactly the eight', () => {
      expect(evaluateExitGate(PE, CFG).clauses.map((c) => c.id).slice(8)).toEqual(['FLOOR_HARD_GREEN_TO_RED', 'FLOOR_HARD_UNDERLYING_MOVE']);
      expect(evaluateExitGate({ ...PE, anchors: undefined }, CFG).clauses).toHaveLength(8);
      expect(evaluateExitGate(PE, { ...CFG, floorHardExit: false }).clauses).toHaveLength(8);
    });

    it('the confirming move is measured from the floor arm point, never the last HOLD (which re-anchors every verdict)', () => {
      const legacy = clause(evaluateExitGate({ ...PE, anchors: undefined }, CFG), 'FLOOR_BREACH_UNDERLYING_MOVE');
      expect(legacy).toMatchObject({ pass: false, measured: expect.objectContaining({ holdUnderlying: 9551, adverseMove: 2 }) });
      // From a fixed point it needs the hard floor's K (2 N = 25 pts), never one N (prod 2026-10-30 SENSEX CE).
      const oneN = clause(evaluateExitGate({ ...PE, underlying: 9560 }, CFG), 'FLOOR_BREACH_UNDERLYING_MOVE');
      expect(oneN).toMatchObject({ pass: false, measured: expect.objectContaining({ from: 'FLOOR_ARM', refUnderlying: 9547, adverseMove: 13, needN: 2 }) });
      const fixed = clause(evaluateExitGate({ ...PE, underlying: 9573 }, CFG), 'FLOOR_BREACH_UNDERLYING_MOVE');
      expect(fixed).toMatchObject({ pass: true, measured: expect.objectContaining({ from: 'FLOOR_ARM', refUnderlying: 9547, adverseMove: 26 }) });
      // No arm point recorded: the best point stands in.
      const best = clause(evaluateExitGate({ ...PE, underlying: 9556, anchors: { ...PE.anchors!, armUnderlying: null } }, CFG), 'FLOOR_BREACH_UNDERLYING_MOVE');
      expect(best).toMatchObject({ pass: true, measured: expect.objectContaining({ from: 'BEST', adverseMove: 25 }) });
    });

    it('below the floor but still net green, the underlying 1.76 N from the best point: no hard-floor clause passes', () => {
      const r = evaluateExitGate(PE, CFG);
      expect(r.floorHard).toBe(false);
      expect(clause(r, 'FLOOR_HARD_GREEN_TO_RED').pass).toBe(false);
      expect(clause(r, 'FLOOR_HARD_UNDERLYING_MOVE')).toMatchObject({ pass: false, measured: expect.objectContaining({ adverseMove: 22, needN: 2 }) });
    });

    it('FLOOR_HARD_UNDERLYING_MOVE: below the floor on both reads, crude 2 N against from the best point', () => {
      const r = evaluateExitGate({ ...PE, underlying: 9556 }, CFG);
      expect(r).toMatchObject({ justified: true, justification: 'FLOOR_HARD_EXIT', floorHard: true, hardRisk: false });
      expect(clause(r, 'FLOOR_HARD_UNDERLYING_MOVE').pass).toBe(true);
    });

    it('FLOOR_HARD_GREEN_TO_RED: below the floor on both reads and net red on both', () => {
      const red = { ...PE, ltpNow: 368, anchors: { ...PE.anchors!, packetLtp: 368.4, packetNetPnl: -18, freshNetPnl: -26 } };
      expect(evaluateExitGate(red, CFG)).toMatchObject({ justification: 'FLOOR_HARD_EXIT', floorHard: true });
      // One read still green, or one read back above the floor: not a hard exit.
      expect(evaluateExitGate({ ...red, anchors: { ...red.anchors, packetNetPnl: 4 } }, CFG).floorHard).toBe(false);
      expect(evaluateExitGate({ ...red, anchors: { ...red.anchors, packetLtp: 377 } }, CFG).floorHard).toBe(false);
    });

    it('hard risk still outranks the hard floor in the justification', () => {
      expect(evaluateExitGate({ ...PE, underlying: 9556, dailyLossLatched: true }, CFG).justification).toBe('HARD_RISK');
    });
  });

  it('every clause carries its numbers', () => {
    for (const c of evaluateExitGate(BASE, CFG).clauses) {
      expect(Object.keys(c.measured).length).toBeGreaterThan(0);
      expect(c.note).not.toBe('');
    }
  });
});
