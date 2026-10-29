import { SignalPaperWatchService } from './signal-paper-watch.service';

const NOW = new Date('2026-10-28T09:56:00Z'); // 15:26 IST, 4 min to the NSE close

function make(trade: Record<string, unknown>, judge: unknown) {
  const repo = {
    openPaperTrades: jest.fn(async () => [trade]),
    decisionJudge: jest.fn(async () => judge),
    recordAiCheck: jest.fn(async () => undefined),
  };
  const exec = { closeTrade: jest.fn(async () => undefined) };
  const trades = { updateTrade: jest.fn(async () => undefined) };
  const clock = { isOpen: () => true, minutesToClose: () => 4 };
  const quotes = { ltp: jest.fn(async () => 112) };
  const cfg = { mode: 'paper', ownerUserId: 'owner' } as any;
  const svc = new SignalPaperWatchService(cfg, repo as any, exec as any, trades as any, clock, quotes);
  return { svc, repo, exec };
}

const trade = (tags: string[]) => ({
  id: 't1', status: 'OPEN', side: 'BUY', quantity: 75, entryPrice: 100, stoploss: null, target: 130, positionType: 'INTRADAY',
  entryTags: tags, entryTime: new Date('2026-10-28T05:00:00Z'), createdAt: new Date('2026-10-28T05:00:00Z'),
  instrument: { token: '1', exchange: 'NFO', symbol: 'NIFTYCE' },
});

describe('SignalPaperWatchService — learning mode AI check', () => {
  beforeAll(() => (process.env.BOOT_JOBS = 'on'));

  it('a closed learning trade is scored against the judge: SKIP and +12% → the AI was wrong', async () => {
    const t = make(trade(['telegram-signal', 'decision:d1', 'learn']), { verdict: 'SKIP', aiDecision: 'SKIP' });
    await t.svc.sweep(NOW);
    expect(t.exec.closeTrade).toHaveBeenCalledWith('t1', expect.objectContaining({ exitReasonTag: 'TIME_EXIT', exitPrice: 112 }));
    expect(t.repo.recordAiCheck).toHaveBeenCalledWith('d1', expect.objectContaining({ aiDecision: 'SKIP', movePct: 12, pnl: 900, correct: false }));
  });

  it('a normal paper trade is not scored', async () => {
    const t = make(trade(['telegram-signal', 'decision:d2']), { verdict: 'TAKE' });
    await t.svc.sweep(NOW);
    expect(t.exec.closeTrade).toHaveBeenCalled();
    expect(t.repo.recordAiCheck).not.toHaveBeenCalled();
  });
});

