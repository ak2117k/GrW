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
