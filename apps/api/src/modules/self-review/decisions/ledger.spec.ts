import { DecisionGradeRepository } from './decision-grade.repository';
import { DecisionGradingService, previousWeekday } from './decision-grading.service';
import type { DecisionSourcesRepository } from './decision-sources.repository';
import { carryDrafts, entryDrafts, entryKindOf, exitDrafts, exitTypeOf, reentryDrafts, type ExitExecSrc, type SignalDecisionSrc } from './ledger';
import { perDecisionPnlOf, worstPerDecision } from './rollup';
import type { Bar, DecisionGradeRow } from './types';

const MIN = 60_000;
const linear = (from: number, to: number, n: number) => Array.from({ length: n }, (_, k) => Math.round((from + ((to - from) * (k + 1)) / n) * 100) / 100);
const barsFrom = (startTs: number, closes: number[]): Bar[] => closes.map((c, k) => ({ ts: startTs + k * MIN, high: c, low: c, close: c }));

// Prod 2026-11-04: GOLD27NOV26150000CE channel BUY 566.5 (SL 424.5, T 600/700/1000), SKIPPED by the judge at
// 11:01 IST (live mode ⇒ learning-paper-traded, decision PAPER); the option was ~865 by evening. GOLD: lot 1, ₹100/pt.
const GOLD_AT = Date.parse('2026-11-04T05:31:00Z');
const goldSkip: SignalDecisionSrc = {
  id: 'sd-gold-1104',
  userId: 'owner',
  underlying: 'GOLD',
  decidedAt: new Date(GOLD_AT),
  mode: 'live',
  decision: 'PAPER',
  skipReason: null,
  gate: [{ name: 'market_open', ok: true, required: true, detail: '' }],
  judge: { verdict: 'SKIP', aiDecision: 'SKIP', confidence: 55, reasons: ['no chain / VIX / expected move; mixed news'], packet: { caps: { maxLossPerTrade: 2000 }, market: { chain: { status: 'unavailable', reason: 'no chain' } } } },
  plan: { exchange: 'MCX', token: '445566', tradingsymbol: 'GOLD27NOV26150000CE', lotSize: 1, tickSize: 0.5, side: 'BUY', limitPrice: 566.5, sl: 424.5, slSource: 'signal', targets: [600, 700, 1000], lots: 1, qty: 1, riskRupees: 14200 },
  aiCheck: null,
};
// 566.5 → 865 over the afternoon (no dip to the ₹2,000 cap stop at 546.5), flat into the MCX close.
const goldBars = barsFrom(Math.floor(GOLD_AT / MIN) * MIN + MIN, [...linear(567, 700, 120), ...linear(700, 865, 300), ...Array(300).fill(865)]);
const NEXT_NIGHT = Date.parse('2026-11-05T13:15:00Z'); // 18:45 IST the next day

describe('ledger: entries', () => {
  it('the 2026-11-04 GOLD SKIP grades WRONG with delta > 0, in real ₹ (×100), recomputed (not the ×1 stored fair)', () => {
    const ds = entryDrafts(goldSkip, () => goldBars, NEXT_NIGHT);
    const skip = ds.find((d) => d.decisionType === 'ENTRY_SKIP');
    expect(skip).toBeDefined();
    expect(skip!.verdict).toBe('WRONG');
    expect(skip!.deltaRupees as number).toBeGreaterThan(3000); // first target 600: 33.5 pts × ₹100 − charges
    expect(skip!.sessionDate).toBe('2026-11-04');
    expect(skip!.mode).toBe('paper');
    expect(skip!.facts).toMatchObject({ method: 'contract-1m', valueFactor: 100, judge: 'SKIP' });
    const size = ds.find((d) => d.decisionType === 'SIZE');
    expect(size!.verdict).toBe('RIGHT'); // 142 pts × 1 × ₹100 = ₹14,200 recorded
  });

  it('a GOLD plan sized at ×1 is a WRONG SIZE', () => {
    const ds = entryDrafts({ ...goldSkip, plan: { ...(goldSkip.plan as object), riskRupees: 142 } }, () => goldBars, NEXT_NIGHT);
    expect(ds.find((d) => d.decisionType === 'SIZE')!.verdict).toBe('WRONG');
  });

  it('the MCX close horizon is not graded before 23:30 IST', () => {
    expect(entryDrafts(goldSkip, () => goldBars, Date.parse('2026-11-04T13:15:00Z')).filter((d) => d.decisionType === 'ENTRY_SKIP')).toHaveLength(0);
  });

  it('missing bars ⇒ UNSCORABLE, not RIGHT', () => {
    const skip = entryDrafts(goldSkip, () => null, NEXT_NIGHT).find((d) => d.decisionType === 'ENTRY_SKIP')!;
    expect(skip.verdict).toBe('UNSCORABLE');
    expect(skip.reason).toMatch(/missing bars/);
  });

  it('liveGateBlocked / a failed required gate check ⇒ ENTRY_BLOCKED with the blocker', () => {
    expect(entryKindOf({ decision: 'PAPER', gate: [], judge: { aiDecision: 'TAKE', liveGateBlocked: 'risk_manager' } })).toEqual({ type: 'ENTRY_BLOCKED', blocker: 'risk_manager' });
    expect(entryKindOf({ decision: 'SKIP', gate: [{ name: 'trades_per_day', ok: false, required: true }], judge: null })).toEqual({ type: 'ENTRY_BLOCKED', blocker: 'trades_per_day' });
    expect(entryKindOf({ decision: 'TAKE', gate: [], judge: { aiDecision: 'TAKE' } }).type).toBe('ENTRY_TAKE');
  });
});

