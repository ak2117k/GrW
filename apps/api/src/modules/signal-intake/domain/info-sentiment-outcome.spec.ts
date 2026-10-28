import type { InfoItem } from './info';
import { infoOutcomeCorrect, judgeInfoItem, type DailyBar } from './info-outcome';
import { channelSentiment, channelWeight, infoList } from './sentiment';

const item = (o: Partial<InfoItem> = {}): InfoItem => ({
  underlying: 'NIFTY', bias: 'BEAR', levels: [22000], targetLevel: null, oi: null, condition: null, horizon: null, ...o,
});

/** 16 flat sessions (range 100 → ATR 100, band 30) then the move days. */
function bars(moves: Array<{ close: number; high?: number; low?: number }>): DailyBar[] {
  const out: DailyBar[] = [];
  const d0 = Date.parse('2026-09-01T00:00:00Z');
  for (let i = 0; i < 16; i++) out.push({ day: new Date(d0 + i * 86_400_000).toISOString().slice(0, 10), high: 22450, low: 22350, close: 22400 });
  moves.forEach((m, i) => out.push({ day: new Date(d0 + (16 + i) * 86_400_000).toISOString().slice(0, 10), high: m.high ?? Math.max(22400, m.close) + 20, low: m.low ?? Math.min(22400, m.close) - 20, close: m.close }));
  return out;
}
const POST = { day: '2026-09-17', afterClose: false }; // during the 17th session: base = the 16th close (22400)

describe('judgeInfoItem (CHANNEL_INFO)', () => {
  it('BEAR is right when the next close falls more than 0.3×ATR', () => {
    const o = judgeInfoItem(item(), bars([{ close: 22300 }]), POST);
    expect(o).toMatchObject({ status: 'RIGHT', session: '2026-09-17', baseClose: 22400, judgedClose: 22300, ret: -100, band: 30 });
    expect(infoOutcomeCorrect(o.status)).toBe(true);
  });

  it('BULL against the move is wrong; a move inside the band is FLAT (null)', () => {
    expect(judgeInfoItem(item({ bias: 'BULL' }), bars([{ close: 22300 }]), POST).status).toBe('WRONG');
    const flat = judgeInfoItem(item({ bias: 'BULL' }), bars([{ close: 22420 }]), POST);
    expect(flat.status).toBe('FLAT');
    expect(infoOutcomeCorrect(flat.status)).toBeNull();
  });

  it('a post after the close is judged on the NEXT session', () => {
    const o = judgeInfoItem(item(), bars([{ close: 22500 }, { close: 22100 }]), { day: '2026-09-17', afterClose: true });
    expect(o).toMatchObject({ status: 'RIGHT', session: '2026-09-18', baseClose: 22500 });
  });

  it('WEEKS = 5 sessions with a √5 band; MONTHS is recorded, not judged; a session not yet closed is PENDING', () => {
    const five = bars([{ close: 22390 }, { close: 22380 }, { close: 22350 }, { close: 22320 }, { close: 22250 }]);
    expect(judgeInfoItem(item({ horizon: 'WEEKS' }), five, POST)).toMatchObject({ status: 'RIGHT', session: '2026-09-21', band: 67.08 });
    expect(judgeInfoItem(item({ horizon: 'MONTHS' }), five, POST)).toMatchObject({ status: 'NOT_JUDGED_MONTHS', session: '2026-09-17' });
    expect(judgeInfoItem(item({ horizon: 'WEEKS' }), bars([{ close: 22300 }]), POST).status).toBe('PENDING');
    expect(judgeInfoItem(item(), bars([]), POST).status).toBe('PENDING');
  });

  it('DAYS = 3 sessions with a √3 band, not the next close (2026-10-28: "BEAR BANKNIFTY (DAYS)" was judged on one session)', () => {
    const three = bars([{ close: 22390 }, { close: 22420 }, { close: 22300 }]);
    expect(judgeInfoItem(item({ horizon: 'DAYS' }), three, POST)).toMatchObject({ status: 'RIGHT', session: '2026-09-19', ret: -100, band: 51.96 });
    expect(judgeInfoItem(item(), three, POST)).toMatchObject({ status: 'FLAT', session: '2026-09-17' }); // no horizon: next session
    expect(judgeInfoItem(item({ horizon: 'DAYS' }), bars([{ close: 22300 }]), POST).status).toBe('PENDING');
  });

  it('levelHit is separate from the verdict; NEUTRAL items get NO_BIAS with the level flag; no bars → NO_DATA', () => {
    expect(judgeInfoItem(item({ levels: [22000] }), bars([{ close: 22300, low: 22250 }]), POST)).toMatchObject({ status: 'RIGHT', levelHit: false });
    expect(judgeInfoItem(item({ levels: [22000] }), bars([{ close: 22300, low: 21990 }]), POST)).toMatchObject({ levelHit: true });
    expect(judgeInfoItem(item({ bias: 'NEUTRAL', levels: [], targetLevel: 22300 }), bars([{ close: 22300 }]), POST)).toMatchObject({ status: 'NO_BIAS', levelHit: true });
    expect(judgeInfoItem(item(), [], POST).status).toBe('NO_DATA');
  });
});

