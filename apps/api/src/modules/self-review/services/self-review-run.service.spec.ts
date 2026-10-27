import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { TuningService } from '../tuning/tuning.service';
import { parseOption, SelfReviewRunService, minutesSinceOpenOf } from './self-review-run.service';

// Wed 2026-10-21 19:00 IST: S = 2026-10-21 (Dussehra Tue 10-20 is a holiday).
const NOW = new Date('2026-10-21T13:30:00Z');
const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

function make(o: { enabled?: boolean; diagnosis?: { diagnose: jest.Mock }; pending?: unknown[]; failScorecards?: boolean; prevRun?: unknown; mbm?: unknown[]; decided?: unknown[]; channel?: Array<Record<string, unknown>>; infos?: Array<Record<string, unknown>>; signalTrades?: { paper: unknown[]; live: unknown[] }; setups?: Array<Record<string, unknown>> } = {}) {
  const stored: Array<Record<string, unknown>> = [];
  const repo = {
    createRun: jest.fn(async (s: string) => ({ id: 'run1', sessionDate: s })),
    finishRun: jest.fn(async () => ({})),
    upsertResults: jest.fn(async (runId: string, drafts: Array<Record<string, unknown>>) => {
      for (const d of drafts) {
        const i = stored.findIndex((x) => x.kind === d.kind && x.refId === d.refId);
        if (i >= 0) stored[i] = { ...d, runId };
        else stored.push({ ...d, runId });
      }
      return drafts.length;
    }),
    results: jest.fn(async (w: { sessionDate?: string; sessions?: string[]; kinds?: string[] }) =>
      stored.filter((r) => (!w.sessionDate || r.sessionDate === w.sessionDate) && (!w.sessions || w.sessions.includes(r.sessionDate as string)) && (!w.kinds || w.kinds.includes(r.kind as string))),
    ),
    doneRunsFor: jest.fn(async () => []),
    previousDoneRun: jest.fn(async () => o.prevRun ?? null),
    setDiagnosisIfEmpty: jest.fn(async () => undefined),
    proposals: jest.fn(async () => o.pending ?? []),
    decidedProposals: jest.fn(async () => o.decided ?? []),
    overrides: jest.fn(async () => []),
    expire: jest.fn(async () => ({ count: 0 })),
    createProposal: jest.fn(async () => ({})),
  };
  const sources = {
    scorecards: jest.fn(async () => {
      if (o.failScorecards) throw new Error('db');
      return [
        {
          id: 'sc1', symbol: 'NIFTY28OCT2625000CE', underlying: 'NIFTY', side: 'BULLISH', window: 'OVERNIGHT',
          computedAt: new Date('2026-10-19T10:10:00Z'), total: 2, band: 'SUPPORTS', moveBp: -60,
          factors: [{ name: 'oi', points: 2, available: true }, { name: 'news', points: 1, available: true }],
        },
        // computed before the previous session: its outcome is not S
        { id: 'old', symbol: 'X', underlying: 'X', side: 'BULLISH', window: 'OVERNIGHT', computedAt: new Date('2026-10-14T10:10:00Z'), total: 1, band: 'SUPPORTS', moveBp: 10, factors: [] },
      ];
    }),
    nightVerdicts: jest.fn(async () => [
      { id: 'v1', trackerId: 't1', symbol: 'NIFTY28OCT2625000CE', verdict: 'HOLD_OVERNIGHT', confidence: 'high', createdAt: new Date('2026-10-19T10:15:00Z'), triggeredBy: ['OVERNIGHT_REVIEW'] },
    ]),
    trackers: jest.fn(async () => [{ id: 't1', symbol: 'NIFTY28OCT2625000CE', exchange: 'NFO', token: '123', qty: 75, status: 'OPEN', exitPrice: null, exitTime: null }]),
    bars1m: jest.fn(async () => []),
    chainLtp: jest.fn(async () => null),
    liveExits: jest.fn(async () => []),
    newsIdeas: jest.fn(async () => []),
    scorecardTotals: jest.fn(async () => []),
    articleSentiments: jest.fn(async () => new Map()),
    dailyRangeBp: jest.fn(async () => null),
    mbmPredictions: jest.fn(async () => o.mbm ?? []),
    tradeSetups: jest.fn(async (s: string) => (o.setups ?? []).filter((r) => r.sessionDate === s)),
    signalTradeOutcomes: jest.fn(async () => o.signalTrades ?? { paper: [], live: [] }),
    channelSignals: jest.fn(async (s: string) => (o.channel ?? []).filter((r) => r.sessionDate === s)),
    channelInfos: jest.fn(async (s: string) => (o.infos ?? []).filter((r) => r.sessionDate === s)),
    stockMoves: jest.fn(async (asOf: string) =>
      asOf === '2026-10-13'
        ? [
            { id: '41', symbol: 'RELIANCE', asOf: new Date('2026-10-13T00:00:00Z'), horizonDays: 5, pBig: 0.7, rankPct: 0.98, bucket: 'TOP20', resultsInWindow: false, modelId: 'm1', outcomeBig: true, outcomeRetBp: 380 },
            { id: '42', symbol: 'TCS', asOf: new Date('2026-10-13T00:00:00Z'), horizonDays: 5, pBig: 0.3, rankPct: 0.5, bucket: 'MID', resultsInWindow: false, modelId: 'm1', outcomeBig: false, outcomeRetBp: 90 },
          ]
        : [],
    ),
  };
  const tuning = new TuningService({ overrides: async () => [] });
  const svc = new SelfReviewRunService(
    repo as never,
    sources as never,
    tuning,
    { enabled: o.enabled ?? true },
    clock,
    { 'exit.openingGuardMin': 15, 'exit.persistMinSec': 120 },
    o.diagnosis as never,
  );
  return { svc, repo, sources, stored };
}