describe('ledger: exits and carries', () => {
  const t0 = Date.parse('2026-11-02T04:01:00Z');
  const exec: ExitExecSrc = {
    id: 'ex1', userId: 'owner', verdictId: 'v1', trackerId: 'trk1', symbol: 'LAURUSLABS23NOV262520CE', exchange: 'NFO', token: '777', side: 'SELL', quantity: 425,
    mode: 'live', status: 'FILLED', reason: null, verdictReason: 'floor break', gate: { v: 1, outcome: 'PASS', justification: 'FLOOR_HARD_EXIT', clauses: [], facts: { nContract: 1.2 } },
    decisionLtp: 20.15, decisionAt: new Date(t0), fillPrice: 20.15, createdAt: new Date(t0),
    outcome: { kind: 'EXECUTED', status: 'DONE', positionSide: 'LONG', qty: 425, decisionPrice: 20.15, decisionAt: new Date(t0), closeAt15: 19.0, closeAt30: 16.75, closeAt60: 18.2 },
    spikeLatched: false, trackerExitPrice: 20.15, lotQty: 425, underlying: 'LAURUSLABS',
  };

  it('reuses ai_exit_outcomes closes; LAURUSLABS 2520CE exit 20.15 is RIGHT at every horizon; typed FLOOR', () => {
    const ds = exitDrafts(exec, () => null, Date.parse('2026-11-02T13:00:00Z'));
    expect(ds.map((d) => [d.decisionType, d.horizon, d.verdict])).toEqual([['FLOOR', '15m', 'RIGHT'], ['FLOOR', '30m', 'RIGHT'], ['FLOOR', '60m', 'RIGHT']]);
    expect(ds[0].facts).toMatchObject({ source: 'ai_exit_outcomes' });
  });

  it('a gated exit gets the horizons (chosen hold) plus a close grade against the eventual exit', () => {
    const gated = { ...exec, status: 'SKIPPED', gate: { outcome: 'AWAITING_CONFIRMATION', facts: {} }, decisionLtp: 31.7, fillPrice: null, outcome: null, trackerExitPrice: 20.15 };
    const ds = exitDrafts(gated, () => null, Date.parse('2026-11-02T13:00:00Z'));
    expect(ds.every((d) => d.decisionType === 'GATED_EXIT')).toBe(true);
    const close = ds.find((d) => d.horizon === 'close')!;
    expect(close.verdict).toBe('WRONG');
    expect(ds.filter((d) => d.horizon !== 'close').every((d) => d.verdict === 'UNSCORABLE')).toBe(true); // no bars, no outcome
  });

  it('manual exits and refused orders are not system decisions', () => {
    expect(exitDrafts({ ...exec, verdictId: 'man_1' }, () => null, Date.now())).toEqual([]);
    expect(exitDrafts({ ...exec, status: 'REJECTED' }, () => null, Date.now())).toEqual([]);
  });

  it('exit types from the gate justification', () => {
    expect(exitTypeOf({ justification: 'TARGET_LADDER' }, false)).toBe('LADDER');
    expect(exitTypeOf({ justification: 'FLOOR_HARD_EXIT' }, true)).toBe('SPIKE_BANK');
    expect(exitTypeOf({ justification: 'HARD_RISK', clauses: [{ id: 'HARD_MAX_LOSS', pass: true }] }, false)).toBe('HARD_LOSS');
    expect(exitTypeOf({ justification: 'HARD_RISK', clauses: [{ id: 'HARD_SESSION_CLOSE', pass: true }] }, false)).toBe('EXIT');
  });

  it('carries use the carry scorer priceAt1015, per lot', () => {
    const [d] = carryDrafts({
      id: 'c1', userId: 'owner', mode: 'live', istDay: '2026-11-03', symbol: 'NIFTY11NOV2624000CE', exchange: 'NFO', positionSide: 'LONG', qty: 150, decision: 'CARRY', reason: 'thesis intact',
      decisionPrice: 100, decidedAt: new Date('2026-11-03T09:40:00Z'), scoreStatus: 'DONE', priceAt1015: 112, pnlCarry: 1800, lotQty: 75, underlying: 'NIFTY',
    });
    expect(d.decisionType).toBe('CARRY');
    expect(d.verdict).toBe('RIGHT');
    expect(d.pnlChosen as number).toBeGreaterThan(850); // 12 × 75 − the closing leg (~₹35)
  });
});