describe('channelSentiment', () => {
  const at = new Date('2026-10-24T05:00:00Z');
  const rows = [
    { channelId: 'good', postedAt: at, items: [item({ bias: 'BEAR' }), item({ underlying: 'CRUDEOIL', bias: 'BULL', levels: [110, 120] })] },
    { channelId: 'bad', postedAt: new Date(at.getTime() + 60_000), items: [item({ bias: 'BULL' })] },
    { channelId: 'new', postedAt: at, items: [item({ bias: 'NEUTRAL' }), { junk: true }] },
  ];
  const acc = {
    good: { infoRolling20: 0.8, infoRolling20Right: 8, infoRolling20Wrong: 2 },
    bad: { infoRolling20: 0.2, infoRolling20Right: 2, infoRolling20Wrong: 8 },
    new: { infoRolling20: 1, infoRolling20Right: 2, infoRolling20Wrong: 0 }, // too few judged → neutral weight
  };

  it('counts BULL / BEAR / NEUTRAL per underlying, weighted by each channel’s INFO accuracy', () => {
    const s = channelSentiment(rows, acc);
    expect(s.map((x) => x.underlying)).toEqual(['NIFTY', 'CRUDEOIL']);
    expect(s[0]).toMatchObject({ items: 3, bull: 1, bear: 1, neutral: 1, weightedBull: 0.2, weightedBear: 0.8, net: -0.6, lean: 'BEAR', channels: 3, latestAt: '2026-10-24T05:01:00.000Z' });
    expect(s[1]).toMatchObject({ items: 1, bull: 1, bear: 0, weightedBull: 0.8, net: 1, lean: 'BULL', channels: 1 });
  });

  it('without accuracy every channel weighs 0.5: an even split is MIXED; neutral-only is NONE', () => {
    const s = channelSentiment(rows, null);
    expect(s[0]).toMatchObject({ weightedBull: 0.5, weightedBear: 0.5, net: 0, lean: 'MIXED' });
    expect(channelSentiment([{ channelId: 'x', postedAt: at, items: [item({ bias: 'NEUTRAL' })] }], null)[0]).toMatchObject({ net: null, lean: 'NONE' });
    expect(channelWeight(acc.new)).toBe(0.5);
    expect(channelWeight(acc.good)).toBe(0.8);
  });

  it('infoList: newest first, channel title, capped', () => {
    const list = infoList([{ ...rows[0], channelTitle: 'Stock Wale Bhaiyaa Learning Group' }, rows[1]], 2);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ channel: 'bad', underlying: 'NIFTY', bias: 'BULL' });
    expect(list[1]).toMatchObject({ channel: 'Stock Wale Bhaiyaa Learning Group', underlying: 'NIFTY', bias: 'BEAR', levels: [22000] });
  });
});
