import type { EntryPlan } from '../domain/gate';
import { SignalPaperService, type PaperOpenInput } from './signal-paper.service';
import { SignalPaperWatchService } from './signal-paper-watch.service';
import { parseSignalTraderConfig } from '../domain/signal-trader.config';

const plan: EntryPlan = {
  exchange: 'NFO', token: '111', tradingsymbol: 'NIFTY28OCT2625000CE', lotSize: 75, tickSize: 0.05, side: 'BUY', ltp: 101,
  bandLow: 100, bandHigh: 103, limitPrice: 101.5, sl: 90, slSource: 'signal', targets: [120, 140], lots: 2, qty: 150, riskRupees: 1725,
};
const input: PaperOpenInput = {
  decisionId: 'dec_1', plan, signal: { underlying: 'NIFTY', instrumentKind: 'CE', strike: 25000 }, expiry: '2026-10-28',
  product: 'INTRADAY', channel: 'Alpha', what: 'BUY NIFTY 25000 CE ABOVE 100', why: 'account funds short of the entry', trigger: 'funds_check',
};

function makePaper(o: { existing?: any; instrumentId?: string | null; exec?: jest.Mock } = {}) {
  const repo = { paperTradeFor: jest.fn(async () => o.existing ?? null), recordPaper: jest.fn(async () => undefined) };
  const exec = { executeTrade: o.exec ?? jest.fn(async () => ({ id: 't1', status: 'OPEN', entryPrice: 101.52 })) };
  const trades = { findInstrumentId: jest.fn(async () => (o.instrumentId === undefined ? 'inst1' : o.instrumentId)) };
  const instruments = { upsertInstrument: jest.fn(async () => ({ id: 'inst2' })) };
  const svc = new SignalPaperService(repo as never, exec as never, trades as never, instruments as never);
  return { svc, repo, exec, trades, instruments };
}

describe('SignalPaperService', () => {
  it('opens through the standard paper path: isPaper, same entry / qty / SL / T1, tagged with the decision', async () => {
    const t = makePaper();
    expect(await t.svc.open(input)).toEqual({ ok: true, tradeId: 't1', entryPrice: 101.52, duplicate: false });
    const dto = (t.exec.executeTrade.mock.calls[0] as any[])[0];
    expect(dto).toMatchObject({
      isPaper: true, symbol: 'NIFTY28OCT2625000CE', token: '111', exchange: 'NFO', side: 'BUY', quantity: 150, price: 101.5,
      stoploss: 90, target: 120, strategy: 'TELEGRAM_SIGNAL_NO_FUNDS', source: 'telegram-signal / no-funds', positionType: 'INTRADAY',
    });
    expect(dto.entryTags).toEqual(['telegram-signal', 'no-funds', 'decision:dec_1']);
    expect(dto.entryReason).toMatch(/decision dec_1.*Alpha.*targets 120 \/ 140/s);
    expect(t.repo.recordPaper).toHaveBeenCalledWith('dec_1', expect.objectContaining({ status: 'OPEN', tradeId: 't1', trigger: 'funds_check' }));
    expect(t.instruments.upsertInstrument).not.toHaveBeenCalled();
  });

  it('idempotent per decision: an existing paper trade is returned, nothing new opened', async () => {
    const t = makePaper({ existing: { id: 't0', entryPrice: 100 } });
    expect(await t.svc.open(input)).toMatchObject({ ok: true, tradeId: 't0', duplicate: true });
    expect(t.exec.executeTrade).not.toHaveBeenCalled();
  });

  it('a derivative missing from the instruments table is added first', async () => {
    const t = makePaper({ instrumentId: null });
    await t.svc.open(input);
    expect(t.instruments.upsertInstrument).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'NIFTY28OCT2625000CE', token: '111', exchange: 'NFO', name: 'NIFTY', lotSize: 75, strike: 25000, optionType: 'CE' }));
  });

  it('the OI check is fired after the trade opens, never awaited: a hanging or throwing check cannot block or fail the open', async () => {
    const make = (record: jest.Mock) => {
      const t = makePaper();
      const svc = new SignalPaperService(t.repo as never, t.exec as never, t.trades as never, t.instruments as never, { record } as never);
      return { svc, t };
    };
    const hang = jest.fn(() => new Promise(() => undefined));
    const a = make(hang);
    expect(await a.svc.open(input)).toEqual({ ok: true, tradeId: 't1', entryPrice: 101.52, duplicate: false });
    await new Promise((r) => setImmediate(r));
    expect(hang).toHaveBeenCalledWith(expect.objectContaining({ decisionId: 'dec_1', expiry: '2026-10-28', signal: input.signal, plan }));
    const boom = jest.fn(() => { throw new Error('db down'); });
    expect(await make(boom).svc.open(input)).toMatchObject({ ok: true, tradeId: 't1' });
    await new Promise((r) => setImmediate(r));
    expect(boom).toHaveBeenCalled();
    // A duplicate open does not re-check.
    const dup = jest.fn(async () => undefined);
    const t = makePaper({ existing: { id: 't0', entryPrice: 100 } });
    await new SignalPaperService(t.repo as never, t.exec as never, t.trades as never, t.instruments as never, { record: dup } as never).open(input);
    await new Promise((r) => setImmediate(r));
    expect(dup).not.toHaveBeenCalled();
  });

  it('a paper-path failure is recorded, never thrown', async () => {
    const t = makePaper({ exec: jest.fn(async () => { throw new Error('Trade rejected: Max concurrent positions reached'); }) });
    expect(await t.svc.open(input)).toEqual({ ok: false, reason: 'Trade rejected: Max concurrent positions reached' });
    expect(t.repo.recordPaper).toHaveBeenCalledWith('dec_1', expect.objectContaining({ status: 'FAILED' }));
  });
});

