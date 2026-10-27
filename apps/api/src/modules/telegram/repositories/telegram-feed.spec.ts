import { TelegramRepository, toFeedItem, type FeedRow } from './telegram.repository';

const row = (over: Partial<FeedRow> = {}): FeedRow => ({
  id: 'm1',
  channel_id: 'ch1',
  channel: 'Stock Gainers (SEBI Registered)',
  posted_at: new Date('2026-10-26T11:07:00Z'),
  received_at: new Date('2026-10-26T11:07:58Z'),
  raw_text: 'PRIZOR VIZTECH 1064 to 1350 🔥',
  has_media: false,
  status: 'INFO',
  reason: 'info: entity, level',
  parser: null,
  tradingsymbol: null,
  side: null,
  entry_type: null,
  entry_low: null,
  entry_high: null,
  sl: null,
  targets: null,
  decision: null,
  skip_reason: null,
  mode: null,
  ...over,
});

describe('toFeedItem', () => {
  it('maps a non-call message with its class and reason, no call block', () => {
    expect(toFeedItem(row())).toEqual({
      id: 'm1',
      channelId: 'ch1',
      channel: 'Stock Gainers (SEBI Registered)',
      postedAt: '2026-10-26T11:07:00.000Z',
      receivedAt: '2026-10-26T11:07:58.000Z',
      lagSec: 58,
      text: 'PRIZOR VIZTECH 1064 to 1350 🔥',
      hasMedia: false,
      status: 'INFO',
      reason: 'info: entity, level',
      parser: null,
      call: null,
      watches: [],
    });
  });

  it('a message the classifier has not reached yet has status null', () => {
    expect(toFeedItem(row({ status: null, reason: null })).status).toBeNull();
  });

  it('a call carries its contract, levels and the trade decision', () => {
    const item = toFeedItem(
      row({
        status: 'SIGNAL',
        parser: 'rule',
        tradingsymbol: 'CRUDEOIL17NOV2610500CE',
        side: 'BUY',
        entry_type: 'AT',
        entry_low: 270,
        entry_high: 270,
        sl: null,
        targets: [300, 330, 380],
        decision: 'SKIP',
        skip_reason: 'risk_cap',
        mode: 'shadow',
      }),
    );
    expect(item.call).toEqual({
      tradingsymbol: 'CRUDEOIL17NOV2610500CE',
      side: 'BUY',
      entryType: 'AT',
      entryLow: 270,
      entryHigh: 270,
      sl: null,
      targets: [300, 330, 380],
      decision: 'SKIP',
      skipReason: 'risk_cap',
      mode: 'shadow',
    });
  });
});

describe('TelegramRepository.feed', () => {
  it('clamps the limit and maps every row', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([row(), row({ id: 'm2' })]) } as any;
    const repo = new TelegramRepository(prisma);
    const items = await repo.feed({ limit: 5000 });
    expect(items.map((i) => i.id)).toEqual(['m1', 'm2']);
    // Tagged-template call: [strings, ...values]; the clamped limit is the last value.
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toContain(300);
  });
});

describe('toFeedItem — watches', () => {
  it('carries the post\'s watched breakout levels; junk rows are dropped', () => {
    const item = toFeedItem({
      id: 'm1', channel_id: 'c1', channel: 'Stock Gainers', posted_at: new Date('2026-10-27T06:22:00Z'), received_at: new Date('2026-10-27T06:22:05Z'),
      raw_text: 'Radico breakout above 4330', has_media: false, status: 'INFO', reason: 'watch: breakout (1 name)', parser: 'rule',
      tradingsymbol: null, side: null, entry_type: null, entry_low: null, entry_high: null, sl: null, targets: null, decision: null, skip_reason: null, mode: null,
      watches: [{ underlying: 'RADICO', side: 'BUY', level: 4330, status: 'FIRED', lastLtp: 4336, decision: 'PAPER', skipReason: null }, { junk: true }],
    });
    expect(item.watches).toEqual([{ underlying: 'RADICO', side: 'BUY', level: 4330, status: 'FIRED', lastLtp: 4336, decision: 'PAPER', skipReason: null }]);
  });
});
