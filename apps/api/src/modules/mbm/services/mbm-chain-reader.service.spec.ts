import { MbmChainReader, lastPerSession } from './mbm-chain-reader.service';

const key = (iso: string, expiry: string) => ({ capturedAt: new Date(iso), expiry });

describe('lastPerSession', () => {
  it('picks each IST session’s last capture at its nearest expiry, newest session first', () => {
    const keys = [
      key('2026-10-19T10:00:00Z', '2026-10-20'), // Mon 15:30 IST
      key('2026-10-19T10:00:00Z', '2026-10-27'),
      key('2026-10-19T09:45:00Z', '2026-10-20'),
      key('2026-10-16T10:00:00Z', '2026-10-20'), // Fri
      key('2026-10-16T04:00:00Z', '2026-10-20'),
      key('2026-10-15T10:00:00Z', '2026-10-20'), // Thu
    ];
    expect(lastPerSession(keys, 2)).toEqual([keys[0], keys[3]]);
    expect(lastPerSession(keys, 5)).toEqual([keys[0], keys[3], keys[5]]);
  });

  it('groups by the IST day, not the UTC day', () => {
    // 2026-10-19T19:00Z is already 2026-10-20 00:30 IST.
    const keys = [key('2026-10-19T19:00:00Z', '2026-10-27'), key('2026-10-19T10:00:00Z', '2026-10-27')];
    expect(lastPerSession(keys, 5)).toHaveLength(2);
  });
});

describe('MbmChainReader', () => {
  const now = () => new Date('2026-10-19T12:00:00Z');

  it('latestChain reads the newest capture of the normalised symbol', async () => {
    const repo = {
      captureKeys: jest.fn().mockResolvedValue([key('2026-10-19T10:00:00Z', '2026-10-27')]),
      snapshotsAt: jest.fn(async (_n: string, keys: unknown[]) => keys.map((k) => ({ ...(k as object), instrument: 'RELIANCE' }))),
    };
    const reader = new MbmChainReader(repo as never, now);
    const got = await reader.latestChain('reliance-eq');
    expect(got).toMatchObject({ instrument: 'RELIANCE', expiry: '2026-10-27' });
    expect(repo.captureKeys.mock.calls[0][0]).toBe('RELIANCE');
  });

  it('latestChain → null when nothing was captured; chainHistory(0) reads nothing', async () => {
    const repo = { captureKeys: jest.fn().mockResolvedValue([]), snapshotsAt: jest.fn().mockResolvedValue([]) };
    const reader = new MbmChainReader(repo as never, now);
    expect(await reader.latestChain('TCS')).toBeNull();
    expect(await reader.chainHistory('TCS', 0)).toEqual([]);
    expect(repo.captureKeys).toHaveBeenCalledTimes(1);
  });

  it('chainHistory asks for enough keys and returns one row per session', async () => {
    const keys = [key('2026-10-19T10:00:00Z', '2026-10-27'), key('2026-10-19T09:45:00Z', '2026-10-27'), key('2026-10-16T10:00:00Z', '2026-10-27')];
    const repo = { captureKeys: jest.fn().mockResolvedValue(keys), snapshotsAt: jest.fn(async (_n: string, ks: unknown[]) => ks) };
    const reader = new MbmChainReader(repo as never, now);
    expect(await reader.chainHistory('TCS', 5)).toEqual([keys[0], keys[2]]);
    expect(repo.captureKeys.mock.calls[0][2]).toBe(1000);
  });
});