describe('rollups', () => {
  const row = (o: Partial<DecisionGradeRow>): DecisionGradeRow => ({
    id: 'x', sessionDate: '2026-11-04', decisionType: 'EXIT', detector: null, refTable: 'ai_exit_executions', refId: 'e1', userId: null, symbol: null, underlying: null,
    mode: 'live', decidedAt: new Date(), chosen: 'exit', alternative: 'hold', pnlChosen: 0, pnlAlternative: 0, deltaRupees: 0, horizon: '15m', verdict: 'RIGHT', reason: '', facts: {}, createdAt: new Date(), ...o,
  });

  it('wrongSince keeps one row per decision: the worst horizon', () => {
    const out = worstPerDecision([row({ horizon: '15m', verdict: 'WRONG', deltaRupees: 600 }), row({ horizon: '60m', verdict: 'WRONG', deltaRupees: 2000 }), row({ refId: 'e2', verdict: 'RIGHT' })]);
    expect(out).toHaveLength(1);
    expect(out[0].horizon).toBe('60m');
  });

  it('perDecisionPnl counts decisions once and lists only sessions that had one; UNSCORABLE never counts', () => {
    const r = perDecisionPnlOf(
      [
        row({ horizon: '15m', deltaRupees: 100 }), row({ horizon: '60m', deltaRupees: 300, verdict: 'RIGHT' }),
        row({ refId: 'e2', sessionDate: '2026-11-03', horizon: '60m', deltaRupees: -100 }),
        row({ refId: 'e3', sessionDate: '2026-11-02', horizon: '60m', deltaRupees: null, verdict: 'UNSCORABLE' }),
      ],
      ['EXIT'],
      ['2026-11-02', '2026-11-03', '2026-11-04'],
    );
    expect(r).toEqual({ sessions: ['2026-11-03', '2026-11-04'], decisions: 2, perDecision: -100 });
  });
});