describe('SignalPaperWatchService — paper exit shadow (recorded, never acted on)', () => {
  beforeAll(() => (process.env.BOOT_JOBS = 'on'));

  function shadowed(o: { ltps: number[]; minutesToClose?: () => number; stoploss?: number | null; rows?: unknown[] }) {
    const t = trade(['telegram-signal', 'decision:d1', 'learn']);
    (t as any).stoploss = o.stoploss ?? null;
    const repo = {
      openPaperTrades: jest.fn(async () => [t]),
      decisionJudge: jest.fn(async () => ({ aiDecision: 'TAKE' })),
      recordAiCheck: jest.fn(async () => undefined),
      decisionPlan: jest.fn(async () => ({ sl: 90 })),
      shadowRows: jest.fn(async () => o.rows ?? []),
      saveShadowHit: jest.fn(async () => undefined),
      saveShadowTrack: jest.fn(async () => undefined),
      settleShadows: jest.fn(async (_id: string, s: { heldPnl: number; rulePnl: (p: number) => number }) => [{ rule: 'STOP', at: '2026-10-28T05:12:00Z', rulePnl: s.rulePnl(89) }]),
    };
    const exec = { closeTrade: jest.fn(async () => undefined) };
    const trades = { updateTrade: jest.fn(async () => undefined) };
    const ltps = [...o.ltps];
    const quotes = { ltp: jest.fn(async () => ltps.shift() ?? null) };
    const clock = { isOpen: () => true, minutesToClose: o.minutesToClose ?? (() => 200) };
    const bars = { minuteBars: jest.fn(async () => []) };
    const svc = new SignalPaperWatchService({ mode: 'paper', ownerUserId: 'owner' } as any, repo as any, exec as any, trades as any, clock, quotes, bars);
    return { svc, repo, exec };
  }

  it('a crossed reference stop is recorded once and the paper trade stays open', async () => {
    const s = shadowed({ ltps: [95, 89, 85] });
    await s.svc.sweep(NOW);
    await s.svc.sweep(NOW);
    await s.svc.sweep(NOW);
    expect(s.repo.saveShadowHit).toHaveBeenCalledTimes(1);
    expect(s.repo.saveShadowHit).toHaveBeenCalledWith('t1', 'd1', 'STOP', expect.objectContaining({ price: 89 }), expect.objectContaining({ baseline: 'learn', refSl: 90 }));
    expect(s.exec.closeTrade).not.toHaveBeenCalled();
  });

  it('at the real exit the shadows are settled and the line goes on the exit notes', async () => {
    const s = shadowed({ ltps: [112], minutesToClose: () => 4 });
    await s.svc.sweep(NOW);
    expect(s.repo.settleShadows).toHaveBeenCalledWith('t1', expect.objectContaining({ heldPnl: 900 }));
    expect(s.exec.closeTrade).toHaveBeenCalledWith('t1', expect.objectContaining({ exitPrice: 112, exitNotes: expect.stringContaining('shadow: stop 10:42 −₹825 · held +₹900') }));
  });

  it('a trade with a real stop is not STOP-shadowed (that is its real exit)', async () => {
    const s = shadowed({ ltps: [89], stoploss: 90 });
    await s.svc.sweep(NOW);
    // The plan IS read now (target trailing reads its targets), but no reference stop is shadowed.
    expect(s.repo.saveShadowHit).not.toHaveBeenCalled();
    expect(s.repo.saveShadowTrack).toHaveBeenCalledWith('t1', 'd1', expect.objectContaining({ baseline: 'stop', refSl: null }));
  });

  it('after a restart a rule already recorded is not recorded again', async () => {
    const s = shadowed({ ltps: [85], rows: [{ tradeId: 't1', rule: 'STOP', wouldExitAt: new Date('2026-10-28T05:12:00Z'), price: 89, detail: null }] });
    await s.svc.sweep(NOW);
    expect(s.repo.saveShadowHit).not.toHaveBeenCalled();
  });

  it('PAPER_EXIT_SHADOW=off: nothing is stepped', async () => {
    process.env.PAPER_EXIT_SHADOW = 'off';
    try {
      const s = shadowed({ ltps: [85] });
      await s.svc.sweep(NOW);
      expect(s.repo.shadowRows).not.toHaveBeenCalled();
    } finally {
      delete process.env.PAPER_EXIT_SHADOW;
    }
  });
});

describe('SignalPaperWatchService — target trailing (owner 2026-10-29)', () => {
  beforeAll(() => (process.env.BOOT_JOBS = 'on'));

  function trailing(ltps: number[]) {
    const t = { ...trade(['telegram-signal', 'decision:d1', 'learn']), target: 110 };
    const repo = {
      openPaperTrades: jest.fn(async () => [t]),
      decisionJudge: jest.fn(async () => ({ aiDecision: 'TAKE' })),
      recordAiCheck: jest.fn(async () => undefined),
      decisionPlan: jest.fn(async () => ({ sl: 90, targets: [110, 120, 130] })),
      setPaperTrail: jest.fn(async () => undefined),
      shadowRows: jest.fn(async () => []),
      saveShadowHit: jest.fn(async () => undefined),
      saveShadowTrack: jest.fn(async () => undefined),
      settleShadows: jest.fn(async () => []),
    };
    const exec = { closeTrade: jest.fn(async () => undefined) };
    const trades = { updateTrade: jest.fn(async () => undefined) };
    const queue = [...ltps];
    const quotes = { ltp: jest.fn(async () => queue.shift() ?? null) };
    const svc = new SignalPaperWatchService({ mode: 'paper', ownerUserId: 'owner' } as any, repo as any, exec as any, trades as any, { isOpen: () => true, minutesToClose: () => 200 }, quotes);
    return { svc, repo, exec, trades, t };
  }

  it('T1 moves the SL to entry and the target to T2 on the row; the trade stays open', async () => {
    const s = trailing([111]);
    await s.svc.sweep(NOW);
    expect(s.repo.setPaperTrail).toHaveBeenCalledWith('t1', 100, 120);
    expect(s.exec.closeTrade).not.toHaveBeenCalled();
  });

  it('T1, T2, then a pullback to T1 closes at the trailed SL as MOVED_STOP', async () => {
    const s = trailing([111, 121, 109]);
    await s.svc.sweep(NOW);
    await s.svc.sweep(NOW);
    expect(s.repo.setPaperTrail).toHaveBeenCalledWith('t1', 110, 130);
    await s.svc.sweep(NOW);
    expect(s.exec.closeTrade).toHaveBeenCalledWith('t1', expect.objectContaining({ exitReasonTag: 'MOVED_STOP', exitPrice: 109 }));
  });
});

