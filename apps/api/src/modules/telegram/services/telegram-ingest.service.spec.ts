import { TelegramIngestService } from './telegram-ingest.service';

function deps() {
  const repo = {
    upsertChannel: jest.fn().mockResolvedValue({ id: 'ch1' }),
    insertMessage: jest.fn().mockResolvedValue({ id: 'm1' }),
    insertSignal: jest.fn().mockResolvedValue({ id: 's1' }),
    advanceLastSeen: jest.fn().mockResolvedValue(undefined),
    addEvent: jest.fn().mockResolvedValue(undefined),
  } as any;
  const queue = { add: jest.fn().mockResolvedValue(undefined) } as any;
  const instruments = { search: jest.fn().mockResolvedValue([{ symbol: 'X', token: '111', exchange: 'NSE' }]) } as any;
  const options = { getLiveOptionLtp: jest.fn() } as any;
  // Key-aware: swingTrackDays → 10, everything else (e.g. minConfidence) → undefined
  // so the service falls back to its own defaults.
  const config = { get: jest.fn((key: string) => (key === 'telegram.swingTrackDays' ? 10 : undefined)) } as any;
  return {
    repo, queue, instruments, options, config,
    svc: new TelegramIngestService(repo, queue, instruments, options, config),
  };
}

const base = {
  channel: { tgChannelId: '-100', title: 'Mr P' },
  message: { tgMessageId: 5, rawText: 'BUY X', postedAt: '2026-07-20T04:00:00.000Z' },
};

it('skips duplicates (insertMessage null → no signal, no enqueue)', async () => {
  const d = deps();
  d.repo.insertMessage.mockResolvedValue(null);
  const res = await d.svc.ingest({ ...base, parsed: { isSignal: true, symbol: 'X' } } as any);
  expect(res.messageId).toBeNull();
  expect(d.repo.insertSignal).not.toHaveBeenCalled();
  expect(d.queue.add).not.toHaveBeenCalled();
});

it('stores non-signals but creates no signal', async () => {
  const d = deps();
  const res = await d.svc.ingest({ ...base, parsed: { isSignal: false } } as any);
  expect(res.messageId).toBe('m1');
  expect(res.signalId).toBeNull();
  expect(d.repo.insertSignal).not.toHaveBeenCalled();
});

it('creates a tracked signal and enqueues when resolvable', async () => {
  const d = deps();
  const res = await d.svc.ingest({ ...base, parsed: {
    isSignal: true, symbol: 'X', instrument: 'EQUITY', side: 'LONG', signalType: 'LEVELED',
    entryMode: 'ZONE', entryLow: 100, entryHigh: 102, slMode: 'NUMERIC', stopLoss: 95,
    targets: [110], horizon: 'INTRADAY', confidence: 0.8,
  } } as any);
  expect(res.signalId).toBe('s1');
  expect(d.queue.add).toHaveBeenCalledWith('track', { signalId: 's1' });
});
