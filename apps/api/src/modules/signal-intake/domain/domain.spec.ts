import { dedupKey, planCluster, type ClusterRow, type RecentSignal } from './cluster';
import { earliestUsable, inferExpiry, monthlyRule, ruleExpiry } from './expiry';
import { evaluateSignalOutcome, outcomeCorrect, type OutcomeBar } from './outcome';
import { prefilter } from './prefilter';
import { detectUpdate } from './updates';
import { buildVocabulary } from './vocabulary';

const vocab = buildVocabulary(['RELIANCE-EQ', 'TATAMOTORS-EQ', 'SBIN-EQ', 'IDEA-EQ', 'RAIN-EQ', 'BSE-EQ']);

describe('pre-filter', () => {
  it.each([
    'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140/160/200',
    'RELIANCE cash buy 1250-1255 SL 1238 T1 1270 T2 1285',
    '24000 PE buy 120 sl 100',
    'Nifty buy on dips near 24000-24050 for 24200+',
  ])('passes a call: %s', (text) => {
    expect(prefilter(text, vocab)).toMatchObject({ pass: true, reason: 'ok' });
  });

  it.each<[string, string]>([
    ['Good morning traders 🙏 Have a great day', 'no-instrument'],
    ['Join our premium group for accurate calls! Fees 4999 only. Whatsapp 9876543210', 'no-instrument'],
    ['Market looks bullish, Nifty may test 24500 today', 'no-action'],
    ['NIFTY 24000 CE', 'no-action'],
    ['Buy NIFTY now', 'too-few-prices'],
    ['BUY our NIFTY option course at 999, 50% off, offer ends 31', 'ad'],
    ['Total profit 32000 today 🔥 NIFTY 24000 CE buy call gave 120 → 180', 'recap'],
    ["Today's PnL +25,400 💰 BANKNIFTY buy 140 → 210 BOOM", 'recap'],
    ['Happy Diwali to all members 🪔 Buy happiness, sell sorrow 🙂', 'no-instrument'],
    ['Rain expected today, buy umbrella 2 for 300', 'no-instrument'],
    ['', 'empty'],
  ])('blocks %s', (text, reason) => {
    const r = prefilter(text, vocab);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe(reason);
  });

  it('a phone number is not a price', () => {
    expect(prefilter('Buy NIFTY call 9876543210', vocab)).toMatchObject({ pass: false, reason: 'too-few-prices' });
  });
});

describe('update detector', () => {
  it.each<[string, string, number | null]>([
    ['SL hit ❌', 'SL_HIT', null],
    ['Stoploss hit, stay disciplined', 'SL_HIT', null],
    ['Target 1 done ✅✅ 140', 'TARGET_HIT', 1],
    ['T2 done 🎯🎯', 'TARGET_HIT', 2],
    ['2nd target achieved 🚀', 'TARGET_HIT', 2],
    ['Exit now', 'EXIT', null],
    ['trail SL to cost', 'TRAIL_SL', null],
    ['Book partial profit, trail SL to cost', 'PARTIAL_EXIT', null],
    ['Avoid the last call', 'CANCEL', null],
  ])('%s → %s', (text, kind, idx) => {
    const u = detectUpdate(text, vocab);
    expect(u).not.toBeNull();
    expect(u!.kind).toBe(kind);
    expect(u!.targetIndex).toBe(idx);
  });

  it('names the contract it refers to when written', () => {
    expect(detectUpdate('BANKNIFTY 52000 PE SL hit', vocab)).toMatchObject({ underlying: 'BANKNIFTY', strike: 52000, kind: 'SL_HIT' });
  });

  it('a P&L recap is not an update, nor is chatter', () => {
    expect(detectUpdate('Total profit 32000 today, all targets done', vocab)).toBeNull();
    expect(detectUpdate('Good morning', vocab)).toBeNull();
  });
});

describe('expiry inference', () => {
  // Thu 2026-10-22 11:00 IST
  const at = new Date('2026-10-22T05:30:00Z');

  it('nearest listed expiry from the master', () => {
    expect(inferExpiry('NIFTY', 'CE', null, at, ['2026-11-03', '2026-10-27', '2026-10-20'])).toEqual({ expiry: '2026-10-27', source: 'master' });
  });
  it('after 15:15 IST on expiry day the next one is meant', () => {
    const late = new Date('2026-10-27T10:00:00Z'); // 15:30 IST
    expect(earliestUsable(late)).toBe('2026-10-28');
    expect(inferExpiry('NIFTY', 'CE', null, late, ['2026-10-27', '2026-11-03'])).toEqual({ expiry: '2026-11-03', source: 'master' });
  });
  it('rule fallback: NIFTY weekly Tuesday, BANKNIFTY / stocks last Tuesday, SENSEX Thursday', () => {
    expect(ruleExpiry('NIFTY', 'CE', '2026-10-22')).toBe('2026-10-27');
    expect(ruleExpiry('BANKNIFTY', 'PE', '2026-10-22')).toBe('2026-10-27');
    expect(ruleExpiry('RELIANCE', 'FUT', '2026-10-28')).toBe('2026-11-24');
    expect(ruleExpiry('SENSEX', 'CE', '2026-10-23')).toBe('2026-10-29');
    expect(monthlyRule('NIFTY', 2026, 11)).toBe('2026-11-24');
    expect(ruleExpiry('CRUDEOIL', 'FUT', '2026-10-22')).toBeNull();
  });
  it('a month-only hint means that month’s last listed expiry', () => {
    expect(inferExpiry('SBIN', 'CE', { day: null, month: 11, year: null }, at, ['2026-10-27', '2026-11-24', '2026-12-29'])).toEqual({ expiry: '2026-11-24', source: 'message' });
  });
  it('a full date from the message is kept', () => {
    expect(inferExpiry('NIFTY', 'CE', { day: 28, month: 10, year: 2026 }, at, null)).toEqual({ expiry: '2026-10-28', source: 'message' });
  });
  it('cash has no expiry', () => {
    expect(inferExpiry('RELIANCE', 'EQ', null, at, null)).toEqual({ expiry: null, source: 'none' });
  });
});

