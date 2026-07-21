import { TelegramTrackerService } from './telegram-tracker.service';

function deps() {
  const signal = {
    id: 's1', status: 'PENDING', token: '111', exchange: 'NSE', instrument: 'EQUITY', side: 'LONG',
    signalType: 'LEVELED', entryLow: 100, entryHigh: 100, entryMode: 'NEAR',
    stopLoss: 95, slMode: 'NUMERIC', targets: [110], entryPrice: null, horizon: 'INTRADAY',
    createdAt: new Date('2026-07-20T04:00:00Z'), trackExpiresAt: new Date('2026-07-20T10:00:00Z'),
  };
  const repo = {
    findSignal: jest.fn().mockResolvedValue(signal),
    transition: jest.fn().mockResolvedValue(undefined),
    addEvent: jest.fn().mockResolvedValue(undefined),
    findActiveSignals: jest.fn().mockResolvedValue([signal]),
  } as any;
  const instruments = { getByToken: jest.fn().mockResolvedValue({ id: 'inst1' }) } as any;
  const marketRepo = { getCandles: jest.fn().mockResolvedValue([
    { high: 101, low: 99, close: 100, timestamp: new Date('2026-07-20T05:00:00Z') },
    { high: 112, low: 108, close: 110, timestamp: new Date('2026-07-20T06:00:00Z') },
  ]) } as any;
  const options = { getLiveOptionLtp: jest.fn() } as any;
  const gateway = { emit: jest.fn() } as any;
  const config = { get: jest.fn((k) => k.includes('swing') ? { winPct: 8, lossPct: 5 } : { winPct: 3, lossPct: 2 }) } as any;
  return { repo, instruments, marketRepo, options, gateway, config,
    svc: new TelegramTrackerService(repo, instruments, marketRepo, options, gateway, config) };
}

it('resolves a leveled equity signal to TARGET_HIT', async () => {
  const d = deps();
  await d.svc.evaluateOne('s1');
  expect(d.repo.transition).toHaveBeenCalledWith('s1',
    expect.objectContaining({ status: 'TARGET_HIT' }));
  expect(d.repo.addEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'TARGET_HIT' }));
  expect(d.gateway.emit).toHaveBeenCalledWith('signal-update',
    expect.objectContaining({ id: 's1', status: 'TARGET_HIT' }));
});

it('marks an option with no live premium and a past window UNTRACKABLE', async () => {
  const d = deps();
  d.repo.findSignal.mockResolvedValue({
    id: 's2', status: 'PENDING', instrument: 'OPTION', symbol: 'CRUDEOIL', strike: 9500,
    optionType: 'CE', side: 'LONG', signalType: 'LEVELED', entryLow: 225, entryHigh: 225,
    entryMode: 'NEAR', stopLoss: null, slMode: 'PREMIUM_PAID', targets: [240], entryPrice: null,
    horizon: 'INTRADAY', expiry: new Date('2026-07-19T00:00:00Z'),
    createdAt: new Date('2026-07-18T04:00:00Z'), trackExpiresAt: new Date('2026-07-18T10:00:00Z'),
  });
  await d.svc.evaluateOne('s2');
  expect(d.repo.transition).toHaveBeenCalledWith('s2',
    expect.objectContaining({ status: 'UNTRACKABLE' }));
});

it('does nothing for a signal already in a terminal state', async () => {
  const d = deps();
  d.repo.findSignal.mockResolvedValue({ id: 's3', status: 'TARGET_HIT' });
  await d.svc.evaluateOne('s3');
  expect(d.repo.transition).not.toHaveBeenCalled();
});
