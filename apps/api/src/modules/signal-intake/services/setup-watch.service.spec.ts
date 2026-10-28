import { SetupWatchService } from './setup-watch.service';
import type { SetupForWatch } from '../domain/setup-watch';

const setup: SetupForWatch = {
  id: 'ts1',
  sessionDate: '2026-10-28',
  symbol: 'CIPLA',
  instrumentKind: 'FUTURES',
  instrument: 'CIPLA23NOV26FUT (NFO futures, near month)',
  exchange: 'NFO',
  instrumentToken: '123',
  expiry: '2026-11-23',
  side: 'LONG',
  entryRule: 'break of the first 15-min high',
  stop: 1320,
  target1: 1390,
  target2: 1420,
};

function make(ltp: number) {
  const repo = { setupsToWatch: jest.fn().mockResolvedValue([setup]), createSignal: jest.fn().mockResolvedValue('sig1') };
  const clock = { isOpen: jest.fn().mockReturnValue(true), nextOpen: jest.fn(), tradingWindow: jest.fn() };
  const feeds = {
    fetchCandles: jest.fn().mockResolvedValue([{ timestamp: new Date('2026-10-28T09:15:00+05:30'), high: 1355, low: 1342 }]),
    fetchQuote: jest.fn().mockResolvedValue({ ltp }),
  };
  const emitter = { emit: jest.fn() };
  const svc = new SetupWatchService(repo as never, clock, feeds as never, emitter);
  return { svc, repo, feeds, emitter };
}

describe('SetupWatchService', () => {
  const prev = process.env.HUB_OWNER_USER_ID;
  beforeAll(() => (process.env.HUB_OWNER_USER_ID = 'owner'));
  afterAll(() => (process.env.HUB_OWNER_USER_ID = prev));

  it('a break of the range high creates the call and emits signal.ready', async () => {
    const t = make(1356);
    const r = await t.svc.poll(new Date('2026-10-28T09:40:00+05:30'));
    expect(r).toEqual({ checked: 1, fired: 1 });
    expect(t.repo.setupsToWatch).toHaveBeenCalledWith('owner', '2026-10-28');
    expect(t.repo.createSignal).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'setup:ts1', entryType: 'ABOVE', entryLow: 1355 }));
    expect(t.emitter.emit).toHaveBeenCalledWith('signal.ready', { signalId: 'sig1', clusterId: null, agreeCount: 1, conflict: false });
  });

  it('inside the range: nothing fires, and the range is fetched once', async () => {
    const t = make(1350);
    await t.svc.poll(new Date('2026-10-28T09:40:00+05:30'));
    await t.svc.poll(new Date('2026-10-28T09:40:30+05:30'));
    expect(t.repo.createSignal).not.toHaveBeenCalled();
    expect(t.feeds.fetchCandles).toHaveBeenCalledTimes(1);
  });

  it('before 09:30 and from 13:00 IST it does nothing', async () => {
    const t = make(1400);
    expect(await t.svc.poll(new Date('2026-10-28T09:29:00+05:30'))).toEqual({ checked: 0, fired: 0 });
    expect(await t.svc.poll(new Date('2026-10-28T13:00:00+05:30'))).toEqual({ checked: 0, fired: 0 });
    expect(t.repo.setupsToWatch).not.toHaveBeenCalled();
  });
});