describe('DecisionGradingService', () => {
  /** A Prisma double keyed like the real unique index. */
  function fakePrisma() {
    const store = new Map<string, Record<string, unknown>>();
    let n = 0;
    const decisionGrade = {
      upsert: jest.fn(async ({ where, create, update }: { where: { refTable_refId_decisionType_horizon: Record<string, string> }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const w = where.refTable_refId_decisionType_horizon;
        const k = `${w.refTable}|${w.refId}|${w.decisionType}|${w.horizon}`;
        const cur = store.get(k);
        store.set(k, cur ? { ...cur, ...update } : { id: `g${++n}`, createdAt: new Date(), ...create });
        return store.get(k);
      }),
      findMany: jest.fn(async () => [...store.values()]),
    };
    return { store, prisma: { decisionGrade, $transaction: (ops: Array<Promise<unknown>>) => Promise.all(ops) } };
  }

  function fakeSources(): DecisionSourcesRepository {
    const none = async () => [];
    return {
      signalDecisions: async () => [{ ...goldSkip, orderStatus: null }],
      exitExecutions: none, holdVerdicts: none, trackers: none, paperExits: none, carries: none, theses: none, engineEnters: none, reentrySignals: none,
      inputPackets: async () => [{ source: 'judge', underlying: 'GOLD', at: goldSkip.decidedAt, userId: 'owner', blocks: { chain: { status: 'unavailable' } } }],
      moveOverAtr: async () => null,
      bars: async () => goldBars,
    } as unknown as DecisionSourcesRepository;
  }

  afterEach(() => delete process.env.SELF_REVIEW_DECISION_LOOP);

  it('upsert is idempotent on rerun', async () => {
    const { store, prisma } = fakePrisma();
    const repo = new DecisionGradeRepository(prisma as never);
    const svc = new DecisionGradingService(fakeSources(), repo);
    const first = await svc.gradeSession('2026-11-04', new Date(NEXT_NIGHT));
    const size = store.size;
    const second = await svc.gradeSession('2026-11-04', new Date(NEXT_NIGHT));
    expect(store.size).toBe(size);
    expect(second).toEqual(first);
    expect(first.error).toBeUndefined();
    expect(first.byType).toMatchObject({ ENTRY_SKIP: 1, SIZE: 1, DETECTOR: 1 });
    expect(first.graded).toBe(2);
    expect(first.wrong).toBe(2); // the GOLD skip + the INPUT_MISSING hit
    const wrong = await repo.wrongSince('2026-11-04');
    expect(wrong.map((w) => w.decisionType).sort()).toEqual(['DETECTOR', 'ENTRY_SKIP']);
  });

  it('never throws: a failing source is named in error, the rest still grade', async () => {
    const { prisma } = fakePrisma();
    const src = fakeSources();
    (src as unknown as { exitExecutions: () => Promise<never> }).exitExecutions = async () => {
      throw new Error('db down');
    };
    const r = await new DecisionGradingService(src, new DecisionGradeRepository(prisma as never)).gradeSession('2026-11-04', new Date(NEXT_NIGHT));
    expect(r.error).toMatch(/ai_exit_executions: db down/);
    expect(r.graded).toBe(2);
  });

  it('SELF_REVIEW_DECISION_LOOP=off ⇒ nothing written', async () => {
    process.env.SELF_REVIEW_DECISION_LOOP = 'off';
    const { store, prisma } = fakePrisma();
    const r = await new DecisionGradingService(fakeSources(), new DecisionGradeRepository(prisma as never)).gradeSession('2026-11-04', new Date(NEXT_NIGHT));
    expect(r).toMatchObject({ graded: 0, skipped: expect.stringContaining('off') });
    expect(store.size).toBe(0);
  });

  it('previousWeekday skips the weekend', () => {
    expect(previousWeekday('2026-11-02')).toBe('2026-10-30'); // Monday → Friday
    expect(previousWeekday('2026-11-04')).toBe('2026-11-03');
  });
});

describe('REENTRY (re-entry watch SIGNAL, 2026-11-05) — graded like ENTRY_TAKE', () => {
  // NIFTY SAME re-entry 10:53 IST: BUY NIFTY10NOV2624450CE @ 150, SL 112.5 (−25 %), T1 225 (+50 %), lot 75.
  const AT = Date.parse('2026-11-05T05:23:00Z');
  const plan = { tradingsymbol: 'NIFTY10NOV2624450CE', token: '41234', exchange: 'NFO', side: 'BUY', ltp: 150, limitPrice: 151, sl: 112.5, targets: [225], lotSize: 75, qty: 75, tickSize: 0.05 };
  const night = Date.parse('2026-11-05T13:15:00Z');
  const up = barsFrom(Math.floor(AT / MIN) * MIN + MIN, [...linear(150, 230, 120), ...Array(150).fill(230)]);

  it('a re-entry that ran to T1 is RIGHT (take > ₹0); before the close it is not graded', () => {
    const src = { id: 'rw1', underlying: 'NIFTY', at: new Date(AT), direction: 'SAME', tradeId: 't1', plan };
    expect(reentryDrafts(src, () => null, AT + 60 * MIN)).toEqual([]);
    const [d] = reentryDrafts(src, (ex, tok) => (ex === 'NFO' && tok === '41234' ? up : null), night);
    expect(d).toMatchObject({ decisionType: 'REENTRY', refTable: 'reentry_watch_decisions', refId: 'rw1', chosen: 'take', alternative: 'skip', mode: 'paper', horizon: 'close', verdict: 'RIGHT' });
    expect(d.pnlChosen!).toBeGreaterThan(5000);
  });

  it('a refused contract (no plan) is UNSCORABLE', () => {
    const [d] = reentryDrafts({ id: 'rw2', underlying: 'NIFTY', at: new Date(AT), direction: 'OPPOSITE', tradeId: null, plan: null }, () => null, night);
    expect(d).toMatchObject({ decisionType: 'REENTRY', verdict: 'UNSCORABLE' });
  });
});
