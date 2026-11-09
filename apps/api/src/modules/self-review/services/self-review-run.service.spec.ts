import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { TuningService } from '../tuning/tuning.service';
import { parseOption, SelfReviewRunService, minutesSinceOpenOf } from './self-review-run.service';

// Wed 2026-10-21 19:00 IST: S = 2026-10-21 (Dussehra Tue 10-20 is a holiday).
const NOW = new Date('2026-10-21T13:30:00Z');
const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

function make(o: { moves?: unknown[]; moveEvidence?: Record<string, unknown>; enabled?: boolean; diagnosis?: { diagnose: jest.Mock }; pending?: unknown[]; failScorecards?: boolean; prevRun?: unknown; mbm?: unknown[]; decided?: unknown[]; channel?: Array<Record<string, unknown>>; infos?: Array<Record<string, unknown>>; signalTrades?: { paper: unknown[]; live: unknown[] }; exitNoise?: unknown[]; engine?: { decisions: unknown[]; trades: unknown[] }; setups?: Array<Record<string, unknown>>; loop?: { grading?: unknown; grades?: unknown; tickets?: unknown; alert?: unknown } } = {}) {
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
    dailyMoves: jest.fn(async () => o.moves ?? []),
    moveEvidence: jest.fn(async () => new Map(Object.entries(o.moveEvidence ?? {}))),
    chainLtp: jest.fn(async () => null),
    liveExits: jest.fn(async () => []),
    newsIdeas: jest.fn(async () => []),
    scorecardTotals: jest.fn(async () => []),
    articleSentiments: jest.fn(async () => new Map()),
    dailyRangeBp: jest.fn(async () => null),
    mbmPredictions: jest.fn(async () => o.mbm ?? []),
    tradeSetups: jest.fn(async (s: string) => (o.setups ?? []).filter((r) => r.sessionDate === s)),
    signalTradeOutcomes: jest.fn(async () => o.signalTrades ?? { paper: [], live: [] }),
    exitNoiseReads: jest.fn(async () => o.exitNoise ?? []),
    engineReview: jest.fn(async () => o.engine ?? { decisions: [], trades: [] }),
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
    undefined,
    o.loop?.grading as never,
    o.loop?.grades as never,
    o.loop?.tickets as never,
    o.loop?.alert as never,
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

  it('an MCX carry is scored on the MCX session (09:00 to 23:30), not the NSE one', async () => {
    const { svc, sources } = make();
    sources.nightVerdicts.mockResolvedValue([
      { id: 'v1', trackerId: 't1', symbol: 'CRUDEOIL19NOV268500CE', verdict: 'HOLD_OVERNIGHT', confidence: 'high', createdAt: new Date('2026-10-19T18:20:00Z'), triggeredBy: ['OVERNIGHT_REVIEW'] },
    ] as never);
    sources.trackers.mockResolvedValue([{ id: 't1', symbol: 'CRUDEOIL19NOV268500CE', exchange: 'MCX', token: '999', qty: 100, status: 'OPEN', exitPrice: null, exitTime: null }] as never);
    await svc.run(new Date('2026-10-21T19:00:00Z')); // Thu 00:30 IST: S = Wed 10-21
    expect(sources.bars1m).toHaveBeenCalledWith('MCX', '999', new Date('2026-10-21T03:30:00Z'), new Date('2026-10-21T18:00:00Z'));
  });

  describe('missed moves', () => {
    const big = (symbol: string, close: number) => ({ symbol, close, prevClose: 100, atrPct: 0.02, bucket: 'TOP20', rankPct: 1, resultsInWindow: true });
    const none = { realTrade: false, paperTrade: false, setups: [], ideas: [], signals: [], articles: 0, reads: [] };

    it('reads the session and the one before it, and stores a miss with its cause', async () => {
      const { svc, sources, stored } = make({ moves: [big('DIVISLAB', 106)], moveEvidence: { DIVISLAB: { ...none, articles: 2 } } });
      await svc.run(NOW);
      expect(sources.dailyMoves).toHaveBeenCalledWith('2026-10-21', '2026-10-19');
      expect(stored.find((r) => r.kind === 'MISSED_MOVE')).toMatchObject({ refId: '2026-10-21:DIVISLAB', correct: false, subject: 'NEWS_NOT_READ' });
    });

    it('the evidence window runs from the previous close to this close', async () => {
      const { svc, sources } = make({ moves: [big('DIVISLAB', 106)] });
      await svc.run(NOW);
      expect(sources.moveEvidence).toHaveBeenCalledWith(['DIVISLAB'], '2026-10-21', new Date('2026-10-19T10:00:00Z'), new Date('2026-10-21T10:00:00Z'));
    });

    it('reach the diagnosis even when larger-scored misses of other kinds fill the list', async () => {
      const diagnose = jest.fn(async () => ({ misses: [] }));
      const { svc } = make({ diagnosis: { diagnose }, moves: [big('A', 106), big('B', 107), big('C', 108)] });
      await svc.run(NOW);
      const sent = (diagnose.mock.calls[0] as unknown as [string, Array<{ kind: string; symbol: string }>])[1];
      expect(sent.filter((m) => m.kind === 'MISSED_MOVE').map((m) => m.symbol).sort()).toEqual(['A', 'B', 'C']);
    });

    it('no stock-book rows yet means no rows and no error', async () => {
      const { svc, repo, stored } = make({ moves: [] });
      await svc.run(NOW);
      expect(stored.some((r) => r.kind === 'MISSED_MOVE')).toBe(false);
      const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { error: string | null }];
      expect(finish[1].error ?? '').not.toContain('MISSED_MOVE');
    });
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

  it('the signal paper splits by OI verdict / AI judge (with S’s trades) are handed to the diagnosis', async () => {
    const diagnose = jest.fn(async () => ({ misses: [], signalPaperAssessment: 'insufficient sample' }));
    const at = new Date('2026-10-21T05:00:00Z');
    const { svc } = make({
      diagnosis: { diagnose },
      signalTrades: {
        paper: [
          { createdAt: at, status: 'CLOSED', pnl: -2400, side: 'BUY', quantity: 100, entryPrice: 20, exitPrice: 8, oiVerdict: 'AGAINST', oiSummary: 'AGAINST (chain 2026-11-17, want bullish) open: CE +0.0% PE −22.0%', aiDecision: 'TAKE', symbol: 'CRUDEOIL17NOV265400CE' },
          { createdAt: at, status: 'CLOSED', pnl: 1200, side: 'BUY', quantity: 10, entryPrice: 100, exitPrice: 160, oiVerdict: 'AGREES', aiDecision: 'SKIP', symbol: 'X' },
        ],
        live: [],
      },
    });
    await svc.run(NOW);
    expect(diagnose).toHaveBeenCalledTimes(1);
    const ctx = (diagnose.mock.calls[0] as unknown as [string, unknown[], { signalPaper: any }])[2];
    expect(ctx.signalPaper.session.byOi.AGAINST).toMatchObject({ n: 1, closed: 1, losses: 1, gross: -1200, winRate: 0 }); // gross, not the (double-counted) booked −2400
    expect(ctx.signalPaper.rolling20.byJudge.SKIP).toMatchObject({ n: 1, wins: 1, gross: 600 });
    expect(ctx.signalPaper.sessionTrades[0]).toMatchObject({ symbol: 'CRUDEOIL17NOV265400CE', oi: 'AGAINST', judge: 'TAKE', gross: -1200, oiWhy: expect.stringMatching(/PE −22.0%/) });
  });

  it('the exit noise reads are scored into summary.exitNoise and handed to the diagnosis (observation only)', async () => {
    const diagnose = jest.fn(async () => ({ misses: [], exitNoiseAssessment: 'insufficient sample' }));
    const read = {
      source: 'signal_paper', symbol: 'SENSEX26N0574500CE', exitRule: 'AI_TRIGGER', want: 'BULLISH', verdict: 'NOISE',
      exitAt: new Date('2026-10-21T05:55:20Z'), underlyingAtExit: 74_458.33, n: 25.83, after15m: 74_560, after30m: 74_610,
      maxFavour30m: 175.67, maxAgainst30m: 13.4, followed: true, summary: 'NOISE 2–0 (want bullish) …',
    };
    const { svc, repo } = make({ diagnosis: { diagnose }, exitNoise: [read] });
    await svc.run(NOW);
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: { exitNoise?: any }; error: string | null }];
    expect(finish[1].summary.exitNoise.rolling20).toMatchObject({ reads: 1, scored: 1, noise: { scored: 1, right: 1 } });
    expect(finish[1].error ?? '').not.toMatch(/EXIT_NOISE/);
    const ctx = (diagnose.mock.calls[0] as unknown as [string, unknown[], { noiseReads: any }])[2];
    expect(ctx.noiseReads.rolling20).toMatchObject({ reads: 1, noiseRight: '1/1', realRight: '0/0' });
    expect(ctx.noiseReads.sessionReads[0]).toMatchObject({ symbol: 'SENSEX26N0574500CE', verdict: 'NOISE', score: 'RIGHT' });
  });

  it('the entry engine decisions and paper trades go into summary.engine and the diagnosis (observation only, insufficient sample under 10 closed)', async () => {
    const diagnose = jest.fn(async () => ({ misses: [], engineAssessment: 'insufficient sample' }));
    const at = new Date('2026-10-21T04:35:00Z');
    const engine = {
      decisions: [
        { at, underlying: 'CRUDEOIL', action: 'ENTER_PE', mode: 'paper', tradeId: 't1', reasons: ['news: BEARISH ✓', 'trend: BEARISH ✓', 'oi: AGREES ✓'] },
        { at, underlying: 'NIFTY', action: 'NO_TRADE', mode: 'paper', tradeId: null, reasons: ['news: NO_DATA'] },
      ],
      trades: [{ id: 't1', createdAt: at, underlying: 'CRUDEOIL', symbol: 'CRUDEOIL17NOV269650PE', status: 'CLOSED', side: 'BUY', quantity: 100, entryPrice: 250, exitPrice: 280, exitReasonTag: 'AI_EXIT' }],
    };
    const { svc, repo } = make({ diagnosis: { diagnose }, engine });
    await svc.run(NOW);
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: { engine?: any }; error: string | null }];
    expect(finish[1].summary.engine.rolling20).toMatchObject({ decisions: 2, enters: 1, trades: 1, closed: 1, wins: 1, gross: 3000 });
    const ctx = (diagnose.mock.calls[0] as unknown as [string, unknown[], { engine: any }])[2];
    expect(ctx.engine).toMatchObject({ sampleOk: false, rolling20: { enters: 1, closed: 1 } });
    expect(ctx.engine.sessionEnters[0]).toMatchObject({ underlying: 'CRUDEOIL', action: 'ENTER_PE', traded: true });
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

