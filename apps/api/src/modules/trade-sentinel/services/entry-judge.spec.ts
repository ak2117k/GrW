import { entryRoom, oiQuality, parseEntryVerdict } from './entry-judge';
import { EntryJudgeService, parseEntryJudgeMode } from './entry-judge.service';

const reply = (o: unknown) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(o) }] });
const ok = { decision: 'WAIT', confidence: 'high', reason: 'Bouncing off the prior-day low; 3m higher lows against a PE.', checks: { topDown: 'a', room: 'b', oi: 'c', recentExit: 'd', newsEvents: 'e' } };

describe('entry judge — pure parts (F4)', () => {
  it('parses a verdict and refuses malformed replies', () => {
    expect(parseEntryVerdict(reply(ok)).decision).toBe('WAIT');
    expect(() => parseEntryVerdict(reply({ ...ok, decision: 'MAYBE' }))).toThrow(/decision/);
    expect(() => parseEntryVerdict({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] })).toThrow(/not JSON/);
    expect(() => parseEntryVerdict(reply({ ...ok, reason: '' }))).toThrow(/no reason/);
  });

  it('room for a PE: distance down to the prior-day low and the put wall, in daily ATR and N15 (the GOLD 16 Nov case)', () => {
    const r = entryRoom({
      direction: 'BEARISH',
      price: 134640,
      levels: { prevDayHigh: 136055, prevDayLow: 134385, todayHigh: 135050, todayLow: 134640, dailyAtr14: 1200 },
      n15: 140,
      oiRead: { support: [{ strike: 134000, oi: 60, trend: 'STEADY' }], resistance: [] },
    });
    expect(r.toPrevDay).toMatchObject({ level: 134385, points: 255, dailyAtr: 0.21, n15: 1.82 });
    expect(r.toOiWall).toMatchObject({ level: 134000, points: 640 });
  });

  it('room for a CE reads upwards and flags a level already crossed', () => {
    const r = entryRoom({ direction: 'BULLISH', price: 100, levels: { prevDayHigh: 98, prevDayLow: 90, todayHigh: 104, todayLow: 95, dailyAtr14: 4 }, n15: 1, oiRead: null });
    expect(r.toPrevDay).toMatchObject({ points: -2, crossed: true });
    expect(r.toTodayExtreme).toMatchObject({ points: 4, dailyAtr: 1 });
    expect(r.toOiWall).toBeNull();
  });

  it('OI quality: thin or changeless chains never count as data', () => {
    expect(oiQuality(null)).toBe('NO_DATA');
    expect(oiQuality({ totals: { callOi: 261, putOi: 554 }, changeBasis: 'baseline' })).toBe('THIN');
    expect(oiQuality({ totals: { callOi: 500000, putOi: 400000 }, changeBasis: 'none' })).toBe('THIN');
    expect(oiQuality({ totals: { callOi: 500000, putOi: 400000 }, changeBasis: 'baseline' })).toBe('OK');
  });

  it('mode parsing: on by default, observe, off', () => {
    expect(parseEntryJudgeMode(undefined)).toBe('on');
    expect(parseEntryJudgeMode('observe')).toBe('observe');
    expect(parseEntryJudgeMode('off')).toBe('off');
  });
});

describe('EntryJudgeService (F4)', () => {
  const make = (mode: string, transport: { messages: { create: jest.Mock } }) => {
    const config = { get: (k: string) => (k === 'ENTRY_AI_JUDGE' ? mode : undefined) };
    const prisma = { trade: { findMany: jest.fn().mockResolvedValue([]) }, tradeTracker: { findMany: jest.fn().mockResolvedValue([]) } };
    const cycle = { runShared: (_id: string, work: () => Promise<unknown>) => work() };
    const packets = { marketRead: jest.fn().mockResolvedValue({ news: null, events: null, oiRead: null, indicators: null }) };
    return new EntryJudgeService(config as never, prisma as never, cycle as never, packets as never, undefined, undefined, transport as never);
  };
  const cand = { source: 'ENTRY_ENGINE' as const, underlying: 'GOLD', optionExchange: 'MCX', direction: 'BEARISH' as const, price: 134720, why: ['news bearish'], userId: 'u1' };

  it('on: only ENTER opens; WAIT does not', async () => {
    const enter = make('on', { messages: { create: jest.fn().mockResolvedValue(reply({ ...ok, decision: 'ENTER' })) } });
    await expect(enter.judge(cand)).resolves.toMatchObject({ ok: true, open: true });
    const wait = make('on', { messages: { create: jest.fn().mockResolvedValue(reply(ok)) } });
    await expect(wait.judge(cand)).resolves.toMatchObject({ ok: true, open: false, note: expect.stringMatching(/^AI entry judge WAIT/) });
  });

  it('on: an unavailable judge fails CLOSED; observe opens as before', async () => {
    const broken = { messages: { create: jest.fn().mockRejectedValue(new Error('cli down')) } };
    await expect(make('on', broken).judge(cand)).resolves.toMatchObject({ ok: false, open: false });
    await expect(make('observe', broken).judge(cand)).resolves.toMatchObject({ ok: false, open: true });
  });

  it('the packet carries the room, OI quality and today\'s exits on the underlying', async () => {
    const svc = make('on', { messages: { create: jest.fn() } });
    const p = await svc.packetFor(cand, new Date('2026-11-16T10:05:00Z'));
    expect(Object.keys(p)).toEqual(['candidate', 'indicators', 'oi', 'room', 'news', 'events', 'recentExits', 'session']);
    expect(p.oi).toMatchObject({ quality: 'NO_DATA' });
  });
});