describe('SignalPaperWatchService — AI close + HELD follow (owner 2026-10-29)', () => {
  beforeAll(() => (process.env.BOOT_JOBS = 'on'));

  function closing(ltps: number[], follow: Record<string, unknown> | null = null) {
    const t = { ...trade(['telegram-signal', 'decision:d1']), stoploss: 90, target: 110 };
    const repo = {
      openPaperTrades: jest.fn(async () => []),
      openPaperTrade: jest.fn(async () => t),
      decisionJudge: jest.fn(async () => null),
      recordAiCheck: jest.fn(async () => undefined),
      decisionPlan: jest.fn(async () => ({ sl: 90, targets: [110, 120] })),
      shadowRows: jest.fn(async () => []),
      saveShadowHit: jest.fn(async () => undefined),
      saveShadowTrack: jest.fn(async () => undefined),
      settleShadows: jest.fn(async () => [{ rule: 'AI_EXIT', at: '2026-10-28T06:04:05Z', rulePnl: -600 }]),
      startHeldFollow: jest.fn(async () => undefined),
      followingHeld: jest.fn(async () => (follow ? [{ id: 'h1', tradeId: 't1', heldPnl: -600, detail: follow }] : [])),
      updateHeld: jest.fn(async () => undefined),
    };
    const exec = { closeTrade: jest.fn(async () => undefined) };
    const queue = [...ltps];
    const quotes = { ltp: jest.fn(async () => queue.shift() ?? null) };
    const svc = new SignalPaperWatchService({ mode: 'paper', ownerUserId: 'owner' } as any, repo as any, exec as any, { updateTrade: jest.fn() } as any, { isOpen: () => true, minutesToClose: () => 200 }, quotes);
    return { svc, repo, exec };
  }

  it('closes the paper trade at the AI price with the reason and shadow on the notes, then starts the HELD follow', async () => {
    const s = closing([]);
    await s.svc.closeByAi({ tradeId: 't1', rule: 'AI_EXIT', price: 92, reason: 'AI EXIT_NOW (PASS: THESIS_BROKEN)', at: new Date('2026-10-28T06:04:05Z') });
    expect(s.exec.closeTrade).toHaveBeenCalledWith('t1', expect.objectContaining({ exitReasonTag: 'AI_EXIT', exitPrice: 92 }));
    const notes = (s.exec.closeTrade.mock.calls[0] as any)[1].exitNotes as string;
    expect(notes).toContain('AI exit: AI EXIT_NOW (PASS: THESIS_BROKEN)');
    expect(notes).toContain('shadow:');
    expect(notes).toContain('night review');
    expect(s.repo.startHeldFollow).toHaveBeenCalledWith('t1', 'd1', -600, expect.objectContaining({ sl: 90, target: 110, targets: [110, 120], ai: expect.objectContaining({ price: 92 }) }));
  });

  it('a trade that closed meanwhile on its own rules is left alone', async () => {
    const s = closing([]);
    s.repo.openPaperTrade.mockResolvedValue(null as never);
    await s.svc.closeByAi({ tradeId: 't1', rule: 'AI_EXIT', price: 92, reason: 'x', at: new Date() });
    expect(s.exec.closeTrade).not.toHaveBeenCalled();
  });

  it('the HELD follow trails on its own rules and settles held vs AI when they would have exited', async () => {
    const follow = {
      side: 'BUY', entry: 100, qty: 75, sl: 90, target: 110, targets: [110, 120], product: 'INTRADAY', tags: [],
      entryTime: '2026-10-28T05:00:00Z', token: '1', exchange: 'NFO', symbol: 'NIFTYCE', expiry: null, ai: { rule: 'AI_EXIT', price: 92, at: '2026-10-28T06:04:05Z' },
    };
    const s = closing([111], follow);
    await s.svc.sweep(NOW);
    expect(s.repo.updateHeld).toHaveBeenCalledWith('h1', { detail: expect.objectContaining({ sl: 100, target: 120 }) });

    const s2 = closing([121], { ...follow, sl: 100, target: 120 });
    await s2.svc.sweep(NOW);
    expect(s2.repo.updateHeld).toHaveBeenCalledWith('h1', expect.objectContaining({ done: expect.objectContaining({ price: 120, rulePnl: 1500, saved: 2100 }) }));
  });
});