describe('SelfReviewRunService', () => {
  it('SELF_REVIEW_ENABLED=false → nothing runs', async () => {
    const { svc, repo } = make({ enabled: false });
    expect(await svc.run(NOW)).toMatchObject({ started: false });
    expect(repo.createRun).not.toHaveBeenCalled();
  });

  it('verifies S: scorecard total + factors, the overnight verdict via the underlying proxy; summary; DONE', async () => {
    const { svc, repo, stored } = make();
    const out = await svc.run(NOW);
    expect(out).toMatchObject({ started: true, runId: 'run1', session: '2026-10-21' });
    const forS = stored.filter((r) => r.sessionDate === '2026-10-21');
    expect(forS.map((r) => `${r.kind}:${r.refId}`).sort()).toEqual([
      'OVERNIGHT_VERDICT:v1', 'SCORECARD_FACTOR:sc1:news', 'SCORECARD_FACTOR:sc1:oi', 'SCORECARD_TOTAL:sc1', 'STOCK_MOVE:41', 'STOCK_MOVE:42',
    ]);
    expect(forS.find((r) => r.kind === 'SCORECARD_TOTAL')).toMatchObject({ correct: false });
    expect(forS.find((r) => r.kind === 'OVERNIGHT_VERDICT')).toMatchObject({ correct: false, details: expect.objectContaining({ proxy: 'underlying-move' }) });
    expect(stored.some((r) => r.refId === 'old')).toBe(false);
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { status: string; summary: { byKind: Record<string, unknown> } }];
    expect(finish[1].status).toBe('DONE');
    expect(finish[1].summary.byKind.SCORECARD_TOTAL).toMatchObject({ n: 1, wrong: 1 });
  });

  it('CHANNEL_SIGNAL: each scored tip is a result (subject = channel); per-channel stats in summary.byChannel; never notable', async () => {
    const row = (id: string, channelId: string, outcomeStatus: string, sessionDate = '2026-10-21') => ({
      id, sessionDate, channelId, underlying: 'NIFTY', instrumentKind: 'CE', strike: 24000, side: 'BUY', entryType: 'ABOVE',
      entryLow: 120, entryHigh: 120, sl: 100, targets: [140], horizon: 'INTRADAY', parser: 'rule', outcomeStatus,
    });
    const { svc, repo, stored } = make({
      channel: [row('a1', 'chA', 'TARGET1'), row('a2', 'chA', 'SL'), row('b1', 'chB', 'NEITHER'), row('a0', 'chA', 'TARGET1', '2026-10-19')],
    });
    await svc.run(NOW);
    const forS = stored.filter((r) => r.kind === 'CHANNEL_SIGNAL' && r.sessionDate === '2026-10-21');
    expect(forS.map((r) => `${r.refId}:${r.subject}:${r.correct}`).sort()).toEqual(['a1:chA:true', 'a2:chA:false', 'b1:chB:null']);
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: { byKind: Record<string, unknown>; byChannel: Record<string, unknown>; notable: Array<{ kind: string }> } }];
    expect(finish[1].summary.byKind.CHANNEL_SIGNAL).toMatchObject({ n: 3, right: 1, wrong: 1, nullCount: 1 });
    expect(finish[1].summary.byChannel.chA).toMatchObject({ n: 2, right: 1, wrong: 1, hitRate: 0.5, rolling20: 0.667, rolling20Right: 2, rolling20Wrong: 1 });
    expect(finish[1].summary.byChannel.chB).toMatchObject({ n: 1, right: 0, wrong: 0, hitRate: null, rolling20: null });
    expect(finish[1].summary.notable.every((x) => x.kind !== 'CHANNEL_SIGNAL')).toBe(true);
  });

  it('CHANNEL_INFO: one result per directional item (refId id:index); byChannel gets infoN / infoHitRate; never notable', async () => {
    const item = (underlying: string, bias: string | null, horizon: string | null = null) => ({
      underlying, bias, levels: [22000], targetLevel: null, condition: bias === 'BEAR' ? { driver: 'CRUDE', direction: 'UP' } : null, horizon,
    });
    const out = (status: string, ret: number | null = null) => ({ status, session: '2026-10-21', ret, band: 40, levelHit: false });
    const { svc, repo, stored } = make({
      channel: [{ id: 'a1', sessionDate: '2026-10-21', channelId: 'chA', underlying: 'NIFTY', instrumentKind: 'CE', strike: 24000, side: 'BUY', entryType: 'ABOVE', entryLow: 120, entryHigh: 120, sl: 100, targets: [140], horizon: 'INTRADAY', parser: 'rule', outcomeStatus: 'TARGET1' }],
      infos: [
        // crude BULL + NIFTY BEAR (conditional) + a NEUTRAL item (not scored) + a MONTHS view (recorded, null)
        { id: 'i1', sessionDate: '2026-10-21', channelId: 'chA', messageId: 'm1', extractor: 'rule',
          items: [item('CRUDEOIL', 'BULL'), item('NIFTY', 'BEAR'), item('BANKNIFTY', 'NEUTRAL')], outcomes: [out('WRONG', -80), out('RIGHT', -120), out('NO_BIAS')] },
        { id: 'i2', sessionDate: '2026-10-21', channelId: 'chC', messageId: 'm2', extractor: 'llm', items: [item('NIFTY', 'BEAR', 'MONTHS')], outcomes: [out('NOT_JUDGED_MONTHS')] },
      ],
    });
    await svc.run(NOW);
    const forS = stored.filter((r) => r.kind === 'CHANNEL_INFO' && r.sessionDate === '2026-10-21');
    expect(forS.map((r) => `${r.refId}:${r.subject}:${r.correct}`).sort()).toEqual(['i1:0:chA:false', 'i1:1:chA:true', 'i2:0:chC:null']);
    expect(forS.find((r) => r.refId === 'i1:1')).toMatchObject({ symbol: 'NIFTY', predicted: 'BEAR NIFTY levels 22000 if CRUDE UP (next session)' });
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: { byKind: Record<string, unknown>; byChannel: Record<string, unknown>; notable: Array<{ kind: string }> } }];
    expect(finish[1].summary.byKind.CHANNEL_INFO).toMatchObject({ n: 3, right: 1, wrong: 1, nullCount: 1 });
    expect(finish[1].summary.byChannel.chA).toMatchObject({ n: 1, right: 1, infoN: 2, infoRight: 1, infoWrong: 1, infoHitRate: 0.5 });
    expect(finish[1].summary.byChannel.chC).toMatchObject({ n: 0, infoN: 1, infoHitRate: null });
    expect(finish[1].summary.notable.every((x) => x.kind !== 'CHANNEL_INFO')).toBe(true);
  });

  it('SIGNAL_TRADES: live vs PAPER (no funds) outcomes, session S and rolling 20; absent when there are none', async () => {
    const at = (d: string) => new Date(`${d}T05:00:00Z`);
    const { svc, repo } = make({
      signalTrades: {
        paper: [
          { createdAt: at('2026-10-21'), status: 'CLOSED', pnl: 900 },
          { createdAt: at('2026-10-21'), status: 'OPEN', pnl: -100 },
          { createdAt: at('2026-10-19'), status: 'CLOSED', pnl: -400 },
        ],
        live: [{ createdAt: at('2026-10-21'), status: 'FILLED', trackerStatus: 'CLOSED', pnl: -250 }, { createdAt: at('2026-10-21'), status: 'REJECTED', trackerStatus: null, pnl: null }],
      },
    });
    await svc.run(NOW);
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: { signalTrades: any } }];
    const st = finish[1].summary.signalTrades;
    expect(st.session.paperNoFunds).toMatchObject({ n: 2, open: 1, closed: 1, wins: 1, losses: 0, pnl: 800, realised: 900 });
    expect(st.rolling20.paperNoFunds).toMatchObject({ n: 3, closed: 2, wins: 1, losses: 1, realised: 500, winRate: 0.5 });
    expect(st.session.live).toMatchObject({ n: 2, closed: 1, losses: 1, noTrade: 1, realised: -250 });
    const none = make();
    await none.svc.run(NOW);
    const f2 = none.repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: Record<string, unknown> }];
    expect(f2[1].summary.signalTrades).toBeUndefined();
  });

  it('STOCK_MOVE: rows whose 5-session horizon closes at S (scored 5 sessions earlier) are judged; MID is null; not a factor', async () => {
    const { svc, sources, stored, repo } = make();
    await svc.run(NOW);
    // S = 10-21 → back over 10-19, 10-16, 10-15, 10-14 (10-20 holiday, weekend) → as-of 10-13.
    expect(sources.stockMoves).toHaveBeenCalledWith('2026-10-13');
    const forS = stored.filter((r) => r.sessionDate === '2026-10-21' && r.kind === 'STOCK_MOVE');
    expect(forS.find((r) => r.refId === '41')).toMatchObject({ subject: 'TOP20', correct: true });
    expect(forS.find((r) => r.refId === '42')).toMatchObject({ subject: 'MID', correct: null });
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: { byKind: Record<string, unknown>; byFactor: Record<string, unknown> } }];
    expect(finish[1].summary.byKind.STOCK_MOVE).toMatchObject({ n: 2, right: 1, wrong: 0, nullCount: 1 });
    expect(Object.keys(finish[1].summary.byFactor)).not.toContain('TOP20');
  });

  it('MBM rows with a relative reading also yield MBM_RELATIVE, with its skill in the summary; not diagnosed', async () => {
    const mbm = [
      { id: 'r1', instrument: 'NIFTY', horizon: '30m', asOf: new Date('2026-10-21T05:00:00Z'), p: 0.97, regime: 'ACTIVE', outcomeBig: true, outcomeQuality: 'ok', outcomeRangeBp: 30, outcomeThresholdBp: 20, q50Bp: 32, relRatio: 1.52, relLabel: 'BUSIER', refRangeBp: 21 },
      { id: 'r2', instrument: 'NIFTY', horizon: '30m', asOf: new Date('2026-10-21T05:05:00Z'), p: 0.97, regime: 'ACTIVE', outcomeBig: true, outcomeQuality: 'ok', outcomeRangeBp: 30, outcomeThresholdBp: 20, q50Bp: 15, relRatio: 0.7, relLabel: 'QUIETER', refRangeBp: 21 },
      { id: 'r3', instrument: 'NIFTY', horizon: '30m', asOf: new Date('2026-10-21T05:10:00Z'), p: 0.97, regime: 'ACTIVE', outcomeBig: true, outcomeQuality: 'ok', outcomeRangeBp: 30, outcomeThresholdBp: 20 },
    ];
    const { svc, stored, repo, sources } = make();
    // Only S's window (IST midnight of 2026-10-21) has these rows; older sessions have none.
    (sources.mbmPredictions as jest.Mock).mockImplementation(async (from: Date) => (from.toISOString() === '2026-10-20T18:30:00.000Z' ? mbm : []));
    await svc.run(NOW);
    const rel = stored.filter((r) => r.sessionDate === '2026-10-21' && r.kind === 'MBM_RELATIVE');
    expect(rel.map((r) => [r.refId, r.correct])).toEqual([['r1', true], ['r2', false]]);
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: { byKind: Record<string, unknown>; skill: Record<string, { session: { n: number; verdict: string } }>; notable: Array<{ kind: string }> } }];
    expect(finish[1].summary.byKind.MBM_RELATIVE).toMatchObject({ n: 2, right: 1, wrong: 1 });
    expect(finish[1].summary.skill.MBM_RELATIVE.session).toMatchObject({ n: 2, verdict: 'NOT_TESTABLE' });
    expect(finish[1].summary.notable.every((x) => x.kind !== 'MBM_RELATIVE')).toBe(true);
  });

  it('is idempotent: a re-run upserts the same (kind, refId) rows', async () => {
    const { svc, stored } = make();
    await svc.run(NOW);
    const n = stored.length;
    await svc.run(NOW);
    expect(stored.length).toBe(n);
  });

  it('hands S’s misses (capped, factor/MBM excluded) to the diagnosis when bound; its failure does not fail the run', async () => {
    const diagnose = jest.fn(async () => {
      throw new Error('llm down');
    });
    const { svc, repo } = make({ diagnosis: { diagnose } });
    await svc.run(NOW);
    expect(diagnose).toHaveBeenCalledTimes(1);
    const misses = (diagnose.mock.calls[0] as unknown as [string, Array<{ kind: string }>])[1];
    expect(misses.every((m) => m.kind !== 'SCORECARD_FACTOR' && m.kind !== 'MBM_PREDICTION')).toBe(true);
    expect(misses.length).toBeGreaterThan(0);
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { status: string; error: string }];
    expect(finish[1].status).toBe('DONE');
    expect(finish[1].error).toMatch(/diagnosis/);
  });

  it('a stopped-out trade setup is diagnosed, with the news idea it came from (owner 2026-10-28)', async () => {
    const diagnose = jest.fn(async () => null);
    const idea = { headline: 'Steel prices rise', idea: 'CE_IDEA', rationale: 'margins up', invalidation: 'gap down' };
    const { svc } = make({
      diagnosis: { diagnose },
      setups: ['2026-10-19', '2026-10-20', '2026-10-21'].map((sessionDate) => ({
        id: `ts-${sessionDate}`, sessionDate, symbol: 'SAIL', side: 'LONG', instrument: 'SAIL27OCT26FUT', entryRef: 171, stopDistance: 6,
        outcomeStatus: 'STOP', outcomeR: -1, outcomeHitT1: false, outcomeEntryPrice: 171.5, outcomeExitPrice: 165,
        entryRule: 'break of the first 15m high', atr: 6, newsIdea: idea,
      })),
    });
    await svc.run(NOW);
    expect(diagnose).toHaveBeenCalledTimes(1);
    const misses = (diagnose.mock.calls[0] as unknown as [string, Array<{ kind: string; details: Record<string, unknown> }>])[1];
    const setup = misses.find((m) => m.kind === 'TRADE_SETUP');
    expect(setup?.details).toMatchObject({ newsIdea: idea, entryRule: 'break of the first 15m high', atr: 6 });
  });

  it('a failing kind costs only itself', async () => {
    const { svc, stored, repo } = make({ failScorecards: true });
    await svc.run(NOW);
    expect(stored.some((r) => r.kind === 'OVERNIGHT_VERDICT')).toBe(true);
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { status: string; error: string }];
    expect(finish[1]).toMatchObject({ status: 'DONE', error: expect.stringMatching(/SCORECARD/) });
  });

  it('expires PENDING proposals older than 14 days', async () => {
    const { svc, repo } = make({ pending: [{ id: 'p-old', key: 'k', status: 'PENDING', createdAt: new Date('2026-09-01T00:00:00Z') }] });
    await svc.run(NOW);
    expect(repo.expire).toHaveBeenCalledWith(['p-old']);
  });

  describe('mbm.packet proposal from two consecutive runs', () => {
    // 15 BIG at p 0.8 + 15 small at p 0.2: AUC 1, Brier skill > 0 → rolling-20 EDGE.
    const mbm = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`, instrument: 'NIFTY', horizon: '30m', asOf: new Date('2026-10-21T05:00:00Z'), p: i < 15 ? 0.8 : 0.2,
      regime: 'ACTIVE', outcomeBig: i < 15, outcomeQuality: 'ok', outcomeRangeBp: 30, outcomeThresholdBp: 20,
    }));
    const prev = (verdict: string) => ({ id: 'run0', sessionDate: '2026-10-19', summary: { skill: { MBM_PREDICTION: { rolling20: { n: 25, verdict, auc: 0.7, brierSkill: 0.2, hitRate: 0.8, baseRate: 0.5, majorityHitRate: 0.5 } } } } });
    const mbmDrafts = (repo: { createProposal: jest.Mock }) =>
      repo.createProposal.mock.calls.map((c) => c[0] as { target: string; currentValue: unknown; proposedValue: unknown; rationale: string }).filter((d) => d.target === 'mbm.packet');

    it('EDGE this run and the previous session’s run → PENDING false → true (never applied)', async () => {
      const { svc, repo } = make({ mbm, prevRun: prev('EDGE') });
      await svc.run(NOW);
      expect(repo.previousDoneRun).toHaveBeenCalledWith('2026-10-21');
      const d = mbmDrafts(repo);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ currentValue: false, proposedValue: true });
      expect(d[0].rationale).toContain('2026-10-21: EDGE AUC 1.00');
      expect(d[0].rationale).toContain('2026-10-19: EDGE');
      expect(svc.currentValue('mbm.packet')).toBe(false);
    });

    it('a REJECTED false → true decided after both runs’ sessions → no re-proposal (cool-down)', async () => {
      const decided = [{ id: 'p1', key: 'mbm.packet', status: 'REJECTED', currentValue: false, proposedValue: true, createdAt: new Date('2026-10-20T13:00:00Z'), decidedAt: new Date('2026-10-21T05:00:00Z') }];
      const { svc, repo } = make({ mbm, prevRun: prev('EDGE'), decided });
      await svc.run(NOW);
      expect(repo.decidedProposals).toHaveBeenCalled();
      expect(mbmDrafts(repo)).toEqual([]);
    });

    it('previous run NOT_TESTABLE, missing, or unreadable → no proposal', async () => {
      for (const prevRun of [prev('NOT_TESTABLE'), null, { id: 'r', sessionDate: '2026-10-19', summary: {} }]) {
        const { svc, repo } = make({ mbm, prevRun });
        await svc.run(NOW);
        expect(mbmDrafts(repo)).toEqual([]);
      }
      const { svc, repo } = make({ prevRun: prev('EDGE') }); // no MBM rows this run → NOT_TESTABLE
      await svc.run(NOW);
      expect(mbmDrafts(repo)).toEqual([]);
    });
  });

  it('currentValue: override, else the env-derived default, else the code default', () => {
    const { svc } = make();
    expect(svc.currentValue('exit.persistMinSec')).toBe(120);
    expect(svc.currentValue('scorecard.factor.oi.weight')).toBe(1);
    expect(svc.currentValue('scorecard.factor.news.requireConfirmation')).toBe(false);
  });
});

describe('helpers', () => {
  it('parseOption', () => {
    expect(parseOption('NIFTY28OCT2625000CE')).toEqual({ underlying: 'NIFTY', expiry: '2026-10-28', strike: 25000, type: 'CE' });
    expect(parseOption('RELIANCE-EQ')).toBeNull();
  });
  it('minutesSinceOpenOf: minutes after the exchange open, null off-session', () => {
    expect(minutesSinceOpenOf(clock, 'NFO', new Date('2026-10-21T03:52:00Z'))).toBe(7); // 09:22 IST
    expect(minutesSinceOpenOf(clock, 'NFO', new Date('2026-10-21T02:00:00Z'))).toBeNull(); // 07:30 IST
    expect(minutesSinceOpenOf(clock, 'NFO', new Date('2026-10-20T05:00:00Z'))).toBeNull(); // holiday
  });
});
