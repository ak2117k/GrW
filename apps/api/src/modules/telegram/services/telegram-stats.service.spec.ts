import { TelegramStatsService } from './telegram-stats.service';

function make(minSample = 5) {
  const repo = {
    listChannels: jest.fn().mockResolvedValue([{ id: 'c1', title: 'Mr P' }]),
    statsByChannel: jest.fn().mockResolvedValue([
      { channelId: 'c1', status: 'TARGET_HIT', _count: { _all: 6 }, _avg: { resultPct: 7 } },
      { channelId: 'c1', status: 'SL_HIT', _count: { _all: 2 }, _avg: { resultPct: -3 } },
      { channelId: 'c1', status: 'EXPIRED', _count: { _all: 3 }, _avg: { resultPct: null } },
      { channelId: 'c1', status: 'UNTRACKABLE', _count: { _all: 4 }, _avg: { resultPct: null } },
    ]),
  } as any;
  const config = { get: jest.fn().mockReturnValue(minSample) } as any;
  return new TelegramStatsService(repo, config);
}

it('win rate excludes EXPIRED/UNTRACKABLE and honors the ratio', async () => {
  const s = await make().channelScorecards();
  expect(s[0].winRate).toBeCloseTo(6 / 8); // 0.75
  expect(s[0].expired).toBe(3);
  expect(s[0].untrackable).toBe(4);
});

it('winRate is null below the minimum sample size', async () => {
  const s = await make(20).channelScorecards();
  expect(s[0].winRate).toBeNull();
});