describe('SignalPaperWatchService (paper SL / target exits)', () => {
  const OLD = process.env.BOOT_JOBS;
  afterAll(() => {
    process.env.BOOT_JOBS = OLD;
  });
  const row = (o: Record<string, unknown> = {}) => ({
    id: 't1', status: 'OPEN', side: 'BUY', quantity: 150, entryPrice: 101.5, exitPrice: null, stoploss: 90, target: 120, pnl: null, pnlPercent: null,
    positionType: 'INTRADAY', exitReasonTag: null, entryTags: ['decision:d1'], entryTime: null, exitTime: null, createdAt: new Date(),
    instrument: { token: '111', exchange: 'NFO', symbol: 'NIFTY28OCT2625000CE' }, ...o,
  });
  function makeWatch(ltp: number | null, rows = [row()], minutesToClose = 120, open = true) {
    const cfg = { ...parseSignalTraderConfig({ HUB_OWNER_USER_ID: 'owner' }), mode: 'live' as const };
    const repo = { openPaperTrades: jest.fn(async () => rows) };
    const exec = { closeTrade: jest.fn(async () => ({})) };
    const trades = { updateTrade: jest.fn(async () => ({})) };
    const clock = { isOpen: () => open, minutesToClose: () => minutesToClose };
    const quotes = { ltp: jest.fn(async () => ltp) };
    const svc = new SignalPaperWatchService(cfg, repo as never, exec as never, trades as never, clock, quotes);
    return { svc, repo, exec, trades, quotes };
  }

  it('SL hit → standard paper close at the observed LTP, tagged STOPPED_OUT', async () => {
    const t = makeWatch(88);
    expect(await t.svc.sweep(new Date())).toEqual({ checked: 1, exited: 1 });
    expect(t.exec.closeTrade).toHaveBeenCalledWith('t1', expect.objectContaining({ exitReasonTag: 'STOPPED_OUT', exitPrice: 88 }));
    expect(t.quotes.ltp).toHaveBeenCalledWith('owner', '111', 'NFO');
  });

  it('target hit → close at the target, HIT_TARGET', async () => {
    const t = makeWatch(125);
    await t.svc.sweep(new Date());
    expect(t.exec.closeTrade).toHaveBeenCalledWith('t1', expect.objectContaining({ exitReasonTag: 'HIT_TARGET', exitPrice: 120 }));
  });

  it('neither → mark-to-market P&L on the row, no close', async () => {
    const t = makeWatch(110);
    await t.svc.sweep(new Date());
    expect(t.exec.closeTrade).not.toHaveBeenCalled();
    expect(t.trades.updateTrade).toHaveBeenCalledWith('t1', { pnl: 1275, pnlPercent: 8.37 });
  });

  it('INTRADAY squares off near the close; a closed market is left alone', async () => {
    const t = makeWatch(110, [row()], 3);
    await t.svc.sweep(new Date());
    expect(t.exec.closeTrade).toHaveBeenCalledWith('t1', expect.objectContaining({ exitReasonTag: 'TIME_EXIT', exitPrice: 110 }));
    const closed = makeWatch(50, [row()], 120, false);
    await closed.svc.sweep(new Date());
    expect(closed.exec.closeTrade).not.toHaveBeenCalled();
    expect(closed.quotes.ltp).not.toHaveBeenCalled();
  });

  it('the cron does nothing with BOOT_JOBS=false', async () => {
    process.env.BOOT_JOBS = 'false';
    const t = makeWatch(88);
    await t.svc.tick();
    expect(t.repo.openPaperTrades).not.toHaveBeenCalled();
    process.env.BOOT_JOBS = OLD;
  });
});