describe('SelfReviewRunService — learning kinds (SIGNAL_JUDGE / PAPER_EXIT / ENGINE_ENTRY)', () => {
  it('verifies them for S, hands their misses to the diagnosis beside the old kinds, and leaves the old kinds as they were', async () => {
    const diagnosis = { diagnose: jest.fn(async () => ({ misses: [] })) };
    const t = make({ diagnosis });
    const exitAt = new Date('2026-10-21T06:00:20Z');
    const T0 = Date.parse('2026-10-21T04:00:00Z');
    const bars = [
      ...Array.from({ length: 120 }, (_, k) => ({ ts: T0 + k * 60_000, open: 100, high: 105, low: 95, close: 100 })),
      ...Array.from({ length: 30 }, (_, k) => ({ ts: Date.parse('2026-10-21T06:01:00Z') + k * 60_000, open: 100, high: 100 + k, low: 99, close: 100 + k })),
    ];
    const fair = { verdict: 'WRONG', skipKind: 'RISK_CAP', capStop: 272.25, capOutcome: { stop: 272.25, result: 'TARGET', price: 340, pnl1Lot: 2403.7 }, signalStop: 240, signalStopOutcome: { stop: 240, result: 'TARGET', price: 340, pnl1Lot: 2403.7 }, method: 'underlying-1m×delta' };
    // Only S's day answers (the run re-verifies 3 sessions; rows are keyed by kind + refId).
    const onS = <T,>(rows: T[]) => jest.fn(async (from: Date) => (from.toISOString() === '2026-10-20T18:30:00.000Z' ? rows : []));
    Object.assign(t.sources, {
      signalJudgeChecks: onS([
        { decisionId: 'd1', symbol: 'NIFTY03NOV2623000CE', channelId: 'c1', aiDecision: 'SKIP', confidence: 74, reasons: ['Risk busts the cap'], fairRaw: fair, oldCorrect: false, exitTag: 'MOVED_STOP', paperPnl: 2939.74, promptVersion: 'signal-judge-v4' },
        { decisionId: 'd2', symbol: 'X', channelId: 'c1', aiDecision: 'SKIP', confidence: 70, reasons: ['r'], fairRaw: null, oldCorrect: false, exitTag: 'HIT_TARGET', paperPnl: 10, promptVersion: null },
      ]),
      paperExits: onS([
        { tradeId: 'p1', symbol: 'NIFTY03NOV2623000CE', underlying: 'NIFTY', exchange: 'NFO', token: '1', exitRule: 'AI_EXIT', exitAt, side: 'BUY', entryPrice: 300, exitPrice: 290, qty: 65, reason: 'AI exit', read: null, held: null },
      ]),
      underlyingRefOf: jest.fn(async () => ({ exchange: 'NSE', token: '99926000', symbol: 'NIFTY' })),
      minuteBarsHL: jest.fn(async () => bars),
      engineClosedTrades: onS([{ id: 'e1', symbol: 'NIFTYCE', underlying: 'NIFTY', side: 'BUY', quantity: 65, entryPrice: 100, exitPrice: 90, exitReasonTag: 'STOPPED_OUT', reasons: [] }]),
    });
    await t.svc.run(NOW);
    const forS = t.stored.filter((r) => r.sessionDate === '2026-10-21');
    expect(forS.find((r) => r.kind === 'SIGNAL_JUDGE' && r.refId === 'd1')).toMatchObject({ correct: false, score: 2403.7 });
    expect(forS.find((r) => r.kind === 'SIGNAL_JUDGE' && r.refId === 'd2')).toMatchObject({ correct: null });
    expect(forS.find((r) => r.kind === 'PAPER_EXIT')).toMatchObject({ refId: 'p1', correct: false, details: expect.objectContaining({ favourN: 2.9 }) });
    expect(forS.find((r) => r.kind === 'ENGINE_ENTRY')).toMatchObject({ correct: false, score: -650 });
    // the old kinds' rows are exactly as before
    expect(forS.filter((r) => !['SIGNAL_JUDGE', 'PAPER_EXIT', 'ENGINE_ENTRY'].includes(r.kind as string)).map((r) => `${r.kind}:${r.refId}`).sort()).toEqual([
      'OVERNIGHT_VERDICT:v1', 'SCORECARD_FACTOR:sc1:news', 'SCORECARD_FACTOR:sc1:oi', 'SCORECARD_TOTAL:sc1', 'STOCK_MOVE:41', 'STOCK_MOVE:42',
    ]);
    const sent = (diagnosis.diagnose.mock.calls[0] as unknown[])[1] as Array<{ kind: string }>;
    expect(sent.map((m) => m.kind).sort()).toEqual(['ENGINE_ENTRY', 'OVERNIGHT_VERDICT', 'PAPER_EXIT', 'SCORECARD_TOTAL', 'SIGNAL_JUDGE']);
    const finish = t.repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: { byKind: Record<string, unknown> } }];
    expect(finish[1].summary.byKind).toMatchObject({ SIGNAL_JUDGE: { n: 2, wrong: 1, nullCount: 1 }, PAPER_EXIT: { n: 1, wrong: 1 }, ENGINE_ENTRY: { n: 1, wrong: 1 } });
  });
});