describe('clustering', () => {
  const W = 30 * 60_000;
  const t0 = new Date('2026-10-23T04:00:00Z');
  const plus = (min: number) => new Date(t0.getTime() + min * 60_000);
  const cluster = (o: Partial<ClusterRow> = {}): ClusterRow => ({
    id: 'c1', underlying: 'NIFTY', direction: 'BULL', windowStart: t0, channelIds: ['A'], signalIds: ['s1'], agreeCount: 1, conflict: false, ...o,
  });

  it('first signal creates a cluster of one', () => {
    const p = planCluster({ id: 's1', channelId: 'A', underlying: 'NIFTY', direction: 'BULL', receivedAt: t0 }, [], [], W);
    expect(p).toMatchObject({ action: 'create', corroborated: false, cluster: { agreeCount: 1, conflict: false, channelIds: ['A'] } });
  });

  it('a second channel in the window corroborates (agreeCount 2, re-emit)', () => {
    const p = planCluster({ id: 's2', channelId: 'B', underlying: 'NIFTY', direction: 'BULL', receivedAt: plus(10) }, [cluster()], [], W);
    expect(p).toMatchObject({ action: 'join', corroborated: true, cluster: { id: 'c1', agreeCount: 2, channelIds: ['A', 'B'], signalIds: ['s1', 's2'] } });
  });

  it('the same channel again does not count twice', () => {
    const p = planCluster({ id: 's3', channelId: 'A', underlying: 'NIFTY', direction: 'BULL', receivedAt: plus(5) }, [cluster()], [], W);
    expect(p).toMatchObject({ action: 'join', corroborated: false, cluster: { agreeCount: 1 } });
  });

  it('outside the window opens a new cluster', () => {
    const p = planCluster({ id: 's4', channelId: 'B', underlying: 'NIFTY', direction: 'BULL', receivedAt: plus(31) }, [cluster()], [], W);
    expect(p.action).toBe('create');
  });

  it('an opposite call in the window is a conflict on both sides', () => {
    const recent: RecentSignal[] = [{ id: 's1', channelId: 'A', direction: 'BULL', receivedAt: t0, clusterId: 'c1' }];
    const p = planCluster({ id: 's5', channelId: 'B', underlying: 'NIFTY', direction: 'BEAR', receivedAt: plus(12) }, [], recent, W);
    expect(p).toMatchObject({ action: 'create', cluster: { conflict: true, direction: 'BEAR' }, conflictClusterIds: ['c1'] });
  });

  it('an opposite call older than the window is no conflict', () => {
    const recent: RecentSignal[] = [{ id: 's1', channelId: 'A', direction: 'BULL', receivedAt: t0, clusterId: 'c1' }];
    const p = planCluster({ id: 's6', channelId: 'B', underlying: 'NIFTY', direction: 'BEAR', receivedAt: plus(45) }, [], recent, W);
    expect(p.cluster.conflict).toBe(false);
  });

  it('dedup key: same idea, same channel → same key; another channel → different', () => {
    const base = { channelId: 'A', underlying: 'NIFTY', instrumentKind: 'CE', strike: 24000, side: 'BUY', entryLow: 120, entryHigh: 120 };
    expect(dedupKey(base)).toBe(dedupKey({ ...base }));
    expect(dedupKey(base)).not.toBe(dedupKey({ ...base, channelId: 'B' }));
  });
});

describe('outcome replay', () => {
  const bar = (min: number, low: number, high: number, close = (low + high) / 2): OutcomeBar => ({ ts: min * 60_000, low, high, close });
  const sig = { side: 'BUY' as const, entryType: 'ABOVE' as const, entryLow: 120, entryHigh: 120, sl: 100, targets: [140, 160] };

  it('target 1 before SL → right', () => {
    const o = evaluateSignalOutcome(sig, [bar(0, 110, 118), bar(5, 115, 125), bar(10, 124, 141)]);
    expect(o).toMatchObject({ status: 'TARGET1', entryAt: 5 * 60_000, exitAt: 10 * 60_000 });
    expect(outcomeCorrect(o.status)).toBe(true);
  });
  it('SL first → wrong; a bar touching both counts as SL', () => {
    expect(evaluateSignalOutcome(sig, [bar(0, 118, 122), bar(5, 99, 121)]).status).toBe('SL');
    expect(evaluateSignalOutcome(sig, [bar(0, 98, 142)]).status).toBe('SL');
    expect(outcomeCorrect('SL')).toBe(false);
  });
  it('never triggered / neither / no bars → null', () => {
    expect(evaluateSignalOutcome(sig, [bar(0, 100, 118)]).status).toBe('NOT_TRIGGERED');
    expect(evaluateSignalOutcome(sig, [bar(0, 115, 125), bar(5, 118, 130)]).status).toBe('NEITHER');
    expect(evaluateSignalOutcome(sig, []).status).toBe('NO_DATA');
    expect(outcomeCorrect('NEITHER')).toBeNull();
  });
  it('sell-side levels are mirrored', () => {
    const s = { side: 'SELL' as const, entryType: 'BELOW' as const, entryLow: 24050, entryHigh: 24050, sl: 24120, targets: [23950] };
    expect(evaluateSignalOutcome(s, [bar(0, 24060, 24100), bar(5, 24000, 24070), bar(10, 23940, 24010)]).status).toBe('TARGET1');
  });
});