describe('SelfReviewRunService — wrong-decision loop (2026-11-04)', () => {
  const wrongRow = (id: string, over: Record<string, unknown> = {}) => ({
    id, sessionDate: '2026-10-21', decisionType: 'ENTRY_BLOCKED', detector: null, symbol: 'NIFTY', mode: 'live', chosen: 'blocked', alternative: 'take',
    pnlChosen: 0, pnlAlternative: 6000, deltaRupees: 6000, horizon: 'close', verdict: 'WRONG', reason: 'risk_manager block', ...over,
  });
  const ticket = { title: 'Paper trades counted against the live limit', proposedChange: 'count live only', files: ['apps/api/src/modules/risk-manager/risk.service.ts'], testDescription: 'paper does not block live' };
  afterEach(() => {
    delete process.env.SELF_REVIEW_DECISION_LOOP;
  });

  it('grades S first, hands WRONG/DETECTOR rows to the diagnosis as DECISION:<type>, writes the ticket and the summary line', async () => {
    const grading = { gradeSession: jest.fn(async () => ({ graded: 14, wrong: 2, unscorable: 1, byType: { EXIT: 9, ENTRY_BLOCKED: 5 } })) };
    const grades = { wrongSince: jest.fn(async () => [wrongRow('g1'), wrongRow('g0', { sessionDate: '2026-10-19', verdict: 'RIGHT' }), wrongRow('d1', { decisionType: 'DETECTOR', detector: 'LIVE_NOT_PLACED', deltaRupees: null, verdict: 'WRONG' })]) };
    const tickets = { upsert: jest.fn(async (d: { key: string; title: string }) => ({ key: d.key, title: d.title, occurrences: 1, status: 'OPEN' })) };
    const alert = jest.fn(async () => true);
    const diagnose = jest.fn(async () => ({ misses: [{ refIds: ['dg:g1'], cause: 'paper counted', category: 'OTHER', causeType: 'CODE_BUG', ticket }] }));
    const { svc, repo } = make({ diagnosis: { diagnose }, loop: { grading, grades, tickets, alert } });
    await svc.run(NOW);
    expect(grading.gradeSession).toHaveBeenCalledWith('2026-10-21', NOW);
    // 10 sessions back from S (20 closed sessions are known; the 10th newest is the window's start).
    expect((grades.wrongSince.mock.calls[0] as unknown as [string])[0] < '2026-10-21').toBe(true);
    const misses = (diagnose.mock.calls[0] as unknown as [string, Array<{ kind: string; refId: string; score: number | null }>])[1];
    expect(misses.filter((m) => m.kind.startsWith('DECISION:')).map((m) => `${m.kind}:${m.refId}`)).toEqual(['DECISION:DETECTOR:dg:d1', 'DECISION:ENTRY_BLOCKED:dg:g1']);
    expect(tickets.upsert).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: { decisions: Record<string, unknown> & { items: Array<Record<string, unknown>> } } }];
    const dec = finish[1].summary.decisions;
    expect(dec).toMatchObject({ session: '2026-10-21', graded: 14, wrong: 2, unscorable: 1, tickets: [{ title: ticket.title, status: 'OPEN' }] });
    expect(dec.reason).toBeUndefined();
    expect(dec.items.find((i) => i.refId === 'dg:g1')).toMatchObject({ causeType: 'CODE_BUG', action: `ticket ${ticket.title}` });
  });

  it('a failed AI analysis records the real reason on the run and alerts', async () => {
    const grading = { gradeSession: jest.fn(async () => ({ graded: 3, wrong: 0, unscorable: 0, byType: {} })) };
    const alert = jest.fn(async () => true);
    const diagnose = jest.fn(async () => {
      throw new Error('LLM call failed: usage limit reached');
    });
    const { svc, repo } = make({ diagnosis: { diagnose }, loop: { grading, grades: { wrongSince: async () => [] }, alert } });
    await svc.run(NOW);
    expect(alert).toHaveBeenCalledWith('SELF_REVIEW_DIAGNOSIS_FAILED', expect.stringContaining('usage limit reached'));
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { status: string; error: string }];
    expect(finish[1].status).toBe('DONE');
    expect(finish[1].error).toContain('usage limit reached');
  });

  it('nothing graded on a trading day alerts', async () => {
    const grading = { gradeSession: jest.fn(async () => ({ graded: 0, wrong: 0, unscorable: 0, byType: {} })) };
    const alert = jest.fn(async () => true);
    const { svc, repo } = make({ loop: { grading, grades: { wrongSince: async () => [] }, alert } });
    await svc.run(NOW);
    expect(alert).toHaveBeenCalledWith('SELF_REVIEW_NOTHING_GRADED', expect.stringContaining('0 decisions graded'));
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: { decisions: { graded: number; reason: string } } }];
    expect(finish[1].summary.decisions).toMatchObject({ graded: 0, reason: expect.stringContaining('trading day') });
  });

  it('the 00:30 run still counts as the session that just ended, so nothing graded alerts', async () => {
    const grading = { gradeSession: jest.fn(async () => ({ graded: 0, wrong: 0, unscorable: 0, byType: {} })) };
    const alert = jest.fn(async () => true);
    const { svc } = make({ loop: { grading, grades: { wrongSince: async () => [] }, alert } });
    await svc.run(new Date('2026-10-21T19:00:00Z')); // Thu 00:30 IST: S = Wed 10-21
    expect(alert).toHaveBeenCalledWith('SELF_REVIEW_NOTHING_GRADED', expect.stringContaining('2026-10-21'));
  });

  it('the 09:00 catch-up re-reads the last session without alerting', async () => {
    const grading = { gradeSession: jest.fn(async () => ({ graded: 0, wrong: 0, unscorable: 0, byType: {} })) };
    const alert = jest.fn(async () => true);
    const { svc } = make({ loop: { grading, grades: { wrongSince: async () => [] }, alert } });
    await svc.run(new Date('2026-10-22T03:30:00Z')); // Thu 09:00 IST, before that day's close: S = Wed 10-21
    expect(alert).not.toHaveBeenCalled();
  });

  it('a weekend run re-reads the last session without alerting; the reason says why', async () => {
    const grading = { gradeSession: jest.fn(async () => ({ graded: 0, wrong: 0, unscorable: 0, byType: {} })) };
    const alert = jest.fn(async () => true);
    const { svc, repo } = make({ loop: { grading, alert } });
    await svc.run(new Date('2026-10-24T13:30:00Z')); // Sat 19:00 IST → S = Fri 10-23
    expect(alert).not.toHaveBeenCalled();
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: { decisions: { session: string; reason: string } } }];
    expect(finish[1].summary.decisions).toMatchObject({ session: '2026-10-23', reason: expect.stringContaining('weekend') });
  });

  it('a throwing grader or ledger costs only the loop step', async () => {
    const grading = { gradeSession: jest.fn(async () => { throw new Error('boom'); }) };
    const grades = { wrongSince: jest.fn(async () => { throw new Error('no table'); }) };
    const alert = jest.fn(async () => true);
    const { svc, repo } = make({ loop: { grading, grades, alert } });
    expect(await svc.run(NOW)).toMatchObject({ started: true, runId: 'run1' });
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { status: string; error: string }];
    expect(finish[1].status).toBe('DONE');
    expect(finish[1].error).toMatch(/decision grading: boom.*decision ledger: no table/);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('SELF_REVIEW_DECISION_LOOP=off ⇒ no grading, no ledger, no alert, no decisions block', async () => {
    process.env.SELF_REVIEW_DECISION_LOOP = 'off';
    const grading = { gradeSession: jest.fn() };
    const alert = jest.fn();
    const { svc, repo } = make({ loop: { grading, alert } });
    await svc.run(NOW);
    expect(grading.gradeSession).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: Record<string, unknown> }];
    expect(finish[1].summary.decisions).toBeUndefined();
  });
});
